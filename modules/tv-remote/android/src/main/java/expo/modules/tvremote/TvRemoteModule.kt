package expo.modules.tvremote

import android.content.Context
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLException
import kotlin.concurrent.thread

/**
 * Native side of the TV remote: only what JavaScript can't do by itself.
 * - this phone's certificate (created once),
 * - byte streams to the TV: plain TCP, TLS, or TLS presenting that certificate,
 * - finding TVs on the Wi-Fi (mDNS, SSDP, port probe) and the phone's own address,
 * - secure random bytes and a tiny key/value store for settings.
 * The protocols themselves (HTTP, WebSocket, MQTT and each brand) live in TypeScript.
 */
class TvRemoteModule : Module() {
  private val connections = ConcurrentHashMap<Int, SocketConnection>()
  private val nextId = AtomicInteger(1)

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val prefs
    get() = context.getSharedPreferences("tele-teclado", Context.MODE_PRIVATE)

  override fun definition() = ModuleDefinition {
    Name("TvRemote")

    Events("onData", "onClose")

    AsyncFunction("getClientKey") { promise: Promise ->
      thread(name = "tv-remote-identity") {
        try {
          val key = ClientIdentity.load(context).publicKey
          promise.resolve(mapOf("modulus" to key.modulus.toString(16), "exponent" to key.publicExponent.toString(16)))
        } catch (e: Exception) {
          promise.reject("ERR_IDENTITY", e.message ?: "identity", e)
        }
      }
    }

    AsyncFunction("resetClientKey") { promise: Promise ->
      thread(name = "tv-remote-identity") {
        ClientIdentity.reset(context)
        promise.resolve(null)
      }
    }

    AsyncFunction("connect") { host: String, port: Int, timeoutMs: Int, mode: String, promise: Promise ->
      thread(name = "tv-remote-connect") {
        try {
          val id = nextId.getAndIncrement()
          val connection = SocketConnection.open(
            host, port, timeoutMs, mode, { ClientIdentity.load(context) },
            onData = { bytes ->
              sendEvent("onData", mapOf("id" to id, "data" to Base64.encodeToString(bytes, Base64.NO_WRAP)))
            },
            onClose = { error ->
              connections.remove(id)
              sendEvent("onClose", if (error != null) mapOf("id" to id, "error" to error) else mapOf("id" to id))
            },
          )
          connections[id] = connection
          val key = connection.serverKey
          promise.resolve(
            mapOf(
              "id" to id,
              "serverModulus" to (key?.modulus?.toString(16) ?: ""),
              "serverExponent" to (key?.publicExponent?.toString(16) ?: ""),
            ),
          )
          connection.startReading()
        } catch (e: SSLException) {
          promise.reject("ERR_TLS", e.message ?: "TLS error", e)
        } catch (e: IOException) {
          promise.reject("ERR_NETWORK", e.message ?: "network error", e)
        } catch (e: Exception) {
          promise.reject("ERR_CONNECT", e.message ?: "connect error", e)
        }
      }
    }

    // Synchronous so writes keep the order JavaScript sent them in.
    Function("write") { id: Int, base64: String ->
      val connection = connections[id]
      if (connection != null) connection.write(Base64.decode(base64, Base64.NO_WRAP))
      connection != null
    }

    Function("close") { id: Int ->
      connections.remove(id)?.close()
      Unit
    }

    AsyncFunction("browse") { types: List<String>, timeoutMs: Int, promise: Promise ->
      MdnsBrowser.browse(context, types, timeoutMs) { found -> promise.resolve(found) }
    }

    AsyncFunction("ssdp") { targets: List<String>, hosts: List<String>, timeoutMs: Int, promise: Promise ->
      thread(name = "tv-remote-ssdp") {
        try {
          promise.resolve(LanTools.ssdp(context, targets, hosts, timeoutMs))
        } catch (e: Exception) {
          // Always settle the promise (a failure here is rare and local, not the TV): JS turns a
          // rejection into an empty result. Without this an exception would hang discovery and
          // crash uncaught on this background thread.
          promise.reject("ERR_SSDP", e.message ?: "ssdp error", e)
        }
      }
    }

    AsyncFunction("probe") { hosts: List<String>, ports: List<Int>, timeoutMs: Int, concurrency: Int, promise: Promise ->
      thread(name = "tv-remote-probe") {
        try {
          promise.resolve(LanTools.probe(hosts, ports, timeoutMs, concurrency))
        } catch (e: Exception) {
          promise.reject("ERR_PROBE", e.message ?: "probe error", e)
        }
      }
    }

    AsyncFunction("networkInfo") { promise: Promise ->
      promise.resolve(LanTools.networkInfo(context))
    }

    Function("randomBytes") { count: Int ->
      val bytes = ByteArray(count.coerceIn(0, 4096))
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    Function("getSetting") { key: String ->
      prefs.getString(key, null)
    }

    Function("setSetting") { key: String, value: String? ->
      prefs.edit().apply {
        if (value == null) remove(key) else putString(key, value)
      }.apply()
      Unit
    }

    OnDestroy {
      connections.values.forEach { it.close() }
      connections.clear()
    }
  }
}

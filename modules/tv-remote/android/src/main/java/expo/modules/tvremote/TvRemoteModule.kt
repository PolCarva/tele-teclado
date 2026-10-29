package expo.modules.tvremote

import android.content.Context
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLException
import kotlin.concurrent.thread

/**
 * Native side of the TV remote: only what JavaScript can't do by itself.
 * - this phone's certificate (created once),
 * - TLS sockets that present that certificate,
 * - finding the TV on the Wi-Fi,
 * - a tiny key/value store for settings.
 * The protocol itself lives in TypeScript (src/protocol).
 */
class TvRemoteModule : Module() {
  private val connections = ConcurrentHashMap<Int, TlsConnection>()
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

    AsyncFunction("connect") { host: String, port: Int, timeoutMs: Int, promise: Promise ->
      thread(name = "tv-remote-connect") {
        try {
          val identity = ClientIdentity.load(context)
          val id = nextId.getAndIncrement()
          val connection = TlsConnection.open(
            host, port, timeoutMs, identity,
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

    AsyncFunction("discover") { timeoutMs: Int, promise: Promise ->
      TvDiscovery.find(context, timeoutMs) { found -> promise.resolve(found) }
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

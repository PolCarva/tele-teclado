package expo.modules.tvremote

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Finds Android TVs / Google TVs on the Wi-Fi via mDNS (service _androidtvremote2._tcp),
 * with the name each TV announces (e.g. "serri tv") and its IPv4 address.
 */
object TvDiscovery {
  private const val SERVICE_TYPE = "_androidtvremote2._tcp"

  fun find(context: Context, timeoutMs: Int, done: (List<Map<String, Any>>) -> Unit) {
    val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    // Everything below runs on the main thread (NSD callbacks are posted here), so no locking.
    val handler = Handler(Looper.getMainLooper())
    val found = LinkedHashMap<String, Map<String, Any>>()
    val toResolve = ArrayDeque<NsdServiceInfo>()
    val seen = HashSet<String>()
    var resolving = false
    val finished = AtomicBoolean(false)
    lateinit var listener: NsdManager.DiscoveryListener

    fun finish() {
      if (!finished.compareAndSet(false, true)) return
      try {
        nsd.stopServiceDiscovery(listener)
      } catch (_: Exception) {
      }
      done(found.values.toList())
    }

    // NsdManager resolves one service at a time on older Android versions.
    fun resolveNext() {
      if (resolving || finished.get()) return
      val next = toResolve.removeFirstOrNull() ?: return
      resolving = true
      @Suppress("DEPRECATION")
      nsd.resolveService(next, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
          handler.post {
            resolving = false
            resolveNext()
          }
        }

        override fun onServiceResolved(info: NsdServiceInfo) {
          handler.post {
            val addresses: List<InetAddress> = if (Build.VERSION.SDK_INT >= 34) {
              info.hostAddresses
            } else {
              @Suppress("DEPRECATION")
              listOfNotNull(info.host)
            }
            // Prefer IPv4: it's what the TV answers on and what the settings show.
            val address = addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull()
            val host = address?.hostAddress
            if (host != null) found[host] = mapOf("name" to info.serviceName, "host" to host)
            resolving = false
            resolveNext()
          }
        }
      })
    }

    listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        handler.post { finish() }
      }

      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        handler.post {
          if (seen.add(serviceInfo.serviceName)) {
            toResolve.addLast(serviceInfo)
            resolveNext()
          }
        }
      }
    }

    try {
      nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (e: Exception) {
      if (finished.compareAndSet(false, true)) done(emptyList())
      return
    }
    handler.postDelayed({ finish() }, timeoutMs.toLong())
  }
}

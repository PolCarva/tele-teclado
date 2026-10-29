package expo.modules.tvremote

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Finds services on the Wi-Fi via mDNS / DNS-SD (e.g. _androidtvremote2._tcp, _airplay._tcp),
 * with the name each one announces, its IPv4 address, port and TXT record.
 */
object MdnsBrowser {
  fun browse(context: Context, types: List<String>, timeoutMs: Int, done: (List<Map<String, Any>>) -> Unit) {
    val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    val multicastLock = try {
      (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
        ?.createMulticastLock("tele-teclado-mdns")?.apply {
          setReferenceCounted(false)
          acquire()
        }
    } catch (_: Exception) {
      null
    }
    // Everything below runs on the main thread (NSD callbacks are posted here), so no locking.
    val handler = Handler(Looper.getMainLooper())
    val found = LinkedHashMap<String, Map<String, Any>>()
    val toResolve = ArrayDeque<Pair<String, NsdServiceInfo>>()
    val seen = HashSet<String>()
    var resolving = false
    val finished = AtomicBoolean(false)
    val listeners = mutableListOf<NsdManager.DiscoveryListener>()

    fun finish() {
      if (!finished.compareAndSet(false, true)) return
      for (listener in listeners) {
        try {
          nsd.stopServiceDiscovery(listener)
        } catch (_: Exception) {
        }
      }
      try {
        multicastLock?.release()
      } catch (_: Exception) {
      }
      done(found.values.toList())
    }

    // NsdManager resolves one service at a time on older Android versions.
    fun resolveNext() {
      if (resolving || finished.get()) return
      val (type, next) = toResolve.removeFirstOrNull() ?: return
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
            // Prefer IPv4: it's what TVs answer on and what their settings show.
            val address = addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull()
            val host = address?.hostAddress
            if (host != null) {
              val txt = HashMap<String, String>()
              try {
                for ((key, value) in info.attributes) txt[key] = value?.toString(Charsets.UTF_8) ?: ""
              } catch (_: Exception) {
              }
              found["$type|${info.serviceName}"] = mapOf(
                "type" to type,
                "name" to info.serviceName,
                "host" to host,
                "port" to info.port,
                "txt" to txt,
              )
            }
            resolving = false
            resolveNext()
          }
        }
      })
    }

    for (type in types.distinct()) {
      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
          handler.post {
            if (seen.add("$type|${serviceInfo.serviceName}")) {
              toResolve.addLast(type to serviceInfo)
              resolveNext()
            }
          }
        }
      }
      try {
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
        listeners.add(listener)
      } catch (_: Exception) {
      }
    }
    if (listeners.isEmpty()) {
      if (finished.compareAndSet(false, true)) done(emptyList())
      return
    }
    handler.postDelayed({ finish() }, timeoutMs.toLong())
  }
}

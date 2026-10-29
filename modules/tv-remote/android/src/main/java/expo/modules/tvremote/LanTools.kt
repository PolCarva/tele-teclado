package expo.modules.tvremote

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Local-network helpers for finding TVs that don't announce themselves over mDNS. */
object LanTools {
  /**
   * SSDP: sends M-SEARCH for each search target to the multicast group (and, if given, straight
   * to each host), and collects the replies. Returns the raw reply text with the sender's address.
   */
  fun ssdp(context: Context, targets: List<String>, hosts: List<String>, timeoutMs: Int): List<Map<String, String>> {
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val lock = try {
      wifi?.createMulticastLock("tele-teclado-ssdp")?.apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (_: Exception) {
      null
    }
    val results = ArrayList<Map<String, String>>()
    val seen = HashSet<String>()
    val socket = DatagramSocket(null)
    try {
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(0))
      socket.soTimeout = 150
      val group = InetAddress.getByName("239.255.255.250")
      fun sendAll() {
        for (st in targets) {
          val multicast = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: $st\r\n\r\n"
          val bytes = multicast.toByteArray(Charsets.UTF_8)
          try {
            socket.send(DatagramPacket(bytes, bytes.size, group, 1900))
          } catch (_: Exception) {
          }
          for (host in hosts) {
            val unicast = "M-SEARCH * HTTP/1.1\r\nHOST: $host:1900\r\nMAN: \"ssdp:discover\"\r\nST: $st\r\n\r\n"
            val data = unicast.toByteArray(Charsets.UTF_8)
            try {
              socket.send(DatagramPacket(data, data.size, InetAddress.getByName(host), 1900))
            } catch (_: Exception) {
            }
          }
        }
      }
      val start = System.currentTimeMillis()
      val deadline = start + timeoutMs
      var resent = false
      sendAll()
      val buffer = ByteArray(8192)
      while (System.currentTimeMillis() < deadline) {
        if (!resent && System.currentTimeMillis() - start > 700) {
          // UDP gets lost: ask a second time.
          resent = true
          sendAll()
        }
        try {
          val packet = DatagramPacket(buffer, buffer.size)
          socket.receive(packet)
          val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
          val host = packet.address?.hostAddress ?: continue
          if (seen.add("$host\n$text")) results.add(mapOf("host" to host, "response" to text))
        } catch (_: SocketTimeoutException) {
        }
      }
    } catch (_: Exception) {
    } finally {
      socket.close()
      try {
        lock?.release()
      } catch (_: Exception) {
      }
    }
    return results
  }

  /** Which host:port pairs accept a TCP connection within the timeout. */
  fun probe(hosts: List<String>, ports: List<Int>, timeoutMs: Int, concurrency: Int): List<Map<String, Any>> {
    val pool = Executors.newFixedThreadPool(concurrency.coerceIn(1, 128))
    val open = ConcurrentLinkedQueue<Map<String, Any>>()
    try {
      for (host in hosts) {
        for (port in ports) {
          pool.execute {
            try {
              Socket().use {
                it.connect(InetSocketAddress(host, port), timeoutMs)
                open.add(mapOf("host" to host, "port" to port))
              }
            } catch (_: Exception) {
            }
          }
        }
      }
    } finally {
      pool.shutdown()
      pool.awaitTermination((timeoutMs.toLong() + 1000) * (hosts.size * ports.size / concurrency.coerceAtLeast(1) + 2), TimeUnit.MILLISECONDS)
    }
    return open.toList()
  }

  /** This phone's IPv4 address and prefix length on the Wi-Fi (or Ethernet), or null. */
  fun networkInfo(context: Context): Map<String, Any>? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    @Suppress("DEPRECATION")
    val networks = listOfNotNull(cm.activeNetwork) + cm.allNetworks.toList()
    var fallback: Map<String, Any>? = null
    for (network in networks.distinct()) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      val props = cm.getLinkProperties(network) ?: continue
      val link = props.linkAddresses.firstOrNull { it.address is Inet4Address && !it.address.isLoopbackAddress } ?: continue
      val info = mapOf("ip" to (link.address.hostAddress ?: continue), "prefixLength" to link.prefixLength)
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return info
      if (fallback == null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) fallback = info
    }
    return fallback
  }
}

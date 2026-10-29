package expo.modules.tvremote

import android.annotation.SuppressLint
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * One byte stream to a TV: plain TCP, TLS, or TLS that presents this phone's certificate
 * (Android TV remote). TVs use self-signed certificates, so the server certificate is not checked.
 * Reads on its own thread and writes in order on a single-thread executor.
 */
class SocketConnection private constructor(
  private val socket: Socket,
  private val onData: (ByteArray) -> Unit,
  private val onClose: (String?) -> Unit,
) {
  private val writer = Executors.newSingleThreadExecutor()
  private val closed = AtomicBoolean(false)

  /** The TV's certificate key (TLS only). Android TV pairing mixes it into the secret. */
  val serverKey: RSAPublicKey? = try {
    ((socket as? SSLSocket)?.session?.peerCertificates?.firstOrNull() as? X509Certificate)?.publicKey as? RSAPublicKey
  } catch (_: Exception) {
    null
  }

  fun startReading() {
    thread(name = "tv-socket-read", isDaemon = true) {
      val buffer = ByteArray(16 * 1024)
      var error: String? = null
      try {
        val input = socket.inputStream
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          if (n > 0) onData(buffer.copyOf(n))
        }
      } catch (e: Exception) {
        error = e.message ?: e.javaClass.simpleName
      }
      finish(error)
    }
  }

  fun write(bytes: ByteArray) {
    if (closed.get()) return
    writer.execute {
      try {
        socket.outputStream.apply {
          write(bytes)
          flush()
        }
      } catch (e: Exception) {
        finish(e.message ?: "write failed")
      }
    }
  }

  fun close() = finish(null)

  private fun finish(error: String?) {
    if (!closed.compareAndSet(false, true)) return
    try {
      socket.close()
    } catch (_: Exception) {
    }
    writer.shutdown()
    onClose(error)
  }

  companion object {
    /** mode: "tcp", "tls" or "tls-client-cert". */
    fun open(
      host: String,
      port: Int,
      timeoutMs: Int,
      mode: String,
      identity: () -> ClientIdentity,
      onData: (ByteArray) -> Unit,
      onClose: (String?) -> Unit,
    ): SocketConnection {
      val raw = Socket()
      try {
        raw.connect(InetSocketAddress(host, port), timeoutMs)
        raw.tcpNoDelay = true
        if (mode == "tcp") return SocketConnection(raw, onData, onClose)
        val context = SSLContext.getInstance("TLS")
        val keyManagers = if (mode == "tls-client-cert") arrayOf(identity().keyManager()) else null
        context.init(keyManagers, arrayOf(AcceptTvCertificate), SecureRandom())
        val socket = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
        // Older TVs only speak older TLS versions: offer everything this phone supports.
        try {
          socket.enabledProtocols = socket.supportedProtocols.filter { it.startsWith("TLS") }.toTypedArray()
        } catch (_: Exception) {
        }
        socket.soTimeout = timeoutMs
        socket.startHandshake()
        socket.soTimeout = 0
        return SocketConnection(socket, onData, onClose)
      } catch (e: Exception) {
        try {
          raw.close()
        } catch (_: Exception) {
        }
        throw e
      }
    }
  }
}

/**
 * TVs use self-signed certificates, so there is no CA to check against.
 * Each protocol ties the TV to this phone its own way (code on screen, token, PIN).
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
private object AcceptTvCertificate : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

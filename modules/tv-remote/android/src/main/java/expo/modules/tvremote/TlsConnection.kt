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
 * One TLS connection to the TV, authenticated with this phone's certificate.
 * Reads on its own thread and writes in order on a single-thread executor.
 */
class TlsConnection private constructor(
  private val socket: SSLSocket,
  private val onData: (ByteArray) -> Unit,
  private val onClose: (String?) -> Unit,
) {
  private val writer = Executors.newSingleThreadExecutor()
  private val closed = AtomicBoolean(false)

  /** The TV's certificate key. Pairing mixes it into the secret. */
  val serverKey: RSAPublicKey? =
    (socket.session.peerCertificates.firstOrNull() as? X509Certificate)?.publicKey as? RSAPublicKey

  fun startReading() {
    thread(name = "tv-remote-read", isDaemon = true) {
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
    fun open(
      host: String,
      port: Int,
      timeoutMs: Int,
      identity: ClientIdentity,
      onData: (ByteArray) -> Unit,
      onClose: (String?) -> Unit,
    ): TlsConnection {
      val context = SSLContext.getInstance("TLS")
      context.init(arrayOf(identity.keyManager()), arrayOf(AcceptTvCertificate), SecureRandom())
      val raw = Socket()
      try {
        raw.connect(InetSocketAddress(host, port), timeoutMs)
        raw.tcpNoDelay = true
        val socket = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
        socket.soTimeout = timeoutMs
        socket.startHandshake()
        socket.soTimeout = 0
        return TlsConnection(socket, onData, onClose)
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
 * The TV uses a self-signed certificate, so there is no CA to check against.
 * Pairing already ties the TV's key to the code shown on its screen.
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
private object AcceptTvCertificate : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

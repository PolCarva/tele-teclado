package expo.modules.tvremote

import android.content.Context
import java.io.ByteArrayInputStream
import java.io.File
import java.math.BigInteger
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Principal
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/**
 * This phone's identity for the TV: an RSA key and a self-signed certificate.
 * Created on first use and kept in the app's private storage. The TV remembers
 * this certificate after pairing, so losing it means pairing again.
 */
class ClientIdentity private constructor(
  val privateKey: PrivateKey,
  val certificate: X509Certificate,
) {
  val publicKey: RSAPublicKey
    get() = certificate.publicKey as RSAPublicKey

  /** Always offers our certificate, whatever CA names the TV asks for. */
  fun keyManager(): X509ExtendedKeyManager = object : X509ExtendedKeyManager() {
    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
    override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS
    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
    override fun getCertificateChain(alias: String?) = arrayOf(certificate)
    override fun getPrivateKey(alias: String?) = privateKey
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
  }

  companion object {
    private const val ALIAS = "tele-teclado"
    private const val DIR = "tv-remote"
    private const val KEY_FILE = "client.key"
    private const val CERT_FILE = "client.crt"

    @Volatile private var cached: ClientIdentity? = null

    @Synchronized
    fun load(context: Context): ClientIdentity {
      cached?.let { return it }
      val dir = File(context.filesDir, DIR).apply { mkdirs() }
      val keyFile = File(dir, KEY_FILE)
      val certFile = File(dir, CERT_FILE)
      val identity = readFrom(keyFile, certFile) ?: create().also {
        keyFile.writeBytes(it.privateKey.encoded)
        certFile.writeBytes(it.certificate.encoded)
      }
      cached = identity
      return identity
    }

    @Synchronized
    fun reset(context: Context) {
      cached = null
      File(context.filesDir, DIR).deleteRecursively()
    }

    private fun readFrom(keyFile: File, certFile: File): ClientIdentity? {
      if (!keyFile.exists() || !certFile.exists()) return null
      return try {
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyFile.readBytes()))
        ClientIdentity(key, parseCertificate(certFile.readBytes()))
      } catch (e: Exception) {
        null
      }
    }

    private fun create(): ClientIdentity {
      val generator = KeyPairGenerator.getInstance("RSA")
      generator.initialize(2048)
      val keyPair = generator.generateKeyPair()
      return ClientIdentity(keyPair.private, parseCertificate(selfSignedCertificate(keyPair, "Teclado TV")))
    }

    private fun parseCertificate(der: ByteArray): X509Certificate =
      CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    // ---- Minimal X.509 v3 self-signed certificate (DER), signed with SHA256withRSA ----

    private val SHA256_WITH_RSA = byteArrayOf(0x06, 0x09, 0x2A, 0x86.toByte(), 0x48, 0x86.toByte(), 0xF7.toByte(), 0x0D, 0x01, 0x01, 0x0B)
    private val COMMON_NAME = byteArrayOf(0x06, 0x03, 0x55, 0x04, 0x03)

    private fun selfSignedCertificate(keyPair: KeyPair, commonName: String): ByteArray {
      val algorithm = seq(SHA256_WITH_RSA, byteArrayOf(0x05, 0x00))
      val name = seq(set(seq(COMMON_NAME, tlv(0x0C, commonName.toByteArray(Charsets.UTF_8)))))
      val now = System.currentTimeMillis()
      val validity = seq(
        utcTime(Date(now - 24L * 3600 * 1000)),
        utcTime(Date(now + 20L * 365 * 24 * 3600 * 1000)),
      )
      val tbs = seq(
        tlv(0xA0, tlv(0x02, byteArrayOf(0x02))), // version v3
        tlv(0x02, BigInteger.valueOf(now).toByteArray()), // serial
        algorithm,
        name, // issuer
        validity,
        name, // subject
        keyPair.public.encoded, // SubjectPublicKeyInfo (already DER)
      )
      val signature = Signature.getInstance("SHA256withRSA").run {
        initSign(keyPair.private)
        update(tbs)
        sign()
      }
      return seq(tbs, algorithm, tlv(0x03, byteArrayOf(0x00) + signature))
    }

    private fun utcTime(date: Date): ByteArray {
      val format = SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
      return tlv(0x17, format.format(date).toByteArray(Charsets.US_ASCII))
    }

    private fun seq(vararg parts: ByteArray) = tlv(0x30, parts.fold(ByteArray(0)) { acc, p -> acc + p })
    private fun set(vararg parts: ByteArray) = tlv(0x31, parts.fold(ByteArray(0)) { acc, p -> acc + p })

    private fun tlv(tag: Int, content: ByteArray): ByteArray {
      val length = content.size
      val lengthBytes = when {
        length < 0x80 -> byteArrayOf(length.toByte())
        length < 0x100 -> byteArrayOf(0x81.toByte(), length.toByte())
        length < 0x10000 -> byteArrayOf(0x82.toByte(), (length shr 8).toByte(), length.toByte())
        else -> byteArrayOf(0x83.toByte(), (length shr 16).toByte(), (length shr 8).toByte(), length.toByte())
      }
      return byteArrayOf(tag.toByte()) + lengthBytes + content
    }
  }
}

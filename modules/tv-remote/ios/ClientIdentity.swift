import Foundation
import Security

/// RSA public key as raw big-endian modulus and exponent.
struct RSAPublicKey {
  let modulus: Data
  let exponent: Data

  var modulusHex: String { modulus.map { String(format: "%02x", $0) }.joined() }
  var exponentHex: String { exponent.map { String(format: "%02x", $0) }.joined() }

  static let empty = RSAPublicKey(modulus: Data(), exponent: Data())

  /// Parses PKCS#1 RSAPublicKey: SEQUENCE { INTEGER modulus, INTEGER exponent }.
  init?(pkcs1 der: Data) {
    var reader = DERReader(Array(der))
    guard let sequence = reader.read(tag: 0x30) else { return nil }
    var inner = DERReader(sequence)
    guard let modulus = inner.read(tag: 0x02), let exponent = inner.read(tag: 0x02) else { return nil }
    self.modulus = Data(modulus.drop { $0 == 0 })
    self.exponent = Data(exponent.drop { $0 == 0 })
  }

  init(modulus: Data, exponent: Data) {
    self.modulus = modulus
    self.exponent = exponent
  }

  init?(key: SecKey) {
    guard let data = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }
    self.init(pkcs1: data)
  }
}

enum IdentityError: Error, CustomStringConvertible {
  case keychain(String, OSStatus)
  case crypto(String)

  var description: String {
    switch self {
    case let .keychain(what, status): return "\(what) (keychain \(status))"
    case let .crypto(what): return what
    }
  }
}

/// This phone's identity for the TV: an RSA key and a self-signed certificate, kept in the
/// Keychain. The TV remembers the certificate after pairing, so losing it means pairing again.
final class ClientIdentity {
  private static let keyTag = Data("tele-teclado.client-key".utf8)
  private static let certLabel = "tele-teclado.client-cert"
  private static let lock = NSLock()
  private static var cached: ClientIdentity?

  let identity: SecIdentity
  let publicKey: RSAPublicKey

  private init(identity: SecIdentity, publicKey: RSAPublicKey) {
    self.identity = identity
    self.publicKey = publicKey
  }

  static func load() throws -> ClientIdentity {
    lock.lock()
    defer { lock.unlock() }
    if let cached { return cached }
    let identity = try find() ?? create()
    cached = identity
    return identity
  }

  static func reset() {
    lock.lock()
    defer { lock.unlock() }
    cached = nil
    deleteAll()
  }

  // MARK: - Keychain

  private static func find() throws -> ClientIdentity? {
    let certQuery: [String: Any] = [
      kSecClass as String: kSecClassCertificate,
      kSecAttrLabel as String: certLabel,
      kSecReturnRef as String: true,
    ]
    var certRef: CFTypeRef?
    guard SecItemCopyMatching(certQuery as CFDictionary, &certRef) == errSecSuccess,
          let certRef, CFGetTypeID(certRef) == SecCertificateGetTypeID() else { return nil }
    let certificate = certRef as! SecCertificate
    guard let identity = identityFor(certificate),
          let key = SecCertificateCopyKey(certificate),
          let publicKey = RSAPublicKey(key: key) else { return nil }
    return ClientIdentity(identity: identity, publicKey: publicKey)
  }

  /// The Keychain pairs a certificate with its private key (by public key hash) as an identity.
  private static func identityFor(_ certificate: SecCertificate) -> SecIdentity? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let identities = result as? [SecIdentity] else { return nil }
    let wanted = SecCertificateCopyData(certificate) as Data
    for identity in identities {
      var cert: SecCertificate?
      if SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert,
         SecCertificateCopyData(cert) as Data == wanted {
        return identity
      }
    }
    return nil
  }

  private static func create() throws -> ClientIdentity {
    deleteAll()
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeySizeInBits as String: 2048,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      ],
    ]
    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw IdentityError.crypto("No pude crear la clave: \(String(describing: error?.takeRetainedValue()))")
    }
    guard let publicKeyRef = SecKeyCopyPublicKey(privateKey),
          let pkcs1 = SecKeyCopyExternalRepresentation(publicKeyRef, &error) as Data?,
          let publicKey = RSAPublicKey(pkcs1: pkcs1) else {
      throw IdentityError.crypto("No pude leer la clave pública")
    }
    let der = try SelfSignedCertificate.make(publicKeyPKCS1: pkcs1, privateKey: privateKey, commonName: "Teclado TV")
    guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
      throw IdentityError.crypto("Certificado inválido")
    }
    let add: [String: Any] = [
      kSecClass as String: kSecClassCertificate,
      kSecValueRef as String: certificate,
      kSecAttrLabel as String: certLabel,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else {
      throw IdentityError.keychain("No pude guardar el certificado", status)
    }
    guard let identity = identityFor(certificate) else {
      throw IdentityError.crypto("El llavero no armó la identidad del certificado")
    }
    return ClientIdentity(identity: identity, publicKey: publicKey)
  }

  private static func deleteAll() {
    SecItemDelete([kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: certLabel] as CFDictionary)
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: keyTag] as CFDictionary)
  }
}

// MARK: - Minimal X.509 v3 self-signed certificate (DER), signed with SHA256withRSA

enum SelfSignedCertificate {
  private static let sha256WithRSA: [UInt8] = [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]
  private static let rsaEncryption: [UInt8] = [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]
  private static let commonNameOID: [UInt8] = [0x06, 0x03, 0x55, 0x04, 0x03]
  private static let null: [UInt8] = [0x05, 0x00]

  static func make(publicKeyPKCS1: Data, privateKey: SecKey, commonName: String) throws -> Data {
    let algorithm = der(0x30, sha256WithRSA + null)
    let name = der(0x30, der(0x31, der(0x30, commonNameOID + der(0x0C, Array(commonName.utf8)))))
    let now = Date()
    let validity = der(0x30, utcTime(now.addingTimeInterval(-86_400)) + utcTime(now.addingTimeInterval(20 * 365 * 86_400)))
    let spki = der(0x30, der(0x30, rsaEncryption + null) + der(0x03, [0x00] + Array(publicKeyPKCS1)))
    var serial = withUnsafeBytes(of: UInt64(now.timeIntervalSince1970 * 1000).bigEndian, Array.init)
    while serial.count > 1 && serial[0] == 0 { serial.removeFirst() }
    if serial[0] & 0x80 != 0 { serial.insert(0, at: 0) }
    let tbs = der(0x30,
                  der(0xA0, der(0x02, [0x02])) // version v3
                    + der(0x02, serial)
                    + algorithm
                    + name // issuer
                    + validity
                    + name // subject
                    + spki)
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256, Data(tbs) as CFData, &error) as Data? else {
      throw IdentityError.crypto("No pude firmar el certificado")
    }
    return Data(der(0x30, tbs + algorithm + der(0x03, [0x00] + Array(signature))))
  }

  private static func utcTime(_ date: Date) -> [UInt8] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyMMddHHmmss'Z'"
    return der(0x17, Array(formatter.string(from: date).utf8))
  }

  static func der(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
    let length = content.count
    var header: [UInt8] = [tag]
    if length < 0x80 {
      header.append(UInt8(length))
    } else if length < 0x100 {
      header += [0x81, UInt8(length)]
    } else if length < 0x10000 {
      header += [0x82, UInt8(length >> 8), UInt8(length & 0xFF)]
    } else {
      header += [0x83, UInt8(length >> 16), UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF)]
    }
    return header + content
  }
}

/// Reads DER tag-length-value items one after the other.
struct DERReader {
  private let bytes: [UInt8]
  private var position = 0

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  mutating func read(tag: UInt8) -> [UInt8]? {
    guard position < bytes.count, bytes[position] == tag else { return nil }
    position += 1
    guard position < bytes.count else { return nil }
    var length = Int(bytes[position])
    position += 1
    if length & 0x80 != 0 {
      let count = length & 0x7F
      guard count <= 4, position + count <= bytes.count else { return nil }
      length = 0
      for _ in 0..<count {
        length = (length << 8) | Int(bytes[position])
        position += 1
      }
    }
    guard position + length <= bytes.count else { return nil }
    let value = Array(bytes[position..<(position + length)])
    position += length
    return value
  }
}

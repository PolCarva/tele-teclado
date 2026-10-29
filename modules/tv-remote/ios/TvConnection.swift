import Foundation
import Network
import Security

/// Holds the TV's key between the TLS verify callback and the ready state (same queue).
private final class KeyBox {
  var key: RSAPublicKey?
}

struct ConnectError: Error {
  let code: String
  let message: String
}

/// One TLS connection to the TV, authenticated with this phone's certificate.
/// All state changes happen on the serial `queue`.
final class TvConnection {
  let id: Int
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let onData: (Data) -> Void
  private let onClose: (String?) -> Void
  private var serverKey: RSAPublicKey?
  private var started: ((Result<RSAPublicKey, ConnectError>) -> Void)?
  private var closed = false

  init(
    id: Int,
    host: String,
    port: Int,
    identity: ClientIdentity,
    queue: DispatchQueue,
    onData: @escaping (Data) -> Void,
    onClose: @escaping (String?) -> Void
  ) {
    self.id = id
    self.queue = queue
    self.onData = onData
    self.onClose = onClose

    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    if let localIdentity = sec_identity_create(identity.identity) {
      sec_protocol_options_set_local_identity(security, localIdentity)
    }
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv12)
    // The TV's certificate is self-signed; pairing ties it to the code shown on screen.
    // Keep its public key: the pairing secret is computed from it.
    let captured = KeyBox()
    sec_protocol_options_set_verify_block(security, { _, trust, complete in
      let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
      if let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate],
         let leaf = chain.first, let key = SecCertificateCopyKey(leaf) {
        captured.key = RSAPublicKey(key: key)
      }
      complete(true)
    }, queue)

    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    let parameters = NWParameters(tls: tls, tcp: tcp)
    connection = NWConnection(
      host: NWEndpoint.Host(host),
      port: NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? 6466,
      using: parameters
    )
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      if case .ready = state, self.serverKey == nil { self.serverKey = captured.key }
      self.handle(state)
    }
  }

  func start(timeoutMs: Int, completion: @escaping (Result<RSAPublicKey, ConnectError>) -> Void) {
    queue.async {
      self.started = completion
      self.connection.start(queue: self.queue)
      self.queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
        guard let self, let started = self.started else { return }
        self.started = nil
        self.closed = true
        self.connection.cancel()
        started(.failure(ConnectError(code: "ERR_NETWORK", message: "La tele no respondió (timeout)")))
      }
    }
  }

  func write(_ data: Data) {
    queue.async {
      guard !self.closed else { return }
      self.connection.send(content: data, completion: .contentProcessed { [weak self] error in
        if let error { self?.finish(Self.describe(error)) }
      })
    }
  }

  func close() {
    queue.async { self.finish(nil) }
  }

  private func handle(_ state: NWConnection.State) {
    switch state {
    case .ready:
      if let started {
        self.started = nil
        started(.success(serverKey ?? .empty))
        receive()
      }
    case let .waiting(error), let .failed(error):
      if let started {
        self.started = nil
        closed = true
        connection.cancel()
        let isTls: Bool = { if case .tls = error { return true } else { return false } }()
        started(.failure(ConnectError(code: isTls ? "ERR_TLS" : "ERR_NETWORK", message: Self.describe(error))))
      } else {
        finish(Self.describe(error))
      }
    case .cancelled:
      finish(nil)
    default:
      break
    }
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty { self.onData(data) }
      if let error {
        self.finish(Self.describe(error))
      } else if isComplete {
        self.finish(nil)
      } else {
        self.receive()
      }
    }
  }

  private func finish(_ error: String?) {
    guard !closed else { return }
    closed = true
    connection.cancel()
    onClose(error)
  }

  /// TLS alerts about our certificate mean the TV doesn't know this phone: say "certificate"
  /// so the shared code starts pairing.
  static func describe(_ error: NWError) -> String {
    if case let .tls(status) = error {
      let certificateProblem: Set<OSStatus> = [
        errSSLPeerCertUnknown, errSSLPeerBadCert, errSSLPeerUnsupportedCert, errSSLPeerCertRevoked,
        errSSLPeerCertExpired, errSSLPeerUnknownCA, errSSLBadCert, errSSLXCertChainInvalid,
        errSSLPeerHandshakeFail, errSSLPeerAccessDenied,
      ]
      if certificateProblem.contains(status) { return "TLS \(status): certificate rejected by the TV" }
      return "TLS \(status): \(error.localizedDescription)"
    }
    return error.localizedDescription
  }
}

import Foundation
import Network

/// Finds services on the Wi-Fi via Bonjour (e.g. _androidtvremote2._tcp, _airplay._tcp), with the
/// name each one announces, its IPv4 address, port and TXT record.
/// Each type must be listed in NSBonjourServices, plus NSLocalNetworkUsageDescription (see app.json).
final class MdnsBrowser {
  private let queue = DispatchQueue(label: "tele-teclado.mdns")
  private var browsers: [NWBrowser] = []
  private var resolvers: [NWConnection] = []
  private var found: [String: [String: Any]] = [:]
  private var requested = Set<String>()
  private var done: (([[String: Any]]) -> Void)?

  /// Keeps running sessions alive until they finish.
  private static var sessions: [ObjectIdentifier: MdnsBrowser] = [:]
  private static let lock = NSLock()

  static func browse(types: [String], timeoutMs: Int, done: @escaping ([[String: Any]]) -> Void) {
    let session = MdnsBrowser()
    let key = ObjectIdentifier(session)
    lock.lock()
    sessions[key] = session
    lock.unlock()
    session.start(types: types, timeoutMs: timeoutMs) { result in
      lock.lock()
      sessions[key] = nil
      lock.unlock()
      done(result)
    }
  }

  private func start(types: [String], timeoutMs: Int, done: @escaping ([[String: Any]]) -> Void) {
    queue.async {
      self.done = done
      for type in Set(types) {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: NWParameters())
        self.browsers.append(browser)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
          self?.resolve(type: type, results)
        }
        browser.start(queue: self.queue)
      }
      self.queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in self?.finish() }
    }
  }

  /// Bonjour gives a service name; a short TCP connection to it tells us the address and port.
  private func resolve(type: String, _ results: Set<NWBrowser.Result>) {
    for result in results {
      guard case let .service(name, _, _, _) = result.endpoint else { continue }
      let key = "\(type)|\(name)"
      guard !requested.contains(key) else { continue }
      requested.insert(key)
      var txt: [String: String] = [:]
      if case let .bonjour(record) = result.metadata {
        for (k, v) in record.dictionary { txt[k] = v }
      }
      let parameters = NWParameters.tcp
      if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
        ip.version = .v4
      }
      let connection = NWConnection(to: result.endpoint, using: parameters)
      resolvers.append(connection)
      connection.stateUpdateHandler = { [weak self, weak connection] state in
        guard let self, let connection else { return }
        switch state {
        case .ready:
          if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint {
            self.found[key] = [
              "type": type,
              "name": name,
              "host": Self.text(for: host),
              "port": Int(port.rawValue),
              "txt": txt,
            ]
          }
          connection.cancel()
        case .failed, .waiting:
          connection.cancel()
        default:
          break
        }
      }
      connection.start(queue: queue)
    }
  }

  private func finish() {
    guard let done else { return }
    self.done = nil
    browsers.forEach { $0.cancel() }
    resolvers.forEach { $0.cancel() }
    done(Array(found.values))
  }

  static func text(for host: NWEndpoint.Host) -> String {
    switch host {
    case let .ipv4(address):
      return "\(address)".components(separatedBy: "%").first ?? "\(address)"
    case let .ipv6(address):
      return "\(address)"
    case let .name(name, _):
      return name
    @unknown default:
      return "\(host)"
    }
  }
}

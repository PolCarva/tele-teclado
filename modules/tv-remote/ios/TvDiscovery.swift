import Foundation
import Network

/// Finds Android TVs / Google TVs on the Wi-Fi via Bonjour (_androidtvremote2._tcp),
/// with the name each TV announces and its IPv4 address.
/// Needs NSBonjourServices and NSLocalNetworkUsageDescription in Info.plist (see app.json).
final class TvDiscovery {
  private let queue = DispatchQueue(label: "tele-teclado.discovery")
  private var browser: NWBrowser?
  private var resolvers: [NWConnection] = []
  private var found: [String: [String: String]] = [:]
  private var requested = Set<String>()
  private var done: (([[String: String]]) -> Void)?

  /// Keeps running sessions alive until they finish.
  private static var sessions: [ObjectIdentifier: TvDiscovery] = [:]
  private static let lock = NSLock()

  static func find(timeoutMs: Int, done: @escaping ([[String: String]]) -> Void) {
    let session = TvDiscovery()
    let key = ObjectIdentifier(session)
    lock.lock()
    sessions[key] = session
    lock.unlock()
    session.start(timeoutMs: timeoutMs) { result in
      lock.lock()
      sessions[key] = nil
      lock.unlock()
      done(result)
    }
  }

  private func start(timeoutMs: Int, done: @escaping ([[String: String]]) -> Void) {
    queue.async {
      self.done = done
      let browser = NWBrowser(for: .bonjour(type: "_androidtvremote2._tcp", domain: nil), using: NWParameters())
      self.browser = browser
      browser.browseResultsChangedHandler = { [weak self] results, _ in
        self?.resolve(results)
      }
      browser.stateUpdateHandler = { [weak self] state in
        if case .failed = state { self?.finish() }
      }
      browser.start(queue: self.queue)
      self.queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in self?.finish() }
    }
  }

  /// Bonjour gives a service name; a short TCP connection to it tells us the TV's IP address.
  private func resolve(_ results: Set<NWBrowser.Result>) {
    for result in results {
      guard case let .service(name, _, _, _) = result.endpoint, !requested.contains(name) else { continue }
      requested.insert(name)
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
          if case let .hostPort(host, _)? = connection.currentPath?.remoteEndpoint {
            let address = Self.text(for: host)
            self.found[name] = ["name": name, "host": address]
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
    browser?.cancel()
    resolvers.forEach { $0.cancel() }
    done(Array(found.values))
  }

  private static func text(for host: NWEndpoint.Host) -> String {
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

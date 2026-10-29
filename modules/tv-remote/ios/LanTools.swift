import Darwin
import Foundation
import Network

/// Local-network helpers for finding TVs that don't announce themselves over Bonjour.
enum LanTools {
  /// SSDP: sends M-SEARCH for each search target to the multicast group (and, if given, straight
  /// to each host), and collects the replies. iOS only lets apps send multicast with Apple's
  /// multicast entitlement; without it the multicast send fails and only the unicast ones go out.
  static func ssdp(targets: [String], hosts: [String], timeoutMs: Int) -> [[String: String]] {
    let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    guard fd >= 0 else { return [] }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var ttl: UInt8 = 2
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, socklen_t(MemoryLayout<UInt8>.size))
    var local = sockaddr_in()
    local.sin_family = sa_family_t(AF_INET)
    local.sin_port = 0
    local.sin_addr.s_addr = INADDR_ANY
    let bound = withUnsafePointer(to: &local) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0 else { return [] }
    var wait = timeval(tv_sec: 0, tv_usec: 150_000)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))

    func send(_ message: String, to ip: String) {
      var dest = sockaddr_in()
      dest.sin_family = sa_family_t(AF_INET)
      dest.sin_port = UInt16(1900).bigEndian
      guard inet_pton(AF_INET, ip, &dest.sin_addr) == 1 else { return }
      let bytes = Array(message.utf8)
      _ = withUnsafePointer(to: &dest) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          sendto(fd, bytes, bytes.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
    func sendAll() {
      for st in targets {
        send("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: \(st)\r\n\r\n", to: "239.255.255.250")
        for host in hosts {
          send("M-SEARCH * HTTP/1.1\r\nHOST: \(host):1900\r\nMAN: \"ssdp:discover\"\r\nST: \(st)\r\n\r\n", to: host)
        }
      }
    }

    var results: [[String: String]] = []
    var seen = Set<String>()
    let start = Date()
    var resent = false
    sendAll()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while Date().timeIntervalSince(start) * 1000 < Double(timeoutMs) {
      if !resent, Date().timeIntervalSince(start) > 0.7 {
        // UDP gets lost: ask a second time.
        resent = true
        sendAll()
      }
      var from = sockaddr_in()
      var fromLength = socklen_t(MemoryLayout<sockaddr_in>.size)
      let n = withUnsafeMutablePointer(to: &from) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buffer, buffer.count, 0, $0, &fromLength) }
      }
      guard n > 0 else { continue }
      var address = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      inet_ntop(AF_INET, &from.sin_addr, &address, socklen_t(INET_ADDRSTRLEN))
      let host = String(cString: address)
      let text = String(decoding: buffer[0..<n], as: UTF8.self)
      if seen.insert("\(host)\n\(text)").inserted {
        results.append(["host": host, "response": text])
      }
    }
    return results
  }

  /// This phone's IPv4 address and prefix length on the Wi-Fi (en0), or another LAN interface.
  static func networkInfo() -> [String: Any]? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }
    var fallback: [String: Any]?
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let entry = cursor {
      defer { cursor = entry.pointee.ifa_next }
      guard let addr = entry.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
            let mask = entry.pointee.ifa_netmask else { continue }
      let name = String(cString: entry.pointee.ifa_name)
      let flags = Int32(entry.pointee.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
      let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
      let netmask = mask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
      var ipCopy = ip
      var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      inet_ntop(AF_INET, &ipCopy, &text, socklen_t(INET_ADDRSTRLEN))
      let info: [String: Any] = ["ip": String(cString: text), "prefixLength": UInt32(bigEndian: netmask).nonzeroBitCount]
      if name == "en0" { return info }
      if fallback == nil, name.hasPrefix("en") || name.hasPrefix("bridge") { fallback = info }
    }
    return fallback
  }
}

/// Which host:port pairs accept a TCP connection within the timeout, a few at a time.
final class PortProbe {
  private let queue = DispatchQueue(label: "tele-teclado.probe")
  private var pending: [(String, Int)] = []
  private var active = 0
  private var open: [[String: Any]] = []
  private var done: (([[String: Any]]) -> Void)?
  private let timeoutMs: Int
  private let concurrency: Int

  private static var sessions: [ObjectIdentifier: PortProbe] = [:]
  private static let lock = NSLock()

  private init(timeoutMs: Int, concurrency: Int) {
    self.timeoutMs = timeoutMs
    self.concurrency = max(1, min(concurrency, 128))
  }

  static func run(hosts: [String], ports: [Int], timeoutMs: Int, concurrency: Int, done: @escaping ([[String: Any]]) -> Void) {
    let session = PortProbe(timeoutMs: timeoutMs, concurrency: concurrency)
    let key = ObjectIdentifier(session)
    lock.lock()
    sessions[key] = session
    lock.unlock()
    session.queue.async {
      session.pending = hosts.flatMap { host in ports.map { (host, $0) } }
      session.done = { result in
        lock.lock()
        sessions[key] = nil
        lock.unlock()
        done(result)
      }
      session.next()
    }
  }

  private func next() {
    while active < concurrency, !pending.isEmpty {
      let (host, port) = pending.removeFirst()
      active += 1
      attempt(host: host, port: port)
    }
    if active == 0, pending.isEmpty, let done {
      self.done = nil
      done(open)
    }
  }

  private func attempt(host: String, port: Int) {
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
      active -= 1
      return
    }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
    var finished = false
    let finish: (Bool) -> Void = { [weak self] success in
      guard let self, !finished else { return }
      finished = true
      if success { self.open.append(["host": host, "port": port]) }
      connection.cancel()
      self.active -= 1
      self.next()
    }
    connection.stateUpdateHandler = { state in
      switch state {
      case .ready: finish(true)
      case .waiting, .failed: finish(false)
      default: break
      }
    }
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { finish(false) }
  }
}

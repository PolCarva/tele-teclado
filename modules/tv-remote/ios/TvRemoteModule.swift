import ExpoModulesCore
import Foundation
import Security

/// Native side of the TV remote on iPhone (same functions as the Android module):
/// this phone's certificate; byte streams to the TV (plain TCP, TLS, or TLS presenting that
/// certificate); finding TVs on the Wi-Fi (Bonjour, SSDP, port probe) and the phone's own address;
/// secure random bytes and a tiny key/value store. The protocols themselves live in TypeScript.
public class TvRemoteModule: Module {
  private let queue = DispatchQueue(label: "tele-teclado.tv-remote")
  private let lock = NSLock()
  private var connections: [Int: TvConnection] = [:]
  private var nextId = 1

  public func definition() -> ModuleDefinition {
    Name("TvRemote")

    Events("onData", "onClose")

    AsyncFunction("getClientKey") { () throws -> [String: String] in
      let key = try ClientIdentity.load().publicKey
      return ["modulus": key.modulusHex, "exponent": key.exponentHex]
    }

    AsyncFunction("resetClientKey") {
      ClientIdentity.reset()
    }

    AsyncFunction("connect") { (host: String, port: Int, timeoutMs: Int, mode: String, promise: Promise) in
      var identity: ClientIdentity?
      if mode == "tls-client-cert" {
        do {
          identity = try ClientIdentity.load()
        } catch {
          promise.reject("ERR_IDENTITY", "\(error)")
          return
        }
      }
      let id = self.allocateId()
      let connection = TvConnection(
        id: id,
        host: host,
        port: port,
        mode: mode,
        identity: identity,
        queue: self.queue,
        onData: { [weak self] data in
          self?.sendEvent("onData", ["id": id, "data": data.base64EncodedString()])
        },
        onClose: { [weak self] error in
          self?.remove(id)
          var body: [String: Any] = ["id": id]
          if let error { body["error"] = error }
          self?.sendEvent("onClose", body)
        }
      )
      self.store(connection)
      connection.start(timeoutMs: timeoutMs) { [weak self] result in
        switch result {
        case let .success(serverKey):
          promise.resolve([
            "id": id,
            "serverModulus": serverKey.modulusHex,
            "serverExponent": serverKey.exponentHex,
          ])
        case let .failure(error):
          self?.remove(id)
          promise.reject(error.code, error.message)
        }
      }
    }

    // Synchronous so writes keep the order JavaScript sent them in.
    Function("write") { (id: Int, base64: String) -> Bool in
      guard let connection = self.connection(id), let data = Data(base64Encoded: base64) else { return false }
      connection.write(data)
      return true
    }

    Function("close") { (id: Int) in
      self.connection(id)?.close()
    }

    AsyncFunction("browse") { (types: [String], timeoutMs: Int, promise: Promise) in
      MdnsBrowser.browse(types: types, timeoutMs: timeoutMs) { found in promise.resolve(found) }
    }

    AsyncFunction("ssdp") { (targets: [String], hosts: [String], timeoutMs: Int, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(LanTools.ssdp(targets: targets, hosts: hosts, timeoutMs: timeoutMs))
      }
    }

    AsyncFunction("probe") { (hosts: [String], ports: [Int], timeoutMs: Int, concurrency: Int, promise: Promise) in
      PortProbe.run(hosts: hosts, ports: ports, timeoutMs: timeoutMs, concurrency: concurrency) { open in
        promise.resolve(open)
      }
    }

    AsyncFunction("networkInfo") { () -> [String: Any]? in
      LanTools.networkInfo()
    }

    Function("randomBytes") { (count: Int) -> String in
      var bytes = [UInt8](repeating: 0, count: max(0, min(count, 4096)))
      _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
      return Data(bytes).base64EncodedString()
    }

    Function("getSetting") { (key: String) -> String? in
      UserDefaults.standard.string(forKey: "tele-teclado.\(key)")
    }

    Function("setSetting") { (key: String, value: String?) in
      UserDefaults.standard.set(value, forKey: "tele-teclado.\(key)")
    }

    OnDestroy {
      self.lock.lock()
      let all = Array(self.connections.values)
      self.connections.removeAll()
      self.lock.unlock()
      all.forEach { $0.close() }
    }
  }

  private func allocateId() -> Int {
    lock.lock()
    defer { lock.unlock() }
    let id = nextId
    nextId += 1
    return id
  }

  private func store(_ connection: TvConnection) {
    lock.lock()
    connections[connection.id] = connection
    lock.unlock()
  }

  private func remove(_ id: Int) {
    lock.lock()
    connections[id] = nil
    lock.unlock()
  }

  private func connection(_ id: Int) -> TvConnection? {
    lock.lock()
    defer { lock.unlock() }
    return connections[id]
  }
}

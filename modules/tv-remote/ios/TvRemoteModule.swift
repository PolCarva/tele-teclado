import ExpoModulesCore
import Foundation

/// Native side of the TV remote on iPhone (same functions as the Android module):
/// this phone's certificate, TLS sockets that present it, finding TVs on the Wi-Fi,
/// and a tiny key/value store. The protocol itself lives in TypeScript (src/protocol).
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

    AsyncFunction("connect") { (host: String, port: Int, timeoutMs: Int, promise: Promise) in
      let identity: ClientIdentity
      do {
        identity = try ClientIdentity.load()
      } catch {
        promise.reject("ERR_IDENTITY", "\(error)")
        return
      }
      let id = self.allocateId()
      let connection = TvConnection(
        id: id,
        host: host,
        port: port,
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

    AsyncFunction("discover") { (timeoutMs: Int, promise: Promise) in
      TvDiscovery.find(timeoutMs: timeoutMs) { tvs in promise.resolve(tvs) }
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

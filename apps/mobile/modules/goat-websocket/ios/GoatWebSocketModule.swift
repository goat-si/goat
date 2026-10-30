import ExpoModulesCore
import Foundation

// React Native's iOS WebSocket (SocketRocket) never offers permessage-deflate.
// URLSessionWebSocketTask offers it in every handshake, so the GOAT server's
// compressed stream reaches the phone compressed. Exposes only what Effect's
// `Socket.fromWebSocket` drives, routed by a JS-assigned connection id.
public final class GoatWebSocketModule: Module {
  private let connections = GoatWebSocketConnections()

  public func definition() -> ModuleDefinition {
    Name("GoatWebSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("connect") { (id: Int, url: String, protocols: [String]) throws in
      guard let parsedUrl = URL(string: url) else {
        throw Exception(name: "InvalidUrl", description: "Invalid WebSocket URL: \(url)")
      }
      self.connections.open(id: id, url: parsedUrl, protocols: protocols) { [weak self = self] event, payload in
        self?.sendEvent(event, payload)
      }
    }

    Function("sendText") { (id: Int, text: String) in
      self.connections.send(id: id, message: .string(text))
    }

    Function("sendBinary") { (id: Int, base64: String) in
      guard let data = Data(base64Encoded: base64) else { return }
      self.connections.send(id: id, message: .data(data))
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      self.connections.close(id: id, code: code, reason: reason)
    }

    OnDestroy {
      self.connections.cancelAll()
    }
  }
}

private typealias GoatWebSocketEmitter = (_ event: String, _ payload: [String: Any]) -> Void

private final class GoatWebSocketConnections: NSObject, URLSessionWebSocketDelegate {
  // URLSession's default receive cap is 1 MB; thread snapshots can be larger.
  private static let maximumMessageSize = 128 * 1024 * 1024

  private let queue = DispatchQueue(label: "si.goat.mobile.websocket")
  private var tasksById: [Int: URLSessionWebSocketTask] = [:]
  private var idsByTaskIdentifier: [Int: Int] = [:]
  private var emittersById: [Int: GoatWebSocketEmitter] = [:]

  // URLSession retains its delegate until invalidated, so teardown must
  // invalidate it or every module reload leaks this object. Only touched on `queue`.
  private var activeSession: URLSession?

  private var session: URLSession {
    if let activeSession { return activeSession }
    let configuration = URLSessionConfiguration.default
    // Dev clients and network debuggers register URLProtocol classes that drop
    // the connection right after the 101 upgrade (NSURLErrorDomain -1005).
    configuration.protocolClasses = []
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    activeSession = session
    return session
  }

  func open(id: Int, url: URL, protocols: [String], emitter: @escaping GoatWebSocketEmitter) {
    queue.async {
      let task = protocols.isEmpty
        ? self.session.webSocketTask(with: url)
        : self.session.webSocketTask(with: url, protocols: protocols)
      task.maximumMessageSize = Self.maximumMessageSize
      self.tasksById[id] = task
      self.idsByTaskIdentifier[task.taskIdentifier] = id
      self.emittersById[id] = emitter
      task.resume()
      self.receiveLoop(id: id, task: task)
    }
  }

  func send(id: Int, message: URLSessionWebSocketTask.Message) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      task.send(message) { error in
        guard let error else { return }
        self.queue.async {
          self.emitLocked(id: id, event: "onError", payload: ["message": error.localizedDescription])
        }
      }
    }
  }

  func close(id: Int, code: Int, reason: String) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
      task.cancel(with: closeCode, reason: reason.data(using: .utf8))
    }
  }

  func cancelAll() {
    queue.async {
      for task in self.tasksById.values {
        task.cancel(with: .goingAway, reason: nil)
      }
      self.tasksById.removeAll()
      self.idsByTaskIdentifier.removeAll()
      self.emittersById.removeAll()
      self.activeSession?.invalidateAndCancel()
      self.activeSession = nil
    }
  }

  private func receiveLoop(id: Int, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        // The delegate reports failures; a failed receive only ends the loop.
        guard case .success(let message) = result else { return }
        switch message {
        case .string(let text):
          self.emitLocked(id: id, event: "onMessage", payload: ["data": text, "binary": false])
        case .data(let data):
          self.emitLocked(id: id, event: "onMessage", payload: ["data": data.base64EncodedString(), "binary": true])
        @unknown default:
          break
        }
        guard self.tasksById[id] != nil else { return }
        self.receiveLoop(id: id, task: task)
      }
    }
  }

  // Must be called on `queue`.
  private func emitLocked(id: Int, event: String, payload: [String: Any]) {
    guard let emitter = emittersById[id] else { return }
    var enriched = payload
    enriched["id"] = id
    emitter(event, enriched)
  }

  private func remove(id: Int, taskIdentifier: Int) {
    tasksById.removeValue(forKey: id)
    idsByTaskIdentifier.removeValue(forKey: taskIdentifier)
    emittersById.removeValue(forKey: id)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      self.emitLocked(id: id, event: "onOpen", payload: ["protocol": `protocol` ?? ""])
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      self.emitLocked(id: id, event: "onClose", payload: ["code": closeCode.rawValue, "reason": reasonText])
      self.remove(id: id, taskIdentifier: webSocketTask.taskIdentifier)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[task.taskIdentifier] else { return }
      if let error {
        var message = error.localizedDescription
        if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 {
          message += " (HTTP \(status))"
        }
        self.emitLocked(id: id, event: "onError", payload: ["message": message])
        // No close frame arrived; 1006 is what a browser reports here.
        self.emitLocked(id: id, event: "onClose", payload: ["code": 1006, "reason": message])
      }
      self.remove(id: id, taskIdentifier: task.taskIdentifier)
    }
  }
}

import Darwin
import Foundation

// Agent sessions of the shared helper service (ADR-0023 D3 amendment 3, stage b). The desktop
// opens a session over its authenticated stdio channel; a session's proxy then attaches over
// this service's per-user socket with the launch token, its session token and a channel. Each
// MCP attach runs a fresh driver as this service's direct child, with the session's own
// manifest, native MCP session and overlay; nothing in one session can reach another's.

/// One driver child. Only this object signals or reaps it, under one lock, so a late Stop can
/// never signal a pid the kernel has handed to another process.
final class SessionDriver {
  let pid: pid_t
  let input: FileHandle
  let output: FileHandle
  private let lock = NSLock()
  private var reaped = false

  init(pid: pid_t, input: FileHandle, output: FileHandle) {
    self.pid = pid; self.input = input; self.output = output
  }

  func signal(_ number: Int32) {
    lock.lock(); defer { lock.unlock() }
    if !reaped { kill(pid, number) }
  }

  /// Waits for the exit without reaping, then reaps under the lock that every signal takes.
  func onExit(_ exited: @escaping (Int32) -> Void) {
    Thread.detachNewThread { [self] in
      var info = siginfo_t()
      while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
      lock.lock()
      var status: Int32 = 0
      while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
      reaped = true
      lock.unlock()
      exited(info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status)
    }
  }
}

/// What a session's overlay channel needs from the service: AppKit lives outside this file.
protocol SessionOverlay: AnyObject {
  func end()
}

final class AgentSessions {
  static let maxSessions = 32

  struct Spec {
    let manifestPath: String
    let settable: [[String: Any]]
  }

  /// One MCP connection and the driver it runs; it ends together, whatever ends first.
  final class Attachment {
    let session: Session
    let generation: UInt64
    let connection: Int32
    /// Set once the driver started and no Stop overtook the start.
    var driver: SessionDriver?
    var native: McpNativeSession?
    var overlay: SessionOverlay?
    var overlayAttached = false
    var ended = false
    var connectionClosed = false
    init(session: Session, generation: UInt64, connection: Int32) {
      self.session = session; self.generation = generation; self.connection = connection
    }
  }

  final class Session {
    let id: String
    let token: Data
    let spec: Spec
    var generation: UInt64 = 0
    /// Connections accepted at or before this sequence number may not attach: Stop fences them.
    var fencedThrough: UInt64 = 0
    var live: Attachment?
    init(id: String, token: Data, spec: Spec) { self.id = id; self.token = token; self.spec = spec }
  }

  enum Refusal: String, Error { case unauthorized, stopped, busy, noDriver = "no_driver", invalid }

  private let lock = NSLock()
  private var sessions: [String: Session] = [:]
  /// The sequence number of the last connection the socket accepted, taking every connection
  /// already waiting to be accepted first. Set by the listener; nothing is accepted without it.
  var fenceAccepts: () -> UInt64 = { 0 }
  let launchToken: Data
  private let launch: (Spec) throws -> SessionDriver
  private let report: ([String: Any]) -> Void

  /// launch starts a session's driver; report sends an unrequested line to the desktop.
  init(launchToken: Data, launch: @escaping (Spec) throws -> SessionDriver,
       report: @escaping ([String: Any]) -> Void) {
    self.launchToken = launchToken; self.launch = launch; self.report = report
  }

  var count: Int { lock.lock(); defer { lock.unlock() }; return sessions.count }

  // MARK: Desktop control

  func open(id: String, token: Data, spec: Spec) throws {
    lock.lock(); defer { lock.unlock() }
    guard sessions[id] == nil else {
      throw HelperError(code: "session_exists", message: "A session with this id is open.")
    }
    guard sessions.count < Self.maxSessions else {
      throw HelperError(code: "too_many_sessions", message: "The helper hosts too many sessions.")
    }
    sessions[id] = Session(id: id, token: token, spec: spec)
  }

  /// Ends the session's running driver and every connection accepted so far; it may attach again.
  @discardableResult func stop(id: String) -> Bool {
    lock.lock()
    guard let session = sessions[id] else { lock.unlock(); return false }
    // Under the lock every authorization takes: no connection the fence covers attaches after.
    session.fencedThrough = fenceAccepts()
    let live = session.live
    lock.unlock()
    if let live { end(live) }
    return true
  }

  /// Stops the session and forgets it with its token.
  func close(id: String) {
    lock.lock()
    let session = sessions.removeValue(forKey: id)
    if let session { session.fencedThrough = fenceAccepts() }
    let live = session?.live
    lock.unlock()
    if let live { end(live) }
  }

  func closeAll() {
    lock.lock(); let ids = Array(sessions.keys); lock.unlock()
    for id in ids { close(id: id) }
  }

  // MARK: Socket side

  private func authorize(_ request: [String: Any], sequence: UInt64) -> Result<Session, Refusal> {
    guard let id = request["session"] as? String, let launch = request["launch"] as? String,
      let token = request["token"] as? String
    else { return .failure(.invalid) }
    // Every comparison runs, so timing never says which part was wrong.
    let launchMatches = constantTimeEqual(Data(launch.utf8), launchToken)
    guard let session = sessions[id] else { return .failure(.unauthorized) }
    let tokenMatches = constantTimeEqual(Data(token.utf8), session.token)
    guard launchMatches && tokenMatches else { return .failure(.unauthorized) }
    guard sequence > session.fencedThrough else { return .failure(.stopped) }
    return .success(session)
  }

  /// Starts a driver for an authenticated MCP connection. The attachment is reserved under the
  /// lock and the driver started outside it, so a slow start never holds up another session's
  /// Stop; a Stop that lands meanwhile ends the start. The driver is published the moment it
  /// exists, so from then on every Stop reaches it; the manifest is read before it starts, so
  /// nothing that can block sits in between. The caller owns the connection only when this fails.
  func attachMcp(_ request: [String: Any], sequence: UInt64, connection: Int32,
                 native: (Attachment, SessionDriver, NativeManifest?) -> McpNativeSession)
    -> Result<Attachment, Refusal>
  {
    lock.lock()
    let session: Session
    switch authorize(request, sequence: sequence) {
    case .failure(let refusal): lock.unlock(); return .failure(refusal)
    case .success(let found): session = found
    }
    guard session.live == nil else { lock.unlock(); return .failure(.busy) }
    session.generation += 1
    let attachment = Attachment(session: session, generation: session.generation, connection: connection)
    session.live = attachment
    lock.unlock()
    let manifest = readNativeManifest(session.spec.manifestPath)
    lock.lock()
    let stoppedEarly = attachment.ended
    lock.unlock()
    if stoppedEarly { return .failure(.stopped) }
    let driver: SessionDriver
    do { driver = try launch(session.spec) } catch {
      lock.lock()
      if session.live === attachment { session.live = nil }
      attachment.ended = true
      lock.unlock()
      return .failure(.noDriver)
    }
    driver.onExit { [weak self] code in
      self?.report([
        "type": "sessionDriverExited", "sessionId": session.id,
        "generation": Int(attachment.generation), "driverPid": Int(driver.pid), "code": Int(code),
      ])
    }
    lock.lock()
    let overtaken = attachment.ended
    if !overtaken { attachment.driver = driver }
    lock.unlock()
    if overtaken {
      driver.signal(SIGKILL)
      try? driver.input.close()
      try? driver.output.close()
      return .failure(.stopped)
    }
    // Construction only: it reads nothing and waits on nothing.
    let made = native(attachment, driver, manifest)
    lock.lock()
    let ended = attachment.ended
    if !ended { attachment.native = made }
    lock.unlock()
    if ended {
      // The Stop that ended it already killed the published driver.
      made.endInput()
      return .failure(.stopped)
    }
    return .success(attachment)
  }

  /// Binds an overlay channel to the session's running driver; it ends with that driver.
  func attachOverlay(_ request: [String: Any], sequence: UInt64, connection: Int32,
                     overlay: (Attachment) -> SessionOverlay) -> Result<Attachment, Refusal> {
    lock.lock()
    let session: Session
    switch authorize(request, sequence: sequence) {
    case .failure(let refusal): lock.unlock(); return .failure(refusal)
    case .success(let found): session = found
    }
    guard let live = session.live, !live.ended, live.driver != nil else {
      lock.unlock(); return .failure(.noDriver)
    }
    guard !live.overlayAttached else { lock.unlock(); return .failure(.busy) }
    live.overlayAttached = true
    lock.unlock()
    let made = overlay(live)
    lock.lock()
    let stillLive = !live.ended
    if stillLive { live.overlay = made }
    lock.unlock()
    if !stillLive { made.end() }
    return .success(live)
  }

  /// Ends one attachment: its driver at once (it may be mid-action and must not outlive the
  /// connection that enforces its lease), its native work, its overlay and the connection's I/O.
  /// The connection is shut down under the lock that closes it, so it is never a reused number.
  func end(_ attachment: Attachment) {
    lock.lock()
    if attachment.ended { lock.unlock(); return }
    attachment.ended = true
    if attachment.session.live === attachment { attachment.session.live = nil }
    if !attachment.connectionClosed { shutdown(attachment.connection, SHUT_RDWR) }
    let overlay = attachment.overlay
    let driver = attachment.driver
    let native = attachment.native
    lock.unlock()
    driver?.signal(SIGKILL)
    native?.endInput()
    overlay?.end()
  }

  /// Closes the connection once its relay is done reading it.
  func release(_ attachment: Attachment) {
    lock.lock(); defer { lock.unlock() }
    guard !attachment.connectionClosed else { return }
    attachment.connectionClosed = true
    Darwin.close(attachment.connection)
  }

  /// The running attachment's native session, if this overlay's attachment is still live.
  func native(of attachment: Attachment) -> McpNativeSession? {
    lock.lock(); defer { lock.unlock() }
    return attachment.ended ? nil : attachment.native
  }
}

func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
  var difference = UInt8(a.count == b.count ? 0 : 1)
  let length = max(a.count, b.count)
  for index in 0..<length {
    let x = index < a.count ? a[a.startIndex + index] : 0
    let y = index < b.count ? b[b.startIndex + index] : 0
    difference |= x ^ y
  }
  return difference == 0
}

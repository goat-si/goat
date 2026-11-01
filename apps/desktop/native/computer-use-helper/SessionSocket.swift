import Darwin
import Foundation

/// The per-user socket agent sessions attach on (ADR-0023 D3 amendment 3). It lives in a fresh
/// 0700 directory per launch, and every connection passes the peer check, then gets a challenge
/// line and must answer with one bounded auth line, all within the handshake deadline counted
/// from its accept. At most maxPending connections are unauthenticated at once; more are closed
/// as they arrive.
final class SessionListener {
  static let maxPending = 8
  static let authLineLimit = 4096
  static let handshakeSeconds = 2

  let directory: String
  let path: String
  private let fd: Int32
  private let pendingLock = NSLock()
  private var pending = 0
  /// Accepting and numbering are one step under this lock, which a Stop's fence also takes.
  private let acceptLock = NSLock()
  private var accepted: UInt64 = 0
  private let peerRefusal: (Int32) -> String?
  private let serve: (Int32, UInt64, [String: Any]) -> Void

  /// serve owns the connection once called; it gets the parsed auth line.
  init(peerRefusal: @escaping (Int32) -> String?,
       serve: @escaping (Int32, UInt64, [String: Any]) -> Void) throws {
    self.peerRefusal = peerRefusal
    self.serve = serve
    directory = try Self.privateDirectory()
    path = directory + "/s"
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
      for (index, byte) in bytes.enumerated() { buffer[index] = byte }
      buffer[bytes.count] = 0
    }
    let socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard socketFd >= 0 else { rmdir(directory); throw Self.failure("create") }
    _ = fcntl(socketFd, F_SETFD, FD_CLOEXEC)
    // Non-blocking, so a fence can take every connection already waiting without blocking.
    _ = fcntl(socketFd, F_SETFL, fcntl(socketFd, F_GETFL) | O_NONBLOCK)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(socketFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, chmod(path, 0o600) == 0, listen(socketFd, 16) == 0 else {
      close(socketFd); unlink(path); rmdir(directory)
      throw Self.failure("bind")
    }
    fd = socketFd
    Thread.detachNewThread { [self] in acceptLoop() }
  }

  /// Removes the socket and its directory; the accept loop ends with the descriptor.
  func remove() {
    unlink(path)
    rmdir(directory)
    shutdown(fd, SHUT_RDWR)
  }

  private static func failure(_ step: String) -> HelperError {
    HelperError(code: "socket_failed", message: "Could not \(step) the agent session socket (\(errno)).")
  }

  /// A new directory this user alone can enter, short enough for sun_path with "/s".
  static func privateDirectory() throws -> String {
    let limit = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
    for base in [NSTemporaryDirectory(), "/tmp"] {
      guard let resolved = realpath(base, nil) else { continue }
      let root = String(cString: resolved)
      free(resolved)
      var template = Array((root + "/goat-cu.XXXXXX").utf8CString)
      // template counts its terminator; the socket adds "/s".
      guard template.count + 2 <= limit, mkdtemp(&template) != nil else { continue }
      let directory = String(cString: template)
      var info = stat()
      guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
        info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700
      else { rmdir(directory); continue }
      return directory
    }
    throw HelperError(code: "socket_failed", message: "No private directory for the agent session socket.")
  }

  /// Accepts every connection waiting now and returns the last sequence number given. A Stop
  /// calls it, so a connection that reached the socket before the Stop is numbered under it.
  func fence() -> UInt64 {
    acceptLock.lock(); defer { acceptLock.unlock() }
    acceptWaiting()
    return accepted
  }

  private func acceptLoop() {
    while true {
      var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&descriptor, 1, -1)
      if ready < 0 && errno == EINTR { continue }
      guard ready > 0, descriptor.revents & Int16(POLLNVAL) == 0 else { return }
      acceptLock.lock()
      acceptWaiting()
      acceptLock.unlock()
    }
  }

  /// Under acceptLock: numbers each connection as it is accepted, before it can say anything.
  private func acceptWaiting() {
    while true {
      let client = Darwin.accept(fd, nil, nil)
      if client < 0 {
        if errno == EINTR || errno == ECONNABORTED { continue }
        return
      }
      let deadline = monotonicNanoseconds() + UInt64(Self.handshakeSeconds) * 1_000_000_000
      _ = fcntl(client, F_SETFD, FD_CLOEXEC)
      // An accepted socket inherits the listener's non-blocking flag; its handshake blocks.
      _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
      var on: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      pendingLock.lock()
      let admitted = pending < Self.maxPending
      if admitted { pending += 1 }
      pendingLock.unlock()
      guard admitted else { close(client); continue }
      accepted += 1
      let sequence = accepted
      Thread.detachNewThread { [self] in
        let request = handshake(client, deadline: deadline)
        pendingLock.lock(); pending -= 1; pendingLock.unlock()
        guard let request else { close(client); return }
        serve(client, sequence, request)
      }
    }
  }

  private func handshake(_ client: Int32, deadline: UInt64) -> [String: Any]? {
    // The peer check cannot be interrupted, so the deadline is checked as soon as it returns.
    let refusal = peerRefusal(client)
    let now = monotonicNanoseconds()
    let remaining = deadline > now ? deadline - now : 0
    guard remaining > 0 else { return nil }
    var limit = timeval(
      tv_sec: Int(remaining / 1_000_000_000), tv_usec: Int32(remaining % 1_000_000_000 / 1000))
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
    if let refusal {
      sessionLine(client, ["type": "refused", "reason": "untrusted_peer", "message": refusal])
      return nil
    }
    guard sessionLine(client, ["type": "challenge", "protocol": protocolVersion]) else { return nil }
    // One byte at a time: whatever follows the auth line belongs to the channel.
    var line = [UInt8]()
    var byte: UInt8 = 0
    while true {
      let now = monotonicNanoseconds()
      guard now < deadline else { return nil }
      var descriptor = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
      let ready = poll(&descriptor, 1, Int32((deadline - now) / 1_000_000) + 1)
      if ready < 0 && errno == EINTR { continue }
      guard ready > 0, read(client, &byte, 1) == 1 else { return nil }
      if byte == 0x0A { break }
      line.append(byte)
      guard line.count <= Self.authLineLimit else { return nil }
    }
    var cleared = timeval(tv_sec: 0, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &cleared, socklen_t(MemoryLayout<timeval>.size))
    return (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any]
  }
}

/// Writes one JSON line to a session connection; false when it could not be written whole.
@discardableResult func sessionLine(_ fd: Int32, _ object: [String: Any]) -> Bool {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    return false
  }
  data.append(0x0A)
  return data.withUnsafeBytes { bytes in
    var offset = 0
    while offset < bytes.count {
      let written = write(fd, bytes.baseAddress! + offset, bytes.count - offset)
      if written < 0 && errno == EINTR { continue }
      if written <= 0 { return false }
      offset += written
    }
    return true
  }
}

/// Relays one attachment's MCP between its connection and its driver, as relayMcp does for
/// stdio. The connection closes once both directions are done, and never before.
func relaySession(_ attachment: AgentSessions.Attachment, sessions: AgentSessions) {
  guard let driver = attachment.driver else { return }
  let connection = FileHandle(fileDescriptor: attachment.connection, closeOnDealloc: false)
  let done = DispatchGroup()
  func pump(_ input: FileHandle, _ output: FileHandle, tail: Bool,
            handle: ((Data) throws -> Void)?, finished: @escaping () -> Void) {
    done.enter()
    DispatchQueue.global().async {
      defer { finished(); done.leave() }
      try? pumpMcpFrames(from: input, to: output, acceptTail: tail, handle: handle)
    }
  }
  let native = attachment.native
  // The connection's end is Stop's boundary: the driver goes at once, mid-action or not, and
  // even while the pump below is blocked writing to a driver that stopped reading.
  done.enter()
  DispatchQueue.global().async {
    defer { done.leave() }
    watchHangup(attachment.connection)
    sessions.end(attachment)
  }
  pump(connection, driver.input, tail: false, handle: native.map { owner in { try owner.fromProvider($0) } }) {
    sessions.end(attachment)
    try? driver.input.close()
  }
  // The driver's output drains to the connection before the attachment ends on its own.
  pump(driver.output, connection, tail: true, handle: native.map { owner in { try owner.fromDriver($0) } }) {
    try? driver.output.close()
    sessions.end(attachment)
  }
  done.notify(queue: .global()) { sessions.release(attachment) }
}

/// Returns once the socket's read side has ended: the peer closed it or this side shut it down.
/// kqueue reports that end (EV_EOF) even while unread bytes wait in the buffer; edge-triggered,
/// so buffered data does not wake it again and again.
func watchHangup(_ fd: Int32) {
  let queue = kqueue()
  guard queue >= 0 else { return }
  defer { close(queue) }
  var change = kevent(
    ident: UInt(fd), filter: Int16(EVFILT_READ), flags: UInt16(EV_ADD | EV_CLEAR), fflags: 0,
    data: 0, udata: nil)
  guard kevent(queue, &change, 1, nil, 0, nil) == 0 else { return }
  var event = kevent()
  while true {
    let count = kevent(queue, nil, 0, &event, 1, nil)
    if count < 0 && errno == EINTR { continue }
    if count <= 0 || event.flags & UInt16(EV_EOF) != 0 || event.flags & UInt16(EV_ERROR) != 0 {
      return
    }
  }
}

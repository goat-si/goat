import Foundation

protocol McpWriting: AnyObject {
  @discardableResult func write(_ frame: Data, live: () -> Bool) throws -> Bool
  func enqueue(_ frame: Data, live: @escaping () -> Bool, done: @escaping (Bool) -> Void)
  func closeNative()
}

/// A generation fence is independent of the transport lock: Stop never waits for a full pipe.
final class McpGeneration {
  private let lock = NSLock()
  private var active = true
  var isActive: Bool { lock.lock(); defer { lock.unlock() }; return active }
  func invalidate() { lock.lock(); active = false; lock.unlock() }
}

/// Ordinary pumps retain synchronous backpressure. Native completions have only two bounded
/// slots, so a blocked provider cannot grow a queue or prevent local cancellation/teardown.
final class McpWire: McpWriting {
  private struct Entry {
    let frame: Data
    let live: () -> Bool
    let done: (Bool) -> Void
  }
  private let handle: FileHandle
  private let writeLock = NSLock()
  private let state = NSLock()
  private let queue = DispatchQueue(label: "si.goat.computer-use.native-writer")
  private let failure: (Int32, String) -> Void
  private var entries: [Entry] = []
  private var outstanding = 0
  private var bytes = 0
  private var draining = false
  private var closed = false

  init(_ handle: FileHandle, failure: @escaping (Int32, String) -> Void) {
    self.handle = handle
    self.failure = failure
  }

  @discardableResult
  func write(_ frame: Data, live: () -> Bool = { true }) throws -> Bool {
    guard frame.count <= mcpFrameLimit else { throw McpFrameError.tooLarge }
    writeLock.lock()
    defer { writeLock.unlock() }
    guard live() else { return false }
    var line = frame
    line.append(0x0a)
    try handle.write(contentsOf: line)
    return true
  }

  func enqueue(_ frame: Data, live: @escaping () -> Bool, done: @escaping (Bool) -> Void = { _ in }) {
    state.lock()
    if closed { state.unlock(); done(false); return }
    guard frame.count <= mcpFrameLimit, outstanding < 2, frame.count <= mcpFrameLimit - bytes else {
      state.unlock()
      failure(74, "The native MCP writer is full.")
      return
    }
    entries.append(Entry(frame: frame, live: live, done: done))
    outstanding += 1
    bytes += frame.count
    let start = !draining
    draining = true
    state.unlock()
    if start { queue.async { self.drain() } }
  }

  private func drain() {
    while true {
      state.lock()
      guard !entries.isEmpty else { draining = false; state.unlock(); return }
      let entry = entries.removeFirst()
      state.unlock()
      var written = false
      do { written = try write(entry.frame, live: entry.live) }
      catch { failure(74, "The native MCP transport failed.") }
      state.lock()
      outstanding -= 1
      bytes -= entry.frame.count
      state.unlock()
      entry.done(written)
    }
  }

  func closeNative() {
    state.lock()
    closed = true
    let dropped = entries
    entries.removeAll()
    outstanding -= dropped.count
    bytes -= dropped.reduce(0) { $0 + $1.frame.count }
    state.unlock()
    for entry in dropped { entry.done(false) }
  }
}

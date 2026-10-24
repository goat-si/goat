// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// The reports a run of pointer events turns into, kept free of the system so it can be tested
/// (apps/desktop/src/cua/ComputerUseHelperInput.test.ts). It is given an event's type and the time
/// it arrived, nothing else. Each event is judged on its own: one that starts a run (no pointer
/// event in the last burstGap) is always reported with its own time, so an agent's events right
/// after it cannot hide it (#1488). Inside a run, one event per burstInterval is reported, which
/// keeps a stream of moves to a few lines a second without leaving a run unreported for longer.
struct PointerReports {
  static let burstGap = 0.1
  static let burstInterval = 0.25

  /// The pointer event types the tap receives. Keyboard events are never among them (D7: the
  /// helper does not use Input Monitoring); keyboard input is polled.
  static let types: [CGEventType] = [
    .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
    .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  ]

  private var previous = -Double.infinity
  private var reported = -Double.infinity

  /// The time to report for a pointer event of `type` that arrived at `at`, or nil.
  mutating func event(_ type: CGEventType, at: Double) -> Double? {
    guard Self.types.contains(type) else { return nil }
    let startsRun = at - previous >= Self.burstGap
    previous = at
    guard startsRun || at - reported >= Self.burstInterval else { return nil }
    reported = at
    return at
  }
}

/// Reports a person's keyboard and pointer use: the kind and the time only, never a key, a
/// position, a button or a window. The driver posts some of the agent's input through the same
/// system, so this reports the agent's events too; the lease proxy and the server know when input
/// calls ran and keep only the rest (apps/server/src/cua/agentInputLog.ts).
///
/// Pointer events come one by one from a listen-only event tap, which needs no grant, so a
/// person's click or move just before an agent's is reported with its own time (#1488). Keyboard
/// events are only polled: the newest key's age, read every 250 ms, which needs no grant either
/// but can miss a person's key right before an agent's typing. A keyboard tap would need Input
/// Monitoring, which the helper does not use (D7). Polling also covers the pointer, in case no
/// tap could be made; an event both see is reported twice, and the server judges both alike.
/// Nothing listens once the connection ends.
final class InputActivity {
  private static let polled: [(source: String, types: [CGEventType])] = [
    ("keyboard", [.keyDown, .flagsChanged]),
    ("pointer", PointerReports.types),
  ]
  private let report: (String, Double) -> Void
  private let queue = DispatchQueue(label: "si.goat.computer-use.input")
  private var pointer = PointerReports()
  private var tap: CFMachPort?
  private var timer: DispatchSourceTimer?
  private var latest: [String: Double] = [:]

  /// `at` is on `InputActivity.now()`'s clock, so a later writer can say how long ago it was.
  init(report: @escaping (_ source: String, _ at: Double) -> Void) {
    self.report = report
  }

  /// Seconds on a clock that never steps back with the wall clock.
  static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

  func start() {
    startTap()
    startPolling()
  }

  // MARK: Pointer tap

  private func startTap() {
    let mask = PointerReports.types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, type, event, info in
          // Only the event's type leaves this callback: its location, buttons and every other
          // field are never read, so nothing about where or what was clicked is kept or sent.
          if let info {
            Unmanaged<InputActivity>.fromOpaque(info).takeUnretainedValue().received(type)
          }
          return Unmanaged.passUnretained(event)
        },
        userInfo: Unmanaged.passUnretained(self).toOpaque())
    else { return }
    self.tap = tap
    let thread = Thread {
      let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      CFRunLoopRun()
    }
    thread.name = "si.goat.computer-use.pointer-tap"
    thread.start()
  }

  /// On the tap's thread, as each event arrives, with its type only.
  private func received(_ type: CGEventType) {
    // The system turns off a tap it judges slow or during secure input; listening goes on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    let at = Self.now()
    queue.async { [self] in
      if let at = pointer.event(type, at: at) { report("pointer", at) }
    }
  }

  // MARK: Polling

  /// Seconds since the newest event of a kind, on the clock the system counts it with.
  private static func age(_ types: [CGEventType]) -> Double {
    types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
      ?? .infinity
  }

  private func startPolling() {
    queue.async { [self] in
      // Whatever happened before this connection is no one's concern here.
      let now = Self.now()
      for kind in Self.polled { latest[kind.source] = now - Self.age(kind.types) }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
      timer.setEventHandler { [weak self] in self?.poll() }
      timer.resume()
      self.timer = timer
    }
  }

  private func poll() {
    let now = Self.now()
    for kind in Self.polled {
      let age = Self.age(kind.types)
      guard age.isFinite else { continue }
      let at = now - age
      // A millisecond of slack: the same event read twice must not count as a new one.
      guard at > (latest[kind.source] ?? -.infinity) + 0.001 else { continue }
      latest[kind.source] = at
      report(kind.source, at)
    }
  }
}

// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// Which tapped events are reported, kept free of the system so it can be tested
/// (apps/desktop/src/cua/ComputerUseHelperInput.test.ts). It is given an event's type and the time
/// it arrived, nothing else. The tap takes button presses only: a person's click is the input that
/// must not hide behind an agent's (#1488), and presses come a few a second at most, so every
/// one is reported with its own time and none is ever dropped or held back. Moves, drags and
/// scrolls come dozens a second; reporting each would queue the safety reports behind each other,
/// and thinning them would drop some, so they stay polled.
enum PointerTap {
  /// The event types the tap receives. Keyboard events are never among them (D7: the helper does
  /// not use Input Monitoring); keyboard input is polled.
  static let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]

  /// The time to report for a tapped event of `type` that arrived at `at`, or nil.
  static func report(_ type: CGEventType, at: Double) -> Double? {
    types.contains(type) ? at : nil
  }
}

/// Reports a person's keyboard and pointer use: the kind and the time only, never a key, a
/// position, a button or a window. The driver posts some of the agent's input through the same
/// system, so this reports the agent's events too; the lease proxy and the server know when input
/// calls ran and keep only the rest (apps/server/src/cua/agentInputLog.ts).
///
/// Button presses come one by one from a listen-only event tap, which needs no grant, so a
/// person's click just before an agent's pointer input is reported with its own time (#1488).
/// Everything else is polled: each kind's newest event age, read every 250 ms, which needs no
/// grant either but reports only the newest event of a kind per poll, so a person's key, move or
/// scroll right before an agent's of the same kind can hide behind it. A keyboard tap would need
/// Input Monitoring, which the helper does not use (D7). Polling sees presses too, so a press both
/// see is reported twice, which the server judges the same way, and a tap that could not be made
/// leaves presses polled as before. Nothing listens once the connection ends.
final class InputActivity {
  private static let polled: [(source: String, types: [CGEventType])] = [
    ("keyboard", [.keyDown, .flagsChanged]),
    (
      "pointer",
      [
        .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
        .leftMouseDragged, .rightMouseDragged,
      ]
    ),
  ]
  private let report: (String, Double) -> Void
  private let queue = DispatchQueue(label: "si.goat.computer-use.input")
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
    let mask = PointerTap.types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
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
      if let at = PointerTap.report(type, at: at) { report("pointer", at) }
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

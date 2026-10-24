// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// The reports a run of input events turns into, kept free of the system so it can be tested
/// (apps/desktop/src/cua/ComputerUseHelperInput.test.ts). Each event is judged on its own: one
/// that starts a run (nothing of its kind in the last burstGap) is always reported with its own
/// time, so an agent's events right after it cannot hide it (#1488). Inside a run, one event per
/// burstInterval is reported, which keeps a stream of pointer moves or typing to a few lines a
/// second without leaving a run unreported for longer than that.
struct InputReports {
  static let burstGap = 0.1
  static let burstInterval = 0.25

  static func source(of type: CGEventType) -> String? {
    switch type {
    case .keyDown, .flagsChanged: return "keyboard"
    case .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
      return "pointer"
    default: return nil
    }
  }

  /// The event types to receive: exactly the ones source(of:) names.
  static let types: [CGEventType] = [
    .keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
    .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  ]

  private var previous: [String: Double] = [:]
  private var reported: [String: Double] = [:]

  mutating func event(_ type: CGEventType, at: Double) -> (source: String, at: Double)? {
    guard let source = Self.source(of: type) else { return nil }
    let startsRun = at - (previous[source] ?? -.infinity) >= Self.burstGap
    previous[source] = at
    guard startsRun || at - (reported[source] ?? -.infinity) >= Self.burstInterval else {
      return nil
    }
    reported[source] = at
    return (source, at)
  }
}

/// Reports a person's keyboard and pointer events as they happen: the kind and the time only,
/// never a key, a position or a window. A listen-only event tap sees each event, so one an
/// agent's call follows within the same moment is still reported with its own time (#1488). The
/// driver posts some of the agent's input through the same system, so this reports the agent's
/// events too; the lease proxy and the server know when input calls ran and keep only the rest
/// (apps/server/src/cua/agentInputLog.ts).
///
/// macOS lets a listen-only tap see pointer events with no grant, but keyboard events only with
/// Input Monitoring, and it silently drops from a tap the types it may not see. So keyboard
/// events join the tap only when Input Monitoring is already granted (checked without asking).
/// The helper also keeps polling each kind's newest event, as before the tap: a kind no tap sees
/// is still reported, though a person's event right before an agent's of that kind can then be
/// missed, and an event both see is reported twice, which the server judges the same way.
/// Nothing listens once the connection ends.
final class InputActivity {
  private let report: (String, Double) -> Void
  private let queue = DispatchQueue(label: "si.goat.computer-use.input")
  private var reports = InputReports()
  private var tap: CFMachPort?
  private var timer: DispatchSourceTimer?
  private var polled: [String: Double] = [:]

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

  // MARK: Event tap

  private func startTap() {
    // Keyboard events in a tap without Input Monitoring would ask the person for it, or be
    // dropped from the tap without a word.
    let sources: Set<String> =
      CGPreflightListenEventAccess() ? ["keyboard", "pointer"] : ["pointer"]
    let mask = InputReports.types.filter { sources.contains(InputReports.source(of: $0) ?? "") }
      .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, type, event, info in
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
    thread.name = "si.goat.computer-use.input-tap"
    thread.start()
  }

  /// On the tap's thread, as each event arrives.
  private func received(_ type: CGEventType) {
    // The system turns off a tap it judges slow or after secure input; listening goes on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    let at = Self.now()
    queue.async { [self] in
      if let event = reports.event(type, at: at) { report(event.source, event.at) }
    }
  }

  // MARK: Polling

  private static func age(_ source: String) -> Double {
    InputReports.types.filter { InputReports.source(of: $0) == source }
      .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
      ?? .infinity
  }

  private func startPolling() {
    queue.async { [self] in
      // Whatever happened before this connection is no one's concern here.
      let now = Self.now()
      for source in ["keyboard", "pointer"] { polled[source] = now - Self.age(source) }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
      timer.setEventHandler { [weak self] in self?.poll() }
      timer.resume()
      self.timer = timer
    }
  }

  private func poll() {
    let now = Self.now()
    for source in ["keyboard", "pointer"] {
      let age = Self.age(source)
      guard age.isFinite else { continue }
      let at = now - age
      // A millisecond of slack: the same event read twice must not count as a new one.
      guard at > (polled[source] ?? -.infinity) + 0.001 else { continue }
      polled[source] = at
      report(source, at)
    }
  }
}

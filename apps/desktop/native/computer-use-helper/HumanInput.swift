// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// Polls how long ago the system last had each kind of keyboard and pointer event, and reports
/// every new one with when it happened: the kind only, never a key, a position or a window. The driver
/// posts the agent's input through the same system state, so this reports the agent's events
/// too; the lease proxy knows when its input calls ran and keeps only the rest
/// (apps/server/src/cua/agentInputLog.ts). Reading these counters needs no Input Monitoring
/// grant, and nothing listens once the connection ends.
final class InputActivity {
  private static let kinds: [(source: String, types: [CGEventType])] = [
    ("keyboard", [.keyDown, .flagsChanged]),
    (
      "pointer",
      [
        .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
        .leftMouseDragged, .rightMouseDragged,
      ]
    ),
  ]
  private let queue = DispatchQueue(label: "si.goat.computer-use.input")
  private let report: (String, Double) -> Void
  private var latest: [String: Double] = [:]
  private var timer: DispatchSourceTimer?

  /// `at` is on `InputActivity.now()`'s clock, so a later writer can say how long ago it was.
  init(report: @escaping (_ source: String, _ at: Double) -> Void) {
    self.report = report
  }

  /// Seconds since the newest event of a kind, on the clock the system counts it with.
  private static func age(_ types: [CGEventType]) -> Double {
    types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
      ?? .infinity
  }

  /// Seconds on a clock that never steps back with the wall clock.
  static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

  func start() {
    queue.async { [self] in
      // Whatever happened before this connection is no one's concern here.
      let now = Self.now()
      for kind in Self.kinds { self.latest[kind.source] = now - Self.age(kind.types) }
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
      timer.setEventHandler { [weak self] in self?.poll() }
      timer.resume()
      self.timer = timer
    }
  }

  private func poll() {
    let now = Self.now()
    for kind in Self.kinds {
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

/// The reports a run of input events turns into, kept free of the system so it can be tested
/// (apps/desktop/src/cua/ComputerUseHelperInput.test.ts). Polled: the system keeps only the
/// newest event of each kind, and each tick reports that newest one if it is new.
struct InputReports {
  static func source(of type: CGEventType) -> String? {
    switch type {
    case .keyDown, .flagsChanged: return "keyboard"
    case .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
      .leftMouseDragged, .rightMouseDragged:
      return "pointer"
    default: return nil
    }
  }

  private var newest: [String: Double] = [:]
  private var reported: [String: Double] = [:]

  mutating func event(_ type: CGEventType, at: Double) -> (source: String, at: Double)? {
    if let source = Self.source(of: type) { newest[source] = at }
    return nil
  }

  mutating func tick() -> [(source: String, at: Double)] {
    var out: [(source: String, at: Double)] = []
    for (source, at) in newest.sorted(by: { $0.key < $1.key }) {
      guard at > (reported[source] ?? -.infinity) + 0.001 else { continue }
      reported[source] = at
      out.append((source, at))
    }
    return out
  }
}

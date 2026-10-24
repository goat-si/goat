// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// Polls how long ago the system last had each kind of keyboard and pointer event, and reports
/// every new one with its age: the kind only, never a key, a position or a window. The driver
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
  private let report: (String, Int) -> Void
  private var latest: [String: Double] = [:]
  private var timer: DispatchSourceTimer?

  init(report: @escaping (_ source: String, _ ageMs: Int) -> Void) {
    self.report = report
  }

  /// Seconds since the newest event of a kind, on the clock the system counts it with.
  private static func age(_ types: [CGEventType]) -> Double {
    types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
      ?? .infinity
  }

  /// Seconds on a clock that never steps back with the wall clock.
  private static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

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
      report(kind.source, Int((age * 1000).rounded()))
    }
  }
}

// Pure checks of HumanInput.swift's PointerReports, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperInput.test.ts on macOS.

import CoreGraphics
import Foundation

/// Feeds events in time order and collects the times reported.
func run(_ events: [(CGEventType, Double)]) -> [Double] {
  var reports = PointerReports()
  return events.compactMap { reports.event($0.0, at: $0.1) }
}

@main
struct HumanInputTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
      print((ok ? "ok   " : "FAIL ") + name + (ok ? "" : ": " + detail()))
      if !ok { failures += 1 }
    }

    // A person's click, then an agent's moves and click within the same quarter second (#1488).
    let mixed = run([
      (.leftMouseDown, 0.10), (.mouseMoved, 0.16), (.mouseMoved, 0.20), (.leftMouseDown, 0.24),
    ])
    check(
      "a person's click just before an agent's pointer input is reported with its own time",
      mixed.contains { abs($0 - 0.10) < 1e-9 }, "\(mixed)")

    let spaced = run([(.leftMouseDown, 0.0), (.scrollWheel, 0.15), (.rightMouseDown, 0.30)])
    check("pointer events apart from each other are each reported", spaced == [0.0, 0.15, 0.30], "\(spaced)")

    let dense = run((0...100).map { (CGEventType.mouseMoved, Double($0) * 0.01) })
    check(
      "a dense run is reported from its first event, then at most every 250 ms",
      dense.first == 0.0 && dense.count <= 6, "\(dense)")

    // The tap is pointer-only (D7: no Input Monitoring); keyboard input is polled.
    let keys = run([(.keyDown, 0.0), (.flagsChanged, 0.5), (.keyUp, 1.0)])
    check("keyboard events are never tap input", keys.isEmpty, "\(keys)")
    check(
      "the tap asks for no keyboard event type",
      !PointerReports.types.contains { [.keyDown, .keyUp, .flagsChanged].contains($0) })
    check(
      "releases are not input",
      run([(.leftMouseUp, 0.0), (.rightMouseUp, 1.0), (.otherMouseUp, 2.0)]).isEmpty)

    exit(failures == 0 ? 0 : 1)
  }
}

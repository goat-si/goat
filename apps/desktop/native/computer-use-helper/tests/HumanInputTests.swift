// Pure checks of HumanInput.swift's PointerTap, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperInput.test.ts on macOS.

import CoreGraphics
import Foundation

/// Feeds tapped events in time order and collects the times reported.
func run(_ events: [(CGEventType, Double)]) -> [Double] {
  events.compactMap { PointerTap.report($0.0, at: $0.1) }
}

@main
struct HumanInputTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
      print((ok ? "ok   " : "FAIL ") + name + (ok ? "" : ": " + detail()))
      if !ok { failures += 1 }
    }

    // A person's click, then an agent's click within the same quarter second (#1488).
    let mixed = run([(.leftMouseDown, 0.10), (.leftMouseDown, 0.24)])
    check(
      "a person's click just before an agent's click is reported with its own time",
      mixed.contains { abs($0 - 0.10) < 1e-9 }, "\(mixed)")

    // No press is dropped, however close together or near an agent's calls (review of #1504).
    let presses = [1.050, 1.550, 1.620, 1.700, 1.740]
    let all = run(presses.map { (.leftMouseDown, $0) } + [(.rightMouseDown, 1.8), (.otherMouseDown, 1.81)])
    check("every press is reported, none held back", all == presses + [1.8, 1.81], "\(all)")

    // Only presses come from the tap; the rest is polled.
    let others = run([
      (.mouseMoved, 0.0), (.leftMouseDragged, 0.1), (.scrollWheel, 0.2), (.leftMouseUp, 0.3),
      (.keyDown, 0.4), (.flagsChanged, 0.5), (.keyUp, 0.6),
    ])
    check("moves, drags, scrolls, releases and keys are not tap input", others.isEmpty, "\(others)")
    check(
      "the tap asks for presses only, never a keyboard type",
      Set(PointerTap.types.map(\.rawValue))
        == Set([CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown].map(\.rawValue)))

    exit(failures == 0 ? 0 : 1)
  }
}

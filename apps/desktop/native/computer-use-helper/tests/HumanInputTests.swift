// Pure checks of HumanInput.swift's InputReports, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperInput.test.ts on macOS.

import CoreGraphics
import Foundation

/// Feeds events in time order and collects what is reported.
func run(_ events: [(CGEventType, Double)]) -> [(source: String, at: Double)] {
  var reports = InputReports()
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

    // A person's key, then an agent's typing within the same quarter second (#1488).
    let mixed = run([(.keyDown, 0.10), (.keyDown, 0.16), (.keyDown, 0.20), (.keyDown, 0.24)])
    check(
      "a person's key just before an agent's typing is reported with its own time",
      mixed.contains { $0.source == "keyboard" && abs($0.at - 0.10) < 1e-9 },
      "\(mixed)")

    let spaced = run([(.keyDown, 0.0), (.keyDown, 0.15), (.keyDown, 0.30)])
    check(
      "keys apart from each other are each reported",
      spaced.map(\.at) == [0.0, 0.15, 0.30], "\(spaced)")

    let dense = run((0...100).map { (CGEventType.mouseMoved, Double($0) * 0.01) })
    check(
      "a dense run is reported from its first event, then at most every 250 ms",
      dense.first?.at == 0.0 && dense.count <= 6, "\(dense)")

    // A run of one kind does not hold back the other kind's first event.
    let both = run([(.mouseMoved, 0.0), (.mouseMoved, 0.02), (.keyDown, 0.03), (.mouseMoved, 0.04)])
    check(
      "a key in the middle of pointer moves is reported",
      both.contains { $0.source == "keyboard" && abs($0.at - 0.03) < 1e-9 }, "\(both)")

    check(
      "releases and other events are not input of a kind",
      InputReports.source(of: .keyUp) == nil && InputReports.source(of: .leftMouseUp) == nil)
    check(
      "the tap listens for exactly the kinds it reports",
      Set(InputReports.types.map(\.rawValue)).count == InputReports.types.count
        && InputReports.types.allSatisfy { InputReports.source(of: $0) != nil })

    exit(failures == 0 ? 0 : 1)
  }
}

// Pure checks of HumanInput.swift's InputReports, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperInput.test.ts on macOS.

import CoreGraphics
import Foundation

/// Feeds events in time order, with the helper's 250 ms ticks between them, and collects reports.
func run(_ events: [(CGEventType, Double)], until end: Double) -> [(source: String, at: Double)] {
  var reports = InputReports()
  var out: [(source: String, at: Double)] = []
  var nextTick = 0.25
  for (type, at) in events {
    while nextTick <= at {
      out += reports.tick()
      nextTick += 0.25
    }
    if let report = reports.event(type, at: at) { out.append(report) }
  }
  while nextTick <= end {
    out += reports.tick()
    nextTick += 0.25
  }
  return out
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
    let mixed = run(
      [(.keyDown, 0.10), (.keyDown, 0.16), (.keyDown, 0.20), (.keyDown, 0.24)], until: 0.5)
    check(
      "a person's key just before an agent's typing is reported with its own time",
      mixed.contains { $0.source == "keyboard" && abs($0.at - 0.10) < 1e-9 },
      "\(mixed)")

    let spaced = run([(.keyDown, 0.0), (.keyDown, 0.15), (.keyDown, 0.30)], until: 0.5)
    check(
      "keys apart from each other are each reported",
      spaced.map(\.at) == [0.0, 0.15, 0.30], "\(spaced)")

    let moves = (0...100).map { (CGEventType.mouseMoved, Double($0) * 0.01) }
    let dense = run(moves, until: 1.25)
    check(
      "a dense run is reported from its first event, then at most every 250 ms",
      dense.first?.at == 0.0 && dense.count <= 6, "\(dense)")

    check(
      "releases and other events are not input of a kind",
      InputReports.source(of: .keyUp) == nil && InputReports.source(of: .leftMouseUp) == nil)

    exit(failures == 0 ? 0 : 1)
  }
}

// Pure checks of HumanInput.swift's PointerTap and PolledKind, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperInput.test.ts on macOS.

import CoreGraphics
import Foundation

/// Feeds tapped events in time order and collects the times reported.
func tapped(_ events: [(CGEventType, Double)]) -> [Double] {
  events.compactMap { PointerTap.report($0.0, at: $0.1) }
}

/// Polls a kind every PolledKind.interval, seeing at each poll only the newest event so far, as
/// the system does, and collects the times reported.
func polled(_ events: [Double], until end: Double) -> [Double] {
  var kind = PolledKind(newestAtStart: -.infinity)
  var out: [Double] = []
  var tick = PolledKind.interval
  while tick <= end {
    if let newest = events.filter({ $0 <= tick }).max(), let at = kind.poll(newest: newest) {
      out.append(at)
    }
    tick += PolledKind.interval
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

    // #1488: a person's input right before an agent's of the same kind.
    let moves = tapped([(.mouseMoved, 0.105)] + (0..<30).map { (.mouseMoved, 0.13 + Double($0) * 0.008) })
    check(
      "a person's pointer move just before an agent's moves is reported with its own time",
      moves.first.map { abs($0 - 0.105) < 1e-9 } == true, "\(moves.prefix(3))")
    check("every tapped move is reported, none dropped or merged", moves.count == 31, "\(moves.count)")
    let others = tapped([
      (.leftMouseDragged, 0.0), (.rightMouseDragged, 0.1), (.otherMouseDragged, 0.2),
      (.scrollWheel, 0.3), (.leftMouseDown, 0.4), (.rightMouseDown, 0.5), (.otherMouseDown, 0.6),
    ])
    check("drags, scrolls and presses are each reported", others.count == 7, "\(others)")
    // The driver types about one key every 38 ms.
    let keys = polled([0.105, 0.143, 0.181, 0.219], until: 0.5)
    check(
      "a person's key just before an agent's typing is reported with its own time",
      keys.contains { abs($0 - 0.105) < 1e-9 }, "\(keys)")
    check("each of the agent's keys is seen too", keys.count == 4, "\(keys)")
    check("the same key read twice is reported once", polled([0.105], until: 1.0) == [0.105])

    // What the tap may see (D7: no keyboard), and what is not input.
    check(
      "keyboard events and releases are never tap input",
      tapped([(.keyDown, 0.0), (.keyUp, 0.1), (.flagsChanged, 0.2), (.leftMouseUp, 0.3), (.rightMouseUp, 0.4)])
        .isEmpty)
    check(
      "the tap asks for no keyboard type",
      !PointerTap.types.contains { [.keyDown, .keyUp, .flagsChanged].contains($0) })
    check(
      "driver-tagged pointer events carry the GOAT eventSourceUserData constant and are skipped",
      PointerTap.driverEventUserData == 0x474F_4154_4355_4131
        && PointerTap.isDriverOwned(userData: PointerTap.driverEventUserData)
        && !PointerTap.isDriverOwned(userData: 0)
        && PointerTap.report(.mouseMoved, userData: PointerTap.driverEventUserData, at: 0.25) == nil
        && PointerTap.report(.leftMouseDown, userData: PointerTap.driverEventUserData, at: 0.30) == nil
        && PointerTap.report(.mouseMoved, userData: 0, at: 0.25) == 0.25
        && PointerTap.report(.leftMouseDown, userData: 42, at: 0.30) == 0.30)

    exit(failures == 0 ? 0 : 1)
  }
}

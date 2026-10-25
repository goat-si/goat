// Pure checks of OverlayOrder.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperOverlay.test.ts on macOS.

import CoreGraphics
import Foundation

@main
struct OverlayOrderTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }
    func window(_ id: CGWindowID, pid: Int, layer: Int = 0, size: CGFloat = 400)
      -> OverlayListedWindow
    {
      OverlayListedWindow(windowId: id, pid: pid, layer: layer, width: size, height: size)
    }
    let own = 99
    func raises(_ target: CGWindowID, frontmost: Int?, _ windows: [OverlayListedWindow]) -> Bool {
      OverlayOrder.raisesToFront(target: target, frontmostPid: frontmost, ownPid: own, windows: windows)
    }

    check(
      "a target behind another app's window is not raised, so that window keeps covering it",
      !raises(2, frontmost: 10, [window(1, pid: 10), window(2, pid: 20)]))
    check(
      "a target in an app that is not frontmost is not raised",
      !raises(2, frontmost: 10, [window(2, pid: 20), window(1, pid: 10)]))
    check(
      "the frontmost app's front window is raised",
      raises(1, frontmost: 10, [window(1, pid: 10), window(2, pid: 20)]))
    check(
      "a frontmost app's window behind one of its own windows is not raised",
      !raises(2, frontmost: 10, [window(1, pid: 10), window(2, pid: 10)]))
    check(
      "the overlay's own window in front does not count",
      raises(1, frontmost: 10, [window(7, pid: own), window(1, pid: 10)]))
    check(
      "menu bar, Dock and floating windows (layer above 0) in front do not count",
      raises(1, frontmost: 10, [window(5, pid: 10, layer: 25), window(1, pid: 10)]))
    check(
      "a tiny window of the same app in front does not count",
      raises(1, frontmost: 10, [window(5, pid: 10, size: 1), window(1, pid: 10)]))
    check(
      "a floating (non-zero layer) target is never raised",
      !raises(1, frontmost: 10, [window(1, pid: 10, layer: 3)]))
    check("a target missing from the list is not raised", !raises(3, frontmost: 10, [window(1, pid: 10)]))
    check("no frontmost app means no raise", !raises(1, frontmost: nil, [window(1, pid: 10)]))

    exit(failures == 0 ? 0 : 1)
  }
}

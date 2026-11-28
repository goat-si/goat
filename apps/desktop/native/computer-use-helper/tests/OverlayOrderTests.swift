// Pure checks of OverlayOrder.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperOverlay.test.ts on macOS.

import CoreGraphics
import Darwin
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

    func stacked(_ windows: [OverlayListedWindow]) -> Bool {
      OverlayOrder.isStacked(overlay: 7, target: 1, ownPid: own, windows: windows)
    }
    check(
      "an overlay directly in front of its target needs no reordering",
      stacked([window(2, pid: 20), window(7, pid: own), window(1, pid: 10)]))
    check(
      "an overlay behind its target is reordered",
      !stacked([window(1, pid: 10), window(7, pid: own)]))
    check(
      "another app's window between the overlay and its target is reordered",
      !stacked([window(7, pid: own), window(2, pid: 20), window(1, pid: 10)]))
    check(
      "tiny or floating windows between the overlay and its target do not count",
      stacked([
        window(7, pid: own), window(3, pid: 20, size: 1), window(4, pid: 20, layer: 3),
        window(1, pid: 10),
      ]))
    check(
      "an overlay missing from the list (ordered out) is reordered",
      !stacked([window(1, pid: 10)]))

    check("overlay line buffer default cap is 1 MiB", OverlayLineBuffer.maxBytes == 1_048_576)

    do {
      var buffer = OverlayLineBuffer(limit: 8)
      let first = Array("abc\nde".utf8)
      let second = Array("f\n12345678\n".utf8)
      let lines1 = buffer.append(first[...])
      let lines2 = buffer.append(second[...])
      check(
        "overlay line buffer splits multi-line and cross-chunk frames up to the limit",
        lines1 == [Data("abc".utf8)]
          && lines2 == [Data("def".utf8), Data("12345678".utf8)]
          && buffer.bytes.isEmpty)
    }

    do {
      var buffer = OverlayLineBuffer(limit: 8)
      let part1 = Array("12345678".utf8)
      let part2 = Array("9".utf8)
      let lines1 = buffer.append(part1[...])
      let lines2 = buffer.append(part2[...])
      check(
        "overlay line buffer clears and rejects an unterminated line exceeding the cap",
        lines1 == [] && lines2 == nil && buffer.bytes.isEmpty)
    }

    do {
      var buffer = OverlayLineBuffer(limit: 8)
      let oversized = Array("123456789\n".utf8)
      let lines = buffer.append(oversized[...])
      check(
        "overlay line buffer clears and rejects a terminated line exceeding the cap",
        lines == nil && buffer.bytes.isEmpty)
    }

    do {
      let payload = Data("{\"ack\":42}\n".utf8)
      var captured: [UInt8] = []
      var step = 0
      var currentError: Int32 = 0
      let outcome = writeAllBytes(
        payload,
        writeChunk: { ptr, len in
          step += 1
          if step == 2 {
            currentError = EINTR
            return -1
          }
          let take = min(len, 3)
          let slice = UnsafeRawBufferPointer(start: ptr, count: take)
          captured.append(contentsOf: slice)
          return take
        },
        lastError: { currentError })
      check(
        "writeAllBytes retries EINTR and finishes partial writes in order",
        outcome.ok && outcome.errorCode == 0 && captured == Array(payload))
    }

    do {
      let payload = Data("{\"ack\":1}\n".utf8)
      let outcome = writeAllBytes(
        payload,
        writeChunk: { _, _ in -1 },
        lastError: { EPIPE })
      check(
        "writeAllBytes returns EPIPE without looping forever",
        !outcome.ok && outcome.errorCode == EPIPE)
    }

    do {
      let payload = Data("x".utf8)
      let zeroOutcome = writeAllBytes(
        payload,
        writeChunk: { _, _ in 0 },
        lastError: { 0 })
      let emptyOutcome = writeAllBytes(
        Data(),
        writeChunk: { _, _ in -1 },
        lastError: { EPIPE })
      check(
        "writeAllBytes fails on zero-byte write and succeeds on empty payload",
        !zeroOutcome.ok && zeroOutcome.errorCode == EPIPE && emptyOutcome.ok
          && emptyOutcome.errorCode == 0)
    }

    exit(failures == 0 ? 0 : 1)
  }
}

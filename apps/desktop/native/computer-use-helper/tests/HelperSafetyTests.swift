// Pure checks of HelperSafety.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperSafety.test.ts on macOS.

import ApplicationServices
import CoreGraphics
import Foundation

@main
struct HelperSafetyTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }

    check("a focus read refused for a missing or stale grant is unknown", HelperSafety.focusReadIsUnknown(.apiDisabled))
    check("a focus read the app could not complete is unknown", HelperSafety.focusReadIsUnknown(.cannotComplete))
    check("nothing focused is a readable answer", !HelperSafety.focusReadIsUnknown(.noValue))
    check("a successful focus read is a readable answer", !HelperSafety.focusReadIsUnknown(.success))

    check("an unknown focus keeps every window private", HelperSafety.isPrivate(.unknown, targetPid: 7))
    check("a secure field in the target app is private", HelperSafety.isPrivate(.secure(pid: 7, windowId: 3), targetPid: 7))
    check("a secure field in another app leaves the target capturable", !HelperSafety.isPrivate(.secure(pid: 8, windowId: 3), targetPid: 7))
    check("no secure field leaves the target capturable", !HelperSafety.isPrivate(.none, targetPid: 7))

    // #1695: an unreadable focus that paused agents stalled the whole host on every tick.
    check("an unreadable focus pauses no agent", HelperSafety.pausingWindow(.unknown) == nil)
    check("nothing focused pauses no agent", HelperSafety.pausingWindow(.none) == nil)
    check("a focused secure field pauses agents for its own window",
      HelperSafety.pausingWindow(.secure(pid: 7, windowId: 3)).map { $0.pid == 7 && $0.windowId == 3 } == true)

    check("a listed window set is not refused", HelperSafety.shareableContentRefusal(contentPresent: true, errorCode: nil) == nil)
    check("a Screen Recording refusal says so, not that the window closed",
      HelperSafety.shareableContentRefusal(contentPresent: false, errorCode: -3801) == "screenRecordingNotGranted")
    check("any other lookup failure is a capture failure, not a closed window",
      HelperSafety.shareableContentRefusal(contentPresent: false, errorCode: -3805) == "captureFailed")
    check("a lookup failure without an error is a capture failure",
      HelperSafety.shareableContentRefusal(contentPresent: false, errorCode: nil) == "captureFailed")

    check("a window marked on screen is on screen", HelperSafety.isOnScreen([kCGWindowIsOnscreen as String: true]))
    check("a minimized or other-Space window (no on-screen key) is not on screen", !HelperSafety.isOnScreen([:]))
    check("a window marked off screen is not on screen", !HelperSafety.isOnScreen([kCGWindowIsOnscreen as String: false]))

    check(
      "post-capture check refuses a missing window as windowGone",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: nil, expectedPid: 42, expectedWindowId: 9, isOwnedByHost: { _ in false })
        == "windowGone")
    check(
      "post-capture check refuses a missing owner pid as windowGone",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: [kCGWindowNumber as String: 9], expectedPid: 42, expectedWindowId: 9,
        isOwnedByHost: { _ in false }) == "windowGone")
    check(
      "post-capture check refuses a mismatched window number as windowGone",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: [kCGWindowNumber as String: 10, kCGWindowOwnerPID as String: 42],
        expectedPid: 42, expectedWindowId: 9, isOwnedByHost: { _ in false }) == "windowGone")
    check(
      "post-capture check refuses a changed owner pid as windowGone",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: [kCGWindowNumber as String: 9, kCGWindowOwnerPID as String: 99],
        expectedPid: 42, expectedWindowId: 9, isOwnedByHost: { _ in false }) == "windowGone")
    check(
      "post-capture check refuses a host-owned window as appNotApproved",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: [kCGWindowNumber as String: 9, kCGWindowOwnerPID as String: 42],
        expectedPid: 42, expectedWindowId: 9, isOwnedByHost: { $0 == 42 }) == "appNotApproved")
    check(
      "post-capture check accepts a matching non-host window",
      HelperSafety.postCaptureWindowRefusal(
        windowInfo: [kCGWindowNumber as String: 9, kCGWindowOwnerPID as String: 42],
        expectedPid: 42, expectedWindowId: 9, isOwnedByHost: { _ in false }) == nil)

    check("missing session dict has no secure input pid", HelperSafety.sessionSecureInputPid(nil) == nil)
    check("empty session dict has no secure input pid", HelperSafety.sessionSecureInputPid([:]) == nil)
    check(
      "zero secure input pid means secure event input is inactive",
      HelperSafety.sessionSecureInputPid([HelperSafety.sessionSecureInputPidKey: 0]) == nil)
    check(
      "negative secure input pid is ignored",
      HelperSafety.sessionSecureInputPid([HelperSafety.sessionSecureInputPidKey: -1]) == nil)
    check(
      "positive Int secure input pid is reported",
      HelperSafety.sessionSecureInputPid([HelperSafety.sessionSecureInputPidKey: 77]) == 77)
    check(
      "positive NSNumber secure input pid is reported",
      HelperSafety.sessionSecureInputPid([HelperSafety.sessionSecureInputPidKey: NSNumber(value: 88)]) == 88)

    check(
      "AXSecureTextField role marks secure field even without subrole",
      HelperSafety.isSecureTextField(role: "AXSecureTextField", subrole: nil))
    check(
      "AXSecureTextField subrole marks secure field",
      HelperSafety.isSecureTextField(role: "AXTextField", subrole: "AXSecureTextField"))
    check(
      "plain AXTextField without secure subrole is not secure",
      !HelperSafety.isSecureTextField(role: "AXTextField", subrole: "AXSearchField"))
    check(
      "nil role and subrole are not secure",
      !HelperSafety.isSecureTextField(role: nil, subrole: nil))

    exit(failures == 0 ? 0 : 1)
  }
}

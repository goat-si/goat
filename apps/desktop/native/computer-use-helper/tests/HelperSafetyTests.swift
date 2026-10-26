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

    exit(failures == 0 ? 0 : 1)
  }
}

// Starts the way the helper service starts (WindowServer.startService, as main.swift does) and
// makes its first window-server call from a plain process with no AppKit, on a background queue.
// Passes only when that call answers; compiled and run by
// apps/desktop/src/cua/ComputerUseHelperFrames.test.ts on macOS. Without the connection being
// opened first, SCContentFilter(desktopIndependentWindow:) and friends abort the whole process
// with "Assertion failed: (did_initialize), function CGS_REQUIRE_INIT" (exit 134), which is what
// killed the helper on its first live-picture tick.

import CoreGraphics
import Foundation
import ScreenCaptureKit

@main
struct WindowServerInitTests {
  static func main() {
    WindowServer.startService {
      let done = DispatchSemaphore(value: 0)
      var filtered = false
      DispatchQueue.global().async {
        if #available(macOS 14.0, *) {
          // Without a Screen Recording grant the call fails before a filter, and the assertion
          // it would hit, can be reached.
          SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
            content, _ in
            if let window = content?.windows.first {
              _ = SCContentFilter(desktopIndependentWindow: window)
              filtered = true
            }
            done.signal()
          }
        } else {
          done.signal()
        }
      }
      // The answer is the pass signal; the bound only turns a lost callback into a failure.
      if done.wait(timeout: .now() + 10) == .timedOut {
        print("FAIL the window server never answered a helper that never started AppKit")
        exit(1)
      }
      print(
        "ok   the window server answers a helper that never started AppKit"
          + (filtered ? "" : " (no window filter built: no Screen Recording grant)"))
      exit(0)
    }
  }
}

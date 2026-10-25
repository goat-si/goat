// Runs the helper service's first window-server call as the service makes it: from a plain
// process with no AppKit, on a background queue. Compiled and run by
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
    WindowServer.connect()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      if #available(macOS 14.0, *) {
        // No grant is needed to reach the assertion; a missing grant only fails the call.
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
          content, _ in
          if let window = content?.windows.first {
            _ = SCContentFilter(desktopIndependentWindow: window)
          }
          done.signal()
        }
      } else {
        done.signal()
      }
    }
    _ = done.wait(timeout: .now() + 10)
    print("ok   the window server answers a helper that never started AppKit")
    exit(0)
  }
}

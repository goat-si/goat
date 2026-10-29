// Starts through WindowServer.startHelper, the entry main.swift consists of, as the disclaimed
// service, then makes the service's first window-server call from a plain process with no AppKit,
// on a background queue. Compiled and run by apps/desktop/src/cua/ComputerUseHelperFrames.test.ts
// on macOS. Without the connection being opened first, SCContentFilter(desktopIndependentWindow:)
// and friends abort the whole process with "Assertion failed: (did_initialize), function
// CGS_REQUIRE_INIT" (exit 134), which is what killed the helper on its first live-picture tick.

import CoreGraphics
import Foundation
import ScreenCaptureKit

func fail(_ message: String) -> Never {
  print("FAIL " + message)
  exit(1)
}

@main
struct WindowServerInitTests {
  static func main() {
    WindowServer.startHelper(
      disclaimed: true,
      mcp: false,
      launcher: { fail("a disclaimed helper ran the launcher") },
      mcpServer: { fail("a helper without --mcp ran the MCP server") },
      service: {
        // Holds on any host; the capture below reaches the assertion only with a grant.
        guard WindowServer.connected else {
          fail("the service started without a window server connection")
        }
        print("ok   the service starts connected to the window server")
        guard #available(macOS 14.0, *) else {
          print("skip ScreenCaptureKit's answer needs macOS 14")
          exit(0)
        }
        let done = DispatchSemaphore(value: 0)
        var outcome = ""
        DispatchQueue.global().async {
          SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
            content, error in
            if let window = content?.windows.first {
              _ = SCContentFilter(desktopIndependentWindow: window)
              outcome = "built a window filter"
            } else if let error {
              outcome = "no window filter: " + error.localizedDescription
            } else {
              outcome = "no window filter: no on-screen windows"
            }
            done.signal()
          }
        }
        // The answer is the pass signal; the bound only turns a lost callback into a failure.
        if done.wait(timeout: .now() + 10) == .timedOut {
          fail("the window server never answered a helper that never started AppKit")
        }
        print("ok   the window server answers a helper that never started AppKit (\(outcome))")
        exit(0)
      }
    )
  }
}

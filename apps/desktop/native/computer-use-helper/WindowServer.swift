// The helper's connection to the window server. A process that never starts AppKit has none until
// a CoreGraphics call opens it, and ScreenCaptureKit and CGWindowList calls do not open it: they
// abort the process with "Assertion failed: (did_initialize), function CGS_REQUIRE_INIT" instead
// (Apple Developer Forums thread 743615; JXA-Cookbook#27). CGMainDisplayID() opens it.

import CoreGraphics

enum WindowServer {
  /// Opens the connection; cheap, and safe to call again.
  static func connect() { _ = CGMainDisplayID() }
}

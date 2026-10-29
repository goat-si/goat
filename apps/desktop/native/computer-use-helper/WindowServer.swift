// The helper's connection to the window server. A process that never starts AppKit has none until
// a CoreGraphics call opens it, and ScreenCaptureKit and CGWindowList calls do not open it: they
// abort the process with "Assertion failed: (did_initialize), function CGS_REQUIRE_INIT" instead
// (Apple Developer Forums thread 743615; JXA-Cookbook#27). CGMainDisplayID() opens it.

import CoreGraphics

enum WindowServer {
  /// Whether this process opened the connection; checks read it without a Screen Recording grant.
  private(set) static var connected = false

  /// Opens the connection; cheap, and safe to call again.
  static func connect() {
    _ = CGMainDisplayID()
    connected = true
  }

  /// The helper's entry. The launcher re-execs itself disclaimed, and the disclaimed process
  /// connects before any capture, window listing or overlay: without it the first live-picture
  /// capture aborted the service (CGS_REQUIRE_INIT).
  static func startHelper(
    disclaimed: Bool,
    mcp: Bool,
    launcher: () -> Never,
    mcpServer: () -> Never,
    service: () -> Never
  ) -> Never {
    guard disclaimed else { launcher() }
    connect()
    if mcp { mcpServer() }
    service()
  }
}

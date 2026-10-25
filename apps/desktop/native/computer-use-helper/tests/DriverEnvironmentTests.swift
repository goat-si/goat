// Checks of DriverEnvironment.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperEnvironment.test.ts on macOS.

import Foundation

@main
struct DriverEnvironmentTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }

    let environment = inheritedDriverEnvironment(
      process: [
        "PATH": "/usr/bin:/bin", "HOME": "/Users/someone", "SECRET_TOKEN": "x",
        "CUA_DRIVER_DISABLE_SCREENCAPTURE": "0", "CUA_DRIVER_RS_TELEMETRY_ENABLED": "true",
      ],
      settable: [
        ["name": "CUA_DRIVER_KEY_GAP_MS", "value": "7"],
        ["name": "CUA_DRIVER_DISABLE_SCREENCAPTURE", "value": "0"],
      ])
    check("keeps the allowlisted names", environment["HOME"] == "/Users/someone")
    check("keeps the host's tuning knobs", environment["CUA_DRIVER_KEY_GAP_MS"] == "7")
    check("drops everything else", environment["SECRET_TOKEN"] == nil)
    check("telemetry stays off", environment["CUA_DRIVER_RS_TELEMETRY_ENABLED"] == "false")
    // The driver's macOS window capture falls back to /usr/sbin/screencapture, which writes the
    // window to a temporary PNG outside GOAT's response checks (#1688) and can ask for the
    // Microphone as the helper (#1588). The fork turns the tool off with this switch.
    check(
      "screencapture is off, whatever the environment or host says",
      environment["CUA_DRIVER_DISABLE_SCREENCAPTURE"] == "1")

    exit(failures == 0 ? 0 : 1)
  }
}

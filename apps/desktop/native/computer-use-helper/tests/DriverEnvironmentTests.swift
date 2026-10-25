import Foundation

@main
struct DriverEnvironmentTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }
    let environment = DriverEnvironment.make(
      inherited: [
        "PATH": "/usr/bin:/bin", "LC_ALL": "en_US.UTF-8", "GOAT_SECRET": "private",
        "CUA_DRIVER_DISABLE_SCREENCAPTURE": "0", "CUA_DRIVER_RS_UPDATE_CHECK": "true",
      ],
      settable: [
        ["name": "CUA_DRIVER_DISABLE_SCREENCAPTURE", "value": "0"],
        ["name": "CUA_DRIVER_RS_UPDATE_CHECK", "value": "true"],
        ["name": "CUA_DRIVER_KEY_GAP_MS", "value": "12"],
        ["name": "GOAT_SECRET", "value": "private"],
      ], hostPid: 4242)
    check("the helper never lets its driver run screencapture (#1588)",
      environment["CUA_DRIVER_DISABLE_SCREENCAPTURE"] == "1")
    check("the host cannot turn update checks back on", environment["CUA_DRIVER_RS_UPDATE_CHECK"] == "false")
    check("unrelated secrets do not reach the driver", environment["GOAT_SECRET"] == nil)
    check("session basics and locale reach the driver", environment["PATH"] == "/usr/bin:/bin" && environment["LC_ALL"] == "en_US.UTF-8")
    check("the host can tune input pacing", environment["CUA_DRIVER_KEY_GAP_MS"] == "12")
    check("the helper owns the embedded driver", environment["CUA_DRIVER_EMBEDDED"] == "1" && environment["CUA_DRIVER_EMBEDDED_HOST_PID"] == "4242")
    exit(failures == 0 ? 0 : 1)
  }
}

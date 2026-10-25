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
    func resolves(_ tool: String, _ path: String?) -> Bool {
      (path ?? "").split(separator: ":").contains {
        FileManager.default.isExecutableFile(atPath: "\($0)/\(tool)")
      }
    }

    let person = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    let inherited = DriverEnvironment.inherited([
      "PATH": person, "HOME": "/Users/someone", "LC_ALL": "en_US.UTF-8", "SECRET_TOKEN": "x",
    ])
    check("keeps the allowlisted names", inherited["HOME"] == "/Users/someone")
    check("keeps the locale", inherited["LC_ALL"] == "en_US.UTF-8")
    check("drops everything else", inherited["SECRET_TOKEN"] == nil)
    // The driver's window capture fallback runs `screencapture` by name (cua-driver 0.37.0
    // platform-macos capture.rs). That Apple tool is entitled to record audio and checks privacy
    // grants against its responsible process, the helper; see #1588.
    check(
      "the driver cannot find screencapture on its search path",
      !resolves("screencapture", inherited["PATH"]))
    check(
      "the driver still finds the system tools it runs by name",
      ["ps", "codesign", "sqlite3"].allSatisfy { resolves($0, inherited["PATH"]) })
    check(
      "a person's own directories do not reach the driver",
      inherited["PATH"].map { !$0.contains("homebrew") && !$0.contains("/usr/local") } ?? false)

    exit(failures == 0 ? 0 : 1)
  }
}

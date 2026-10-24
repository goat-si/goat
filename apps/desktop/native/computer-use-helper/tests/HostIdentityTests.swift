// Pure checks of HostIdentity.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperHost.test.ts on macOS.

import Foundation

@main
struct HostIdentityTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }
    func owns(_ pid: Int, _ bundle: String?) -> Bool {
      HostIdentity.ownsWindow(ownerPid: pid, ownerBundleId: bundle, goatPids: [500, 501])
    }

    check("a window of the app that launched the helper is GOAT's", owns(500, "com.github.Electron"))
    check("a window of a helper process is GOAT's", owns(501, nil))
    for id in [
      "si.goat.desktop", "si.goat.desktop.nightly", "si.goat.desktop.dev",
      "si.goat.desktop.computer-use", "si.goat.desktop.nightly.computer-use",
      "si.goat.desktop.dev.computer-use",
    ] {
      check("a window of \(id) is GOAT's on every channel, whatever its pid", owns(9, id))
    }
    check("another app's window is not GOAT's", !owns(9, "com.apple.calculator"))
    check("a look-alike id is not GOAT's", !owns(9, "si.goat.desktopper"))
    check("a window with no known owner app and another pid is not GOAT's", !owns(9, nil))

    exit(failures == 0 ? 0 : 1)
  }
}

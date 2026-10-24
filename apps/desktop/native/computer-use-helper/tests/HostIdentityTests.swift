// Pure checks of HostIdentity.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperHost.test.ts on macOS.

import Foundation

/// A binary with the given fuse wires after some unrelated bytes.
func binary(_ wires: [(version: UInt8, fuses: String)]) -> [UInt8] {
  var bytes = Array(repeating: UInt8(0x2E), count: 64)
  for wire in wires {
    bytes += ElectronFuses.sentinel + [wire.version, UInt8(wire.fuses.utf8.count)]
      + Array(wire.fuses.utf8) + Array(repeating: 0x2E, count: 16)
  }
  return bytes
}

func verdict(_ bytes: [UInt8]) -> ElectronFuses.Verdict {
  bytes.withUnsafeBytes { ElectronFuses.verdict($0) }
}

@main
struct HostIdentityTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
      print((ok ? "ok   " : "FAIL ") + name + (ok ? "" : ": " + detail()))
      if !ok { failures += 1 }
    }

    // The wire of GOAT as shipped (/Applications/GOAT.app): all three node fuses on (#1352).
    let shipped = verdict(binary([(1, "101100011")]))
    check(
      "a GOAT that can run as Node is refused, naming the fuses that are on",
      shipped == .open(["RunAsNode", "NODE_OPTIONS", "Node inspect arguments"]), "\(shipped)")
    let closed = verdict(binary([(1, "010000011")]))
    check("all three node fuses off is accepted", closed == .closed, "\(closed)")
    let removed = verdict(binary([(1, "r0rr00011")]))
    check("a removed fuse counts as off", removed == .closed, "\(removed)")
    let universal = verdict(binary([(1, "010000011"), (1, "110000011")]))
    check(
      "every architecture's wire must be closed",
      universal == .open(["RunAsNode"]), "\(universal)")
    let inspectOnly = verdict(binary([(1, "010100011")]))
    check(
      "Node inspect arguments alone still refuse",
      inspectOnly == .open(["Node inspect arguments"]), "\(inspectOnly)")
    let short = verdict(binary([(1, "0")]))
    check(
      "a fuse the wire is too short to hold counts as on",
      short == .open(["NODE_OPTIONS", "Node inspect arguments"]), "\(short)")
    check("no wire cannot be judged", verdict(Array(repeating: 0x2E, count: 128)) == .unreadable)
    check("an unknown wire version cannot be judged", verdict(binary([(2, "010000011")])) == .unreadable)
    var cut = binary([(1, "010000011")])
    cut.removeLast(20)
    check("a wire cut short cannot be judged", verdict(cut) == .unreadable, "\(verdict(cut))")

    // GOAT's own windows (#1321).
    let ids = HostIdentity.ownBundleIds(helper: "si.goat.desktop.dev.computer-use")
    check(
      "GOAT's own bundle ids are the helper's and its app's",
      ids == ["si.goat.desktop.dev.computer-use", "si.goat.desktop.dev"], "\(ids)")
    func owns(_ pid: Int, _ bundle: String?) -> Bool {
      HostIdentity.ownsWindow(ownerPid: pid, ownerBundleId: bundle, goatPids: [500, 501], ownBundleIds: ids)
    }
    check("a window of the app that launched the helper is GOAT's", owns(500, "com.github.Electron"))
    check("a window of GOAT's app id is GOAT's, whatever its pid", owns(9, "si.goat.desktop.dev"))
    check("a window of the helper is GOAT's", owns(9, "si.goat.desktop.dev.computer-use"))
    check("another app's window is not GOAT's", !owns(9, "com.apple.calculator"))
    check("a window with no known owner app is not GOAT's by name", !owns(9, nil))

    exit(failures == 0 ? 0 : 1)
  }
}

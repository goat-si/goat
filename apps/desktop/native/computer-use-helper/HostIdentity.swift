// What the helper treats as GOAT itself: the app that launched it, which must not be able to
// run arbitrary JavaScript (#1352), and the windows that are GOAT's own, which the live picture
// never captures (#1321). Pure, so tests/HostIdentityTests.swift can check it.

import Foundation

enum HostIdentity {
  /// Set by the launcher for the service it starts: the pid of the GOAT app that launched it.
  /// The service runs only under its own launcher (launcherIsSelf), so no one else sets it.
  static let hostPidVariable = "GOAT_COMPUTER_USE_HOST_PID"

  /// GOAT's own bundle ids: this helper's, and the app's that the helper's id extends
  /// (si.goat.desktop for si.goat.desktop.computer-use).
  static func ownBundleIds(helper: String) -> Set<String> {
    let suffix = ".computer-use"
    return helper.hasSuffix(suffix) ? [helper, String(helper.dropLast(suffix.count))] : [helper]
  }

  /// Whether a window's owner is GOAT itself: the app that launched the helper, the helper's own
  /// processes, or any app with one of GOAT's bundle ids. Its windows show other sessions and the
  /// agent's own cursor, so a live picture of them would leak those and loop back on itself.
  static func ownsWindow(
    ownerPid: Int, ownerBundleId: String?, goatPids: Set<Int>, ownBundleIds: Set<String>
  ) -> Bool {
    goatPids.contains(ownerPid) || ownerBundleId.map(ownBundleIds.contains) == true
  }
}

/// Electron's fuse wire, read from the parent app's framework (the format @electron/fuses writes:
/// a sentinel, a version byte, a length byte, then one byte per fuse).
enum ElectronFuses {
  static let sentinel = Array("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)
  /// Fuses that each let a launcher run its own JavaScript in the signed app: RunAsNode,
  /// EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments (FuseV1Options).
  static let nodeFuses: [(index: Int, name: String)] = [
    (0, "RunAsNode"), (2, "NODE_OPTIONS"), (3, "Node inspect arguments"),
  ]
  private static let disabled = UInt8(ascii: "0")
  private static let removed = UInt8(ascii: "r")

  enum Verdict: Equatable {
    /// Every node fuse is off or removed in every wire found.
    case closed
    /// These fuses are on, or absent from a wire too short to hold them.
    case open([String])
    /// No wire of a known version: the binary cannot be judged.
    case unreadable
  }

  /// Judges every wire in a binary; a universal binary has one per architecture.
  static func verdict(_ bytes: UnsafeRawBufferPointer) -> Verdict {
    guard let base = bytes.baseAddress else { return .unreadable }
    var open: [String] = []
    var found = false
    var start = 0
    while start < bytes.count,
      let hit = sentinel.withUnsafeBytes({
        memmem(base + start, bytes.count - start, $0.baseAddress, sentinel.count)
      })
    {
      let wire = base.distance(to: UnsafeRawPointer(hit)) + sentinel.count
      start = wire
      guard wire + 1 < bytes.count, bytes[wire] == 1 else { return .unreadable }
      let length = Int(bytes[wire + 1])
      guard wire + 2 + length <= bytes.count else { return .unreadable }
      found = true
      for fuse in nodeFuses where !open.contains(fuse.name) {
        let state = fuse.index < length ? bytes[wire + 2 + fuse.index] : nil
        if state != disabled && state != removed { open.append(fuse.name) }
      }
    }
    if !found { return .unreadable }
    return open.isEmpty ? .closed : .open(open)
  }
}

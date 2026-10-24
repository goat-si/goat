// What the helper treats as GOAT itself, so a live picture never shows it (#1321): its windows
// show other sessions and the agent's own cursor, and capturing them would leak those and loop
// back on itself. Pure, so tests/HostIdentityTests.swift can check it.

import Foundation

enum HostIdentity {
  /// Set by the launcher for the service it starts: the pid of the app that launched it. The
  /// service runs only under its own launcher (launcherIsSelf), and the launcher always sets
  /// this itself, so no one else can.
  static let hostPidVariable = "GOAT_COMPUTER_USE_HOST_PID"

  /// GOAT's bundle ids on every channel: si.goat.desktop and everything under it (nightly, dev,
  /// and each channel's .computer-use helper). A dev helper must not picture a stable GOAT either.
  static func isGoatBundleId(_ bundleId: String) -> Bool {
    bundleId == "si.goat.desktop" || bundleId.hasPrefix("si.goat.desktop.")
  }

  /// Whether a window's owner is GOAT itself: the app that launched the helper, the helper's own
  /// processes, or any app with a GOAT bundle id.
  static func ownsWindow(ownerPid: Int, ownerBundleId: String?, goatPids: Set<Int>) -> Bool {
    goatPids.contains(ownerPid) || ownerBundleId.map(isGoatBundleId) == true
  }
}

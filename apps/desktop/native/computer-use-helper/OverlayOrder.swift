// Where the agent overlay sits in the window server's list (#1214 follow-up). Pure, so
// tests/OverlayOrderTests.swift can check it; Overlay.swift reads the live window list.
//
// The overlay is a normal-level window ordered directly above the agent's target window, so a
// window that covers the target also covers its border and cursor. Pattern from Cua Driver's own
// cursor overlay (trycua/cua, MIT: platform-macos/src/cursor/overlay.rs, dispatch_pin_above).

import CoreGraphics

/// One on-screen window as CGWindowListCopyWindowInfo reports it, front to back.
struct OverlayListedWindow: Equatable {
  let windowId: CGWindowID
  let pid: Int
  let layer: Int
  let width: CGFloat
  let height: CGFloat
}

enum OverlayOrder {
  /// Whether the overlay must also be raised with orderFrontRegardless after ordering it above
  /// the target. macOS 26 can leave a normal-level window from another process behind a target
  /// that is already frontmost even after `order(.above, relativeTo:)`. Raising is safe only
  /// then: for a target in the background it would put the overlay over the person's own app.
  ///
  /// `windows` is front to back. True only when the target is a normal-level (layer 0) window of
  /// the frontmost app and no other normal-level window of that app with a real size is in front
  /// of it. `ownPid` is skipped, so the overlay itself never counts as covering the target.
  static func raisesToFront(
    target: CGWindowID, frontmostPid: Int?, ownPid: Int, windows: [OverlayListedWindow]
  ) -> Bool {
    guard let frontmostPid,
      let found = windows.first(where: { $0.windowId == target }),
      found.layer == 0, found.pid == frontmostPid
    else { return false }
    for window in windows {
      if window.windowId == target { return true }
      if window.pid == ownPid || window.layer != 0 || window.pid != frontmostPid { continue }
      if window.width > 1 && window.height > 1 { return false }
    }
    return false
  }
}

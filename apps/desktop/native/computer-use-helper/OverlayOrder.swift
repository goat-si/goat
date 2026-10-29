// Where the agent overlay sits in the window server's list (#1214 follow-up). Pure, so
// tests/OverlayOrderTests.swift can check it; Overlay.swift reads the live window list.
//
// The overlay is a normal-level window ordered directly above the agent's target window, so a
// window that covers the target also covers its border and cursor. Pattern from Cua Driver's own
// cursor overlay (trycua/cua, MIT: platform-macos/src/cursor/overlay.rs, dispatch_pin_above).

import CoreGraphics
import Foundation

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

protocol OverlaySchedule: AnyObject {
  func cancel()
}

protocol OverlayScheduling {
  func schedule(every: TimeInterval, repeats: Bool, handler: @escaping () -> Void)
    -> OverlaySchedule
}

private final class OverlayTimerSchedule: OverlaySchedule {
  private var timer: Timer?

  init(timer: Timer) { self.timer = timer }

  func cancel() {
    timer?.invalidate()
    timer = nil
  }

  deinit { cancel() }
}

final class OverlayTimerScheduler: OverlayScheduling {
  func schedule(every: TimeInterval, repeats: Bool, handler: @escaping () -> Void)
    -> OverlaySchedule
  {
    OverlayTimerSchedule(
      timer: Timer.scheduledTimer(withTimeInterval: every, repeats: repeats) { _ in handler() })
  }
}

enum OverlayFollowPhase {
  case active
  case resting
}

final class OverlayFollowController {
  private let scheduler: OverlayScheduling
  private let frame: (CGWindowID) -> CGRect?
  private let onFrame: (CGRect?) -> Void
  private let onBorder: (Bool) -> Void
  private var generation = 0
  private var target: CGWindowID?
  private var follow: OverlaySchedule?
  private var idle: OverlaySchedule?

  init(
    scheduler: OverlayScheduling,
    frame: @escaping (CGWindowID) -> CGRect?,
    onFrame: @escaping (CGRect?) -> Void,
    onBorder: @escaping (Bool) -> Void
  ) {
    self.scheduler = scheduler
    self.frame = frame
    self.onFrame = onFrame
    self.onBorder = onBorder
  }

  func show(windowId: CGWindowID, phase: OverlayFollowPhase) {
    generation += 1
    cancelSchedules()
    target = windowId
    onBorder(true)
    let owner = generation
    follow = scheduler.schedule(every: 0.25, repeats: true) { [weak self] in
      guard let self, self.generation == owner, self.target == windowId else { return }
      self.onFrame(self.frame(windowId))
    }
    if phase == .resting {
      idle = scheduler.schedule(every: 2, repeats: false) { [weak self] in
        guard let self, self.generation == owner, self.target == windowId else { return }
        self.target = nil
        self.onBorder(false)
        self.cancelSchedules()
      }
    }
  }

  func hide() {
    generation += 1
    cancelSchedules()
    target = nil
    onBorder(false)
  }

  private func cancelSchedules() {
    follow?.cancel()
    follow = nil
    idle?.cancel()
    idle = nil
  }

  deinit { cancelSchedules() }
}

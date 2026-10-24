// Live pictures of single windows for GOAT's desktop computer use sessions (#1370).
//
// The host names the windows to capture; the server decides those (apps/server/src/preview/
// DesktopFrames.ts) and checks every frame again, so this file only refuses what it can see
// itself: no Screen Recording grant, a window that is gone or belongs to another app, an app the
// control did not approve, a window of GOAT's own, or a secure text field focused in the window's
// app. Each capture is one window on its own (SCContentFilter(desktopIndependentWindow:)), so
// GOAT's windows and the agent cursor overlay never appear behind or over it; a window GOAT owns
// is refused outright, whatever the control approved (#1321).

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The protocol's limits (PREVIEW_SESSION_FRAME_LIMITS in packages/contracts previewSession.ts).
let frameMaxWidth = 480
let frameMinIntervalMs = 500
let frameMaxBytes = 256 * 1024

/// Whether this macOS can capture one window to an image (SCScreenshotManager, macOS 14).
var frameCaptureAvailable: Bool {
  if #available(macOS 14.0, *) { return true }
  return false
}

struct FrameTarget {
  let key: String
  // Kept as sent and compared widened: a value past pid_t or CGWindowID matches no window
  // (windowGone) instead of trapping on a narrowing conversion.
  let pid: Int
  let windowId: Int
  /// Bundle ids the control approved; nil when every app the driver admits is allowed.
  let apps: [String]?
  let maxWidth: Int
  let intervalMs: Int

  init?(_ object: [String: Any]) {
    guard let key = object["key"] as? String, !key.isEmpty,
      let pid = object["pid"] as? Int, pid > 0,
      // Window 0 is valid on the wire and simply matches no window: windowGone, not a bad request.
      let windowId = object["windowId"] as? Int, windowId >= 0,
      let maxWidth = object["maxWidth"] as? Int, maxWidth > 0,
      let intervalMs = object["intervalMs"] as? Int, intervalMs > 0
    else { return nil }
    if let apps = object["apps"], !(apps is [String]) { return nil }
    self.key = key
    self.pid = pid
    self.windowId = windowId
    self.apps = object["apps"] as? [String]
    self.maxWidth = min(maxWidth, frameMaxWidth)
    self.intervalMs = max(intervalMs, frameMinIntervalMs)
  }
}

/**
 * Captures each requested window every interval until the host replaces or clears the request.
 * A request replaces the previous one whole; nothing captured for an older request is sent after
 * the newer one is answered. A reason for no picture is sent once per change.
 */
final class FrameCapture {
  let queue = DispatchQueue(label: "si.goat.computer-use.frames")
  private var framesId: Int?
  private var timers: [String: DispatchSourceTimer] = [:]
  private var busy: Set<String> = []
  private var told: [String: String] = [:]
  /// GOAT's own processes: the app that launched this helper, its launcher, and this service.
  private let goatPids: Set<Int> = Set(
    [
      Int(ProcessInfo.processInfo.environment[HostIdentity.hostPidVariable] ?? ""),
      Int(getppid()), Int(getpid()),
    ].compactMap { $0 }.filter { $0 > 1 })

  private func goatOwns(pid: Int, bundleId: String?) -> Bool {
    HostIdentity.ownsWindow(
      ownerPid: pid,
      ownerBundleId: bundleId
        ?? NSRunningApplication(processIdentifier: pid_t(clamping: pid))?.bundleIdentifier,
      goatPids: goatPids)
  }

  func frames(_ params: [String: Any]) throws -> [String: Any] {
    guard let framesId = params["framesId"] as? Int,
      let list = params["targets"] as? [[String: Any]]
    else { throw HelperError(code: "bad_request", message: "frames needs a framesId and targets.") }
    let targets = try list.map { object -> FrameTarget in
      guard let target = FrameTarget(object) else {
        throw HelperError(code: "bad_request", message: "A frames target is malformed.")
      }
      return target
    }
    queue.sync {
      stopOnQueue()
      self.framesId = framesId
      for target in targets {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(target.intervalMs))
        source.setEventHandler { [weak self] in self?.tick(target, framesId: framesId) }
        source.resume()
        timers[target.key] = source
      }
    }
    return ["framesId": framesId]
  }

  /// Stops every capture; safe to call when none runs.
  func end() { queue.sync { stopOnQueue() } }

  private func stopOnQueue() {
    for timer in timers.values { timer.cancel() }
    timers = [:]
    busy = []
    told = [:]
    framesId = nil
  }

  private func tick(_ target: FrameTarget, framesId: Int) {
    guard self.framesId == framesId, !busy.contains(target.key) else { return }
    // Before anything else, so no grant or lookup is ever spent on GOAT's own windows.
    if goatOwns(pid: target.pid, bundleId: nil) {
      return unavailable(target, "appNotApproved", framesId: framesId)
    }
    if !CGPreflightScreenCaptureAccess() {
      return unavailable(target, "screenRecordingNotGranted", framesId: framesId)
    }
    guard #available(macOS 14.0, *) else {
      return unavailable(target, "unsupported", framesId: framesId)
    }
    if isPrivate(target) { return unavailable(target, "private", framesId: framesId) }
    busy.insert(target.key)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) {
      [weak self] content, _ in
      guard let self else { return }
      self.queue.async {
        // A replaced request's lookup touches nothing: busy belongs to the request in force.
        guard self.framesId == framesId else { return }
        guard let window = content?.windows.first(where: { Int($0.windowID) == target.windowId }),
          let owner = window.owningApplication, Int(owner.processID) == target.pid
        else {
          self.busy.remove(target.key)
          return self.unavailable(target, "windowGone", framesId: framesId)
        }
        if self.goatOwns(pid: target.pid, bundleId: owner.bundleIdentifier)
          || target.apps.map({ !$0.contains(owner.bundleIdentifier) }) == true
        {
          self.busy.remove(target.key)
          return self.unavailable(target, "appNotApproved", framesId: framesId)
        }
        // Focus can move into a secret field while the window was looked up.
        if self.isPrivate(target) {
          self.busy.remove(target.key)
          return self.unavailable(target, "private", framesId: framesId)
        }
        self.capture(window, target, framesId: framesId)
      }
    }
  }

  /// A secure text field has focus in the window's app; its windows are not pictured at all.
  private func isPrivate(_ target: FrameTarget) -> Bool {
    guard let secure = focusedSecureField() else { return false }
    return secure.pid == target.pid
  }

  @available(macOS 14.0, *)
  private func capture(_ window: SCWindow, _ target: FrameTarget, framesId: Int) {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let frame = window.frame
    let width = max(1, min(target.maxWidth, Int(frame.width * 2)))
    let height = max(1, Int((Double(width) * frame.height / max(frame.width, 1)).rounded()))
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) {
      [weak self] image, _ in
      guard let self else { return }
      let data = image.flatMap(jpeg)
      self.queue.async {
        // A replaced request's capture neither clears the new one's busy flag nor says anything.
        guard self.framesId == framesId else { return }
        self.busy.remove(target.key)
        // And once more as it is sent: a secret field focused during the capture drops it.
        if self.isPrivate(target) { return self.unavailable(target, "private", framesId: framesId) }
        guard let image, let data else {
          return self.unavailable(target, "captureFailed", framesId: framesId)
        }
        self.told[target.key] = nil
        emit([
          "type": "frame", "framesId": framesId, "key": target.key,
          "width": image.width, "height": image.height, "data": data.base64EncodedString(),
        ])
      }
    }
  }

  private func unavailable(_ target: FrameTarget, _ reason: String, framesId: Int) {
    guard told[target.key] != reason else { return }
    told[target.key] = reason
    emit(["type": "frameUnavailable", "framesId": framesId, "key": target.key, "reason": reason])
  }
}

/// JPEG bytes within the frame size limit, lowering quality once before giving up.
func jpeg(_ image: CGImage) -> Data? {
  for quality in [0.6, 0.35] {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    if data.length <= frameMaxBytes { return data as Data }
  }
  return nil
}

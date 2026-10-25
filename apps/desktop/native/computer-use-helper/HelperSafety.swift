// Pure decisions behind the helper's privacy and capture answers, so
// tests/HelperSafetyTests.swift can check them without a window server or grants.

import ApplicationServices
import CoreGraphics
import Foundation

/// What the helper can say about the focused element when deciding private mode.
enum FocusedSecureField: Equatable {
  /// A secure text field has focus, in this window.
  case secure(pid: Int, windowId: Int)
  /// Focus is readable and is not a secure field (or nothing has focus).
  case none
  /// Focus could not be read (Accessibility not effective, or the app did not answer), so a
  /// secure field may have focus unseen. Private mode treats this as private.
  case unknown
}

enum HelperSafety {
  /// Reading the system-wide focused element: kAXErrorNoValue means nothing has focus, which is
  /// a readable answer. Any other error (APIDisabled when the grant is missing or stale,
  /// CannotComplete when the focused app does not answer) leaves the question open, and private
  /// mode must fail closed on it: a missed password field would stream its window.
  static func focusReadIsUnknown(_ error: AXError) -> Bool {
    error != .success && error != .noValue
  }

  /// Whether a capture of the target window must be refused as private.
  static func isPrivate(_ focus: FocusedSecureField, targetPid: Int) -> Bool {
    switch focus {
    case .secure(let pid, _): return pid == targetPid
    case .none: return false
    case .unknown: return true
    }
  }

  /// The frame refusal for a shareable-content lookup. A nil list is never "the window closed":
  /// the error says why it failed (SCStreamError.userDeclined, -3801, is the Screen Recording
  /// refusal even when CGPreflightScreenCaptureAccess reported a grant).
  static func shareableContentRefusal(contentPresent: Bool, errorCode: Int?) -> String? {
    if contentPresent { return nil }
    return errorCode == screenCaptureUserDeclined ? "screenRecordingNotGranted" : "captureFailed"
  }

  /// SCStreamError.Code.userDeclined.
  static let screenCaptureUserDeclined = -3801

  /// The window server lists kCGWindowIsOnscreen only for windows on screen now; a minimized
  /// window or one on another Space has no such key. The overlay draws only over those.
  static func isOnScreen(_ info: [String: Any]) -> Bool {
    info[kCGWindowIsOnscreen as String] as? Bool == true
  }
}

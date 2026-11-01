import Foundation

/// A helper started right after a person turns a grant on can still read it as off for a
/// moment (#1597). Before reporting a grant missing, the helper reads it again on a short,
/// bounded window. Only the first read may prompt; every later read is a silent preflight, so
/// a real denial still ends as missing, just up to one window later.
enum GrantSettle {
  /// Time between reads, in seconds.
  static let step = 0.1
  /// How long a "no" is read again before it counts, per grant, in seconds.
  static let accessibilityWindow = 1.5
  static let screenRecordingWindow = 2.0

  /// Reads both grants. `read` answers one grant; its second argument is whether that read may
  /// prompt. `wait` sleeps for the given seconds between rounds.
  static func read(
    prompt: Bool,
    accessibility: (Bool) -> Bool,
    screenRecording: (Bool) -> Bool,
    wait: (Double) -> Void
  ) -> (accessibility: Bool, screenRecording: Bool) {
    var granted = (accessibility: accessibility(prompt), screenRecording: screenRecording(prompt))
    var waited = 0.0
    while true {
      let readAccessibility = !granted.accessibility && waited < accessibilityWindow - 1e-9
      let readScreen = !granted.screenRecording && waited < screenRecordingWindow - 1e-9
      guard readAccessibility || readScreen else { return granted }
      wait(step)
      waited += step
      if readAccessibility { granted.accessibility = accessibility(false) }
      if readScreen { granted.screenRecording = screenRecording(false) }
    }
  }
}

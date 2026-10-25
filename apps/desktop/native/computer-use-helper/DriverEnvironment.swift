import Foundation

/// The part of the helper's own environment every driver it runs inherits.
enum DriverEnvironment {
  /// Names the daemon inherits, matching the macOS subset of @trycua/cua-driver's embedded host
  /// allowlist. Anything else in the helper's environment is dropped.
  static let inheritedNames: Set<String> = [
    "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CUA_LOG",
  ]

  /// The driver's search path, whatever the person's is. It runs a few system tools by name;
  /// /usr/sbin stays out because its window capture fallback would otherwise start
  /// `/usr/sbin/screencapture`, an Apple tool entitled to record audio whose privacy grants macOS
  /// checks against this helper. It is the likely source of a Microphone prompt that took the
  /// screen during background work (#1588). A failed native capture reports that failure instead.
  static let searchPath = "/usr/bin:/bin"

  static func inherited(_ environment: [String: String]) -> [String: String] {
    var inherited = environment.filter {
      inheritedNames.contains($0.key) || $0.key.hasPrefix("LC_")
    }
    inherited["PATH"] = searchPath
    return inherited
  }
}

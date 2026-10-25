import Foundation

/// The part of the helper's own environment every driver it runs inherits.
enum DriverEnvironment {
  /// Names the daemon inherits, matching the macOS subset of @trycua/cua-driver's embedded host
  /// allowlist. Anything else in the helper's environment is dropped.
  static let inheritedNames: Set<String> = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CUA_LOG",
  ]

  static func inherited(_ environment: [String: String]) -> [String: String] {
    environment.filter { inheritedNames.contains($0.key) || $0.key.hasPrefix("LC_") }
  }
}

import Foundation

enum DriverEnvironment {
  /// Names the daemon inherits, matching the macOS subset of @trycua/cua-driver's embedded host
  /// allowlist. Anything else in the helper's environment is dropped.
  private static let inheritedNames: Set<String> = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CUA_LOG",
  ]
  /// Driver tuning the host may set at launch. No tool argument can change these.
  private static let hostSettableNames: Set<String> = [
    "CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS", "CUA_DRIVER_WINDOW_CHANGE_POLL_MS",
    "CUA_DRIVER_KEY_GAP_MS", "CUA_LOG",
  ]
  /// Telemetry, update checks and the screencapture subprocess stay off whatever the host sets.
  private static let privacyEnvironment = [
    "CUA_DRIVER_RS_TELEMETRY_ENABLED": "false",
    "CUA_TELEMETRY_ENABLED": "false",
    "CUA_DRIVER_RS_UPDATE_CHECK": "false",
    "CUA_DRIVER_DISABLE_SCREENCAPTURE": "1",
  ]

  /// What every driver this helper runs inherits: the allowlisted names, the host's tuning
  /// knobs, privacy switches forced off, and embedded mode under this process.
  static func make(
    inherited: [String: String], settable: [[String: Any]], hostPid: Int32
  ) -> [String: String] {
    var environment: [String: String] = [:]
    for (name, value) in inherited
    where inheritedNames.contains(name) || name.hasPrefix("LC_") {
      environment[name] = value
    }
    for entry in settable {
      guard let name = entry["name"] as? String, let value = entry["value"] as? String,
        hostSettableNames.contains(name)
      else { continue }
      environment[name] = value
    }
    for (name, value) in privacyEnvironment { environment[name] = value }
    environment["CUA_DRIVER_EMBEDDED"] = "1"
    environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = String(hostPid)
    return environment
  }

}

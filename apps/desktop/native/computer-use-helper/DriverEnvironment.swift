import Foundation

/// Names the daemon inherits, matching the macOS subset of @trycua/cua-driver's embedded host
/// allowlist. Anything else in the helper's environment is dropped.
let inheritedNames: Set<String> = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CUA_LOG",
]
/// Driver tuning the host may set at launch. No tool argument can change these.
let hostSettableNames: Set<String> = [
  "CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS", "CUA_DRIVER_WINDOW_CHANGE_POLL_MS",
  "CUA_DRIVER_KEY_GAP_MS", "CUA_LOG",
]
/// Telemetry and the GitHub update check stay off whatever the host or user set.
let privacyEnvironment = [
  "CUA_DRIVER_RS_TELEMETRY_ENABLED": "false",
  "CUA_TELEMETRY_ENABLED": "false",
  "CUA_DRIVER_RS_UPDATE_CHECK": "false",
]

/// What a driver this helper runs inherits from `process` and the host's `settable` knobs, with
/// the forced switches applied last so nothing inherited can turn them back.
func inheritedDriverEnvironment(
  process: [String: String], settable: [[String: Any]]
) -> [String: String] {
  var environment: [String: String] = [:]
  for (name, value) in process where inheritedNames.contains(name) || name.hasPrefix("LC_") {
    environment[name] = value
  }
  for entry in settable {
    guard let name = entry["name"] as? String, let value = entry["value"] as? String,
      hostSettableNames.contains(name)
    else { continue }
    environment[name] = value
  }
  for (name, value) in privacyEnvironment { environment[name] = value }
  return environment
}

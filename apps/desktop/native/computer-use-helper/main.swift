// GOAT Computer Use helper (macOS).
//
// GOAT's desktop host launches this bundle's executable with stdio pipes. The helper becomes its
// own TCC principal, then owns exactly one embedded Cua Driver daemon per launch:
//
// 1. Launcher: verify the parent is signed by this helper's team (dev builds skip this), then
//    re-exec this executable with TCC responsibility disclaimed. Upstream Cua Driver's standalone
//    mode uses the same disclaim pattern; Chromium and LLDB use it for their helpers too.
// 2. Service: speak line-delimited JSON on the inherited stdin/stdout and spawn the bundled
//    "cua-driver serve --embedded" as a direct child, so Accessibility and Screen Recording are
//    attributed to this bundle id instead of GOAT.app or a terminal.
//
// The service only runs the driver inside its own bundle with arguments it builds itself; the
// host chooses the socket path, the capability manifest and a fixed set of environment knobs.

import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import Security

let protocolVersion = 1
let disclaimedVariable = "GOAT_COMPUTER_USE_DISCLAIMED"
let maxLineBytes = 1 << 20
var retained: [AnyObject] = []

// MARK: - Output

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    return
  }
  data.append(0x0A)
  outputLock.lock()
  FileHandle.standardOutput.write(data)
  outputLock.unlock()
}

// MARK: - Code identity

func selfStaticCode() -> SecStaticCode? {
  var code: SecCode?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess else { return nil }
  return staticCode
}

func signingTeam(_ code: SecStaticCode) -> String? {
  var info: CFDictionary?
  let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
  guard SecCodeCopySigningInformation(code, flags, &info) == errSecSuccess,
    let dictionary = info as? [String: Any]
  else { return nil }
  return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
}

func guestCode(pid: pid_t) -> SecCode? {
  var code: SecCode?
  let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else {
    return nil
  }
  return code
}

func satisfies(_ code: SecCode, _ requirementText: String) -> Bool {
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
    == errSecSuccess, let requirement
  else { return false }
  return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

/// Release builds only serve a parent signed by the same Developer ID team. A dev helper
/// (built with GOATComputerUseAllowAnyParent) serves an unpackaged Electron or a terminal.
func parentRefusal() -> String? {
  if Bundle.main.object(forInfoDictionaryKey: "GOATComputerUseAllowAnyParent") as? Bool == true {
    return nil
  }
  guard let own = selfStaticCode(), let team = signingTeam(own) else {
    return "This helper has no Developer ID team, so it cannot verify who launched it."
  }
  guard let parent = guestCode(pid: getppid()),
    satisfies(parent, "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"")
  else {
    return "The process that launched the helper is not signed by team \(team)."
  }
  return nil
}

/// The service half accepts only its own launcher as a parent, so setting the disclaimed
/// variable by hand cannot skip the launcher's parent check.
func launcherIsSelf() -> Bool {
  guard let own = selfStaticCode(), let parent = guestCode(pid: getppid()) else { return false }
  var requirement: SecRequirement?
  guard SecCodeCopyDesignatedRequirement(own, [], &requirement) == errSecSuccess,
    let requirement
  else { return false }
  return SecCodeCheckValidity(parent, [], requirement) == errSecSuccess
}

// MARK: - Launcher

typealias DisclaimFunction = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) ->
  Int32

func refuse(_ reason: String, _ message: String, _ code: Int32) -> Never {
  emit(["type": "refused", "reason": reason, "message": message])
  exit(code)
}

func runLauncher() -> Never {
  if let refusal = parentRefusal() { refuse("untrusted_parent", refusal, 77) }
  // RTLD_DEFAULT; the symbol is private libsystem API, so a missing one is a typed refusal.
  guard
    let symbol = dlsym(
      UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim")
  else { refuse("unsupported", "This macOS cannot give the helper its own permissions.", 78) }
  let disclaim = unsafeBitCast(symbol, to: DisclaimFunction.self)
  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  guard disclaim(&attributes, 1) == 0 else {
    refuse("unsupported", "Disclaiming responsibility failed.", 78)
  }
  var defaults = sigset_t()
  sigemptyset(&defaults)
  for signalNumber in [SIGTERM, SIGINT, SIGHUP, SIGPIPE] { sigaddset(&defaults, signalNumber) }
  posix_spawnattr_setsigdefault(&attributes, &defaults)
  posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGDEF))

  let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
  var environment = ProcessInfo.processInfo.environment
  environment[disclaimedVariable] = "1"
  let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  let argv = [strdup(executable), nil]
  var child: pid_t = 0
  let status = posix_spawn(&child, executable, nil, &attributes, argv, envp)
  envp.forEach { free($0) }
  argv.forEach { free($0) }
  guard status == 0 else {
    refuse("unsupported", "Could not start the helper service (\(status)).", 78)
  }
  // The desktop host signals this process; the service it started must hear it too.
  for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { kill(child, signalNumber) }
    source.resume()
    retained.append(source)
  }
  DispatchQueue.global().async {
    var waitStatus: Int32 = 0
    while waitpid(child, &waitStatus, 0) == -1 && errno == EINTR {}
    let signalled = waitStatus & 0x7f
    exit(signalled == 0 ? (waitStatus >> 8) & 0xff : 128 + signalled)
  }
  dispatchMain()
}

// MARK: - Service

struct HelperError: Error {
  let code: String
  let message: String
}

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

final class DriverService {
  let queue = DispatchQueue(label: "si.goat.computer-use.service")
  let bundleId = Bundle.main.bundleIdentifier ?? ""
  var driver: Process?
  var liveness: Pipe?
  var socketIdentity: (dev: dev_t, ino: ino_t, path: String)?

  var driverPath: String? {
    Bundle.main.resourceURL?.appendingPathComponent("cua-driver/cua-driver").path
  }

  func handle(line: Data) {
    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
      let id = object["id"] as? String, let method = object["method"] as? String
    else {
      emit(["type": "error", "code": "bad_request", "message": "Expected {id, method, params}."])
      return
    }
    let params = object["params"] as? [String: Any] ?? [:]
    do {
      let result: [String: Any]
      switch method {
      case "permissions": result = permissions(prompt: params["prompt"] as? Bool == true)
      case "start": result = try start(params)
      case "stop":
        stop()
        result = [:]
      default: throw HelperError(code: "unknown_method", message: "Unknown method \(method).")
      }
      emit(["id": id, "result": result])
    } catch let error as HelperError {
      emit(["id": id, "error": ["code": error.code, "message": error.message]])
    } catch {
      emit(["id": id, "error": ["code": "internal", "message": "\(error)"]])
    }
  }

  /// Read without prompting unless asked. Both answers are this bundle's own grants; macOS
  /// caches them per process, so the host starts a fresh helper to see a change.
  func permissions(prompt: Bool) -> [String: Any] {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let accessibility = AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
    let screenRecording = prompt ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    return ["accessibility": accessibility, "screenRecording": screenRecording]
  }

  func start(_ params: [String: Any]) throws -> [String: Any] {
    if driver != nil {
      throw HelperError(code: "already_running", message: "The driver is already running.")
    }
    guard let driverPath, FileManager.default.isExecutableFile(atPath: driverPath) else {
      throw HelperError(code: "driver_missing", message: "The helper bundle has no Cua Driver.")
    }
    guard let socketPath = params["socketPath"] as? String, socketPath.hasPrefix("/"),
      socketPath.utf8.count < 104
    else {
      throw HelperError(
        code: "bad_request", message: "socketPath must be an absolute path under 104 bytes.")
    }
    var existing = stat()
    if lstat(socketPath, &existing) == 0 {
      throw HelperError(
        code: "socket_in_use", message: "Something already exists at the socket path.")
    }
    var arguments = [
      "serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate",
      "--socket", socketPath, "--host-bundle-id", bundleId, "--permission-mode", "standard",
    ]
    if let manifest = params["capabilityManifestPath"] as? String {
      guard manifest.hasPrefix("/") else {
        throw HelperError(code: "bad_request", message: "capabilityManifestPath must be absolute.")
      }
      arguments += ["--capability-manifest", manifest, "--approve-capability-manifest"]
    }
    if params["noOverlay"] as? Bool == true { arguments.append("--no-overlay") }

    var environment: [String: String] = [:]
    for (name, value) in ProcessInfo.processInfo.environment
    where inheritedNames.contains(name) || name.hasPrefix("LC_") {
      environment[name] = value
    }
    for entry in params["environment"] as? [[String: Any]] ?? [] {
      guard let name = entry["name"] as? String, let value = entry["value"] as? String,
        hostSettableNames.contains(name)
      else { continue }
      environment[name] = value
    }
    for (name, value) in privacyEnvironment { environment[name] = value }
    environment["CUA_DRIVER_EMBEDDED"] = "1"
    environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = String(getpid())

    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: driverPath)
    process.arguments = arguments
    process.environment = environment
    process.standardInput = pipe
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.standardError
    process.terminationHandler = { [weak self] finished in
      self?.queue.async { self?.driverExited(finished) }
    }
    do { try process.run() } catch {
      throw HelperError(code: "spawn_failed", message: "Could not start Cua Driver: \(error).")
    }
    driver = process
    liveness = pipe

    // Ready once the daemon has bound a private 0600 socket owned by this user; the host then
    // confirms the daemon's own metadata over it.
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      if !process.isRunning {
        let code = process.terminationStatus
        cleanUp()
        throw HelperError(
          code: "exited_before_ready", message: "Cua Driver exited during startup (\(code)).")
      }
      var info = stat()
      if lstat(socketPath, &info) == 0 {
        guard (info.st_mode & S_IFMT) == S_IFSOCK, (info.st_mode & 0o777) == 0o600,
          info.st_uid == getuid()
        else {
          stop()
          throw HelperError(
            code: "socket_untrusted",
            message: "The driver socket is not a private socket owned by this user.")
        }
        socketIdentity = (info.st_dev, info.st_ino, socketPath)
        return [
          "socketPath": socketPath, "driverPid": Int(process.processIdentifier),
          "hostBundleId": bundleId,
        ]
      }
      usleep(50_000)
    }
    stop()
    throw HelperError(
      code: "startup_timeout", message: "Cua Driver did not become ready within 20 seconds.")
  }

  /// Closing the liveness pipe is the daemon's orderly shutdown signal; a daemon that ignores
  /// it is terminated, then killed.
  func stop() {
    guard let process = driver else { return }
    driver = nil
    try? liveness?.fileHandleForWriting.close()
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning && Date() < deadline { usleep(20_000) }
    if process.isRunning { process.terminate() }
    let killDeadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < killDeadline { usleep(20_000) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    process.waitUntilExit()
    cleanUp()
  }

  func cleanUp() {
    if let identity = socketIdentity {
      var info = stat()
      if lstat(identity.path, &info) == 0 && info.st_dev == identity.dev
        && info.st_ino == identity.ino
      {
        unlink(identity.path)
      }
    }
    socketIdentity = nil
    try? liveness?.fileHandleForWriting.close()
    liveness = nil
    driver = nil
  }

  /// A crash the host did not ask for. Orderly stops clear "driver" first and stay silent.
  func driverExited(_ process: Process) {
    guard driver === process else { return }
    cleanUp()
    emit([
      "type": "driverExited", "driverPid": Int(process.processIdentifier),
      "code": Int(process.terminationStatus),
    ])
  }

  func shutDown() -> Never {
    queue.sync { stop() }
    exit(0)
  }
}

func runService() -> Never {
  guard launcherIsSelf() else {
    refuse("untrusted_parent", "Start the helper through its launcher.", 77)
  }
  let service = DriverService()
  for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { service.shutDown() }
    source.resume()
    retained.append(source)
  }
  signal(SIGPIPE, SIG_IGN)
  emit([
    "type": "hello", "protocol": protocolVersion, "pid": Int(getpid()),
    "bundleId": service.bundleId,
    "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
      ?? "",
  ])
  // The host owns this process through stdin: EOF means the host is gone.
  Thread.detachNewThread {
    var buffer = Data()
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { break }
      buffer.append(chunk)
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<newline)
        buffer.removeSubrange(buffer.startIndex...newline)
        if !line.isEmpty { service.queue.sync { service.handle(line: line) } }
      }
      if buffer.count > maxLineBytes {
        emit(["type": "error", "code": "line_too_long", "message": "Request line exceeds 1 MiB."])
        break
      }
    }
    service.shutDown()
  }
  dispatchMain()
}

if ProcessInfo.processInfo.environment[disclaimedVariable] == "1" {
  runService()
} else {
  runLauncher()
}

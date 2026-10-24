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

/// Release builds only serve the GOAT app of their own channel: the same Developer ID team and
/// the bundle identifier this helper's id extends (si.goat.desktop for
/// si.goat.desktop.computer-use). A dev helper (built with GOATComputerUseAllowAnyParent)
/// serves an unpackaged Electron or a terminal.
///
/// This is not enough on its own while GOAT's signed executable can run arbitrary JavaScript
/// with ELECTRON_RUN_AS_NODE; release builds ship the helper only once that is closed (#1210).
func parentRefusal() -> String? {
  if Bundle.main.object(forInfoDictionaryKey: "GOATComputerUseAllowAnyParent") as? Bool == true {
    return nil
  }
  guard let own = selfStaticCode(), let team = signingTeam(own) else {
    return "This helper has no Developer ID team, so it cannot verify who launched it."
  }
  let suffix = ".computer-use"
  guard let ownId = Bundle.main.bundleIdentifier, ownId.hasSuffix(suffix) else {
    return "This helper's bundle identifier does not name its GOAT app."
  }
  let appId = String(ownId.dropLast(suffix.count))
  guard let parent = guestCode(pid: getppid()),
    satisfies(
      parent,
      "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(appId)\""
    )
  else {
    return "The process that launched the helper is not \(appId) signed by team \(team)."
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

/// Nanoseconds on a clock that never jumps with wall-clock changes.
func monotonicNanoseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

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

  /// Checks the helper's sealed bundle, which covers the driver's bytes, right before running
  /// it, and refuses a driver path that is a link or resolves outside the bundle. A same-user
  /// writer could still swap the file between this check and exec; the bundle's location
  /// (inside GOAT.app) is what keeps that writer out.
  func driverRefusal(_ path: String) -> String? {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      return "The bundled Cua Driver is missing or is not a regular file."
    }
    // realpath on both sides: Foundation's symlink resolution drops /private from /private/tmp.
    guard let resolved = realpath(path, nil), let bundleRoot = realpath(Bundle.main.bundlePath, nil)
    else { return "The bundled Cua Driver cannot be resolved." }
    let bundlePath = String(cString: bundleRoot)
    let inside = String(cString: resolved).hasPrefix(bundlePath + "/")
    free(resolved)
    free(bundleRoot)
    guard inside else {
      return "The bundled Cua Driver resolves outside the helper bundle."
    }
    // Validate the running code, not just the files: the dynamic check also compares the
    // kernel's code directory hash for this process with the bundle on disk, so a bundle that
    // was changed and signed again after this helper started is refused too.
    var live: SecCode?
    guard SecCodeCopySelf([], &live) == errSecSuccess, let live else {
      return "The helper cannot read its own signature."
    }
    var liveStatic: SecStaticCode?
    var livePath: CFURL?
    guard SecCodeCopyStaticCode(live, [], &liveStatic) == errSecSuccess, let liveStatic,
      SecCodeCopyPath(liveStatic, [], &livePath) == errSecSuccess, let livePath,
      let liveRoot = realpath((livePath as URL).path, nil)
    else { return "The helper cannot locate its own bundle." }
    let sameBundle = String(cString: liveRoot) == bundlePath
    free(liveRoot)
    guard sameBundle else { return "The running helper is not the bundle its driver comes from." }
    // Dynamic: this process's code directory hash against the disk. Static: the whole sealed
    // bundle, driver bytes included, from that same code object.
    let dynamic = SecCodeCheckValidity(live, [], nil)
    guard dynamic == errSecSuccess else {
      return "The helper bundle no longer matches the running helper (\(dynamic))."
    }
    let flags = SecCSFlags(
      rawValue: kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures)
    let sealed = SecStaticCodeCheckValidity(liveStatic, flags, nil)
    guard sealed == errSecSuccess else {
      return "The helper bundle's signature no longer matches its contents (\(sealed))."
    }
    return nil
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
      case "listApps": result = try listApps()
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
    if let refusal = driverRefusal(driverPath) {
      throw HelperError(code: "driver_untrusted", message: refusal)
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

    let environment = driverEnvironment(params["environment"] as? [[String: Any]] ?? [])

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

/// What every driver this helper runs inherits: the allowlisted names, the host's tuning
  /// knobs, privacy switches forced off, and embedded mode under this process.
  func driverEnvironment(_ settable: [[String: Any]]) -> [String: String] {
    var environment: [String: String] = [:]
    for (name, value) in ProcessInfo.processInfo.environment
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
    environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = String(getpid())
    return environment
  }

  /// The apps the driver can see, for the host's capability manifest. The driver runs only
  /// after the same seal check as start, as a short-lived socket-free process in this helper's
  /// responsibility chain (#1241); listing reads LaunchServices and needs no grant.
  ///
  /// Spawned and reaped here, not through Process: one thread reads with poll() against an
  /// absolute deadline, and the child is signalled only while it is still unreaped, so its pid
  /// cannot have been reused by the time TERM or KILL is sent.
  func listApps() throws -> [String: Any] {
    guard let driverPath, FileManager.default.isExecutableFile(atPath: driverPath) else {
      throw HelperError(code: "driver_missing", message: "The helper bundle has no Cua Driver.")
    }
    if let refusal = driverRefusal(driverPath) {
      throw HelperError(code: "driver_untrusted", message: refusal)
    }
    var toDriver: [Int32] = [-1, -1]
    var fromDriver: [Int32] = [-1, -1]
    guard pipe(&toDriver) == 0 else {
      throw HelperError(code: "spawn_failed", message: "Could not create a pipe for Cua Driver.")
    }
    guard pipe(&fromDriver) == 0 else {
      close(toDriver[0])
      close(toDriver[1])
      throw HelperError(code: "spawn_failed", message: "Could not create a pipe for Cua Driver.")
    }
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, toDriver[0], 0)
    posix_spawn_file_actions_adddup2(&actions, fromDriver[1], 1)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    // Only the three descriptors above reach the driver: not this helper's channel to the
    // desktop, nor a running daemon's liveness pipe.
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
    var environment = driverEnvironment([])
    environment["CUA_DRIVER_PERMISSION_MODE"] = "standard"
    let argv = [driverPath, "mcp", "--direct", "--embedded", "--host-bundle-id", bundleId]
      .map { strdup($0) } + [nil]
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var child: pid_t = 0
    let spawned = posix_spawn(&child, driverPath, &actions, &attributes, argv, envp)
    argv.forEach { free($0) }
    envp.forEach { free($0) }
    close(toDriver[0])
    close(fromDriver[1])
    guard spawned == 0 else {
      close(toDriver[1])
      close(fromDriver[0])
      throw HelperError(code: "spawn_failed", message: "Could not start Cua Driver (\(spawned)).")
    }
    defer {
      close(toDriver[1])
      var status: Int32 = 0
      // TERM, a short grace, then KILL, all before this helper reaps the child, so the pid
      // still names it; then reap it, so it never lingers as a zombie.
      if waitpid(child, &status, WNOHANG) == 0 {
        kill(child, SIGTERM)
        let grace = monotonicNanoseconds() + 1_000_000_000
        var reaped = false
        while monotonicNanoseconds() < grace {
          if waitpid(child, &status, WNOHANG) != 0 {
            reaped = true
            break
          }
          usleep(20_000)
        }
        if !reaped {
          kill(child, SIGKILL)
          while waitpid(child, &status, 0) == -1 && errno == EINTR {}
        }
      }
      close(fromDriver[0])
    }
    signal(SIGPIPE, SIG_IGN)
    func send(_ message: [String: Any]) {
      guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
      data.append(0x0A)
      data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
          let written = write(toDriver[1], bytes.baseAddress! + offset, bytes.count - offset)
          if written < 0 && errno == EINTR { continue }
          if written <= 0 { return }
          offset += written
        }
      }
    }
    // Monotonic, so a clock change cannot stretch or cut the wait.
    let deadline = monotonicNanoseconds() + 15_000_000_000
    var buffer = Data()
    var replies: [Int: [String: Any]] = [:]
    /// Reads until the reply with id arrives, the driver closes its output, or the deadline.
    func reply(_ id: Int) -> [String: Any]? {
      var chunk = [UInt8](repeating: 0, count: 65_536)
      while replies[id] == nil {
        let now = monotonicNanoseconds()
        if now >= deadline { return nil }
        let remainingMs = Int32(min((deadline - now) / 1_000_000, 1000))
        var descriptor = pollfd(fd: fromDriver[0], events: Int16(POLLIN), revents: 0)
        let ready = poll(&descriptor, 1, remainingMs)
        if ready < 0 && errno == EINTR { continue }
        if ready <= 0 { continue }
        let count = read(fromDriver[0], &chunk, chunk.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { return nil }
        buffer.append(contentsOf: chunk[0..<count])
        if buffer.count > maxLineBytes * 4 { return nil }
        while let newline = buffer.firstIndex(of: 0x0A) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let messageId = message["id"] as? Int, messageId == 1 || messageId == 2
          {
            // Only the two replies this exchange asks for are kept, so memory stays bounded.
            replies[messageId] = message
          }
        }
      }
      return replies[id]
    }
    send([
      "jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": [
        "protocolVersion": "2025-06-18", "capabilities": [:] as [String: Any],
        "clientInfo": ["name": "goat-computer-use", "version": "1"],
      ],
    ])
    guard reply(1) != nil else {
      throw HelperError(code: "list_failed", message: "Cua Driver did not start listing apps.")
    }
    send(["jsonrpc": "2.0", "method": "notifications/initialized"])
    send([
      "jsonrpc": "2.0", "id": 2, "method": "tools/call",
      "params": ["name": "list_apps", "arguments": [:] as [String: Any]],
    ])
    guard let answer = reply(2), answer["error"] == nil,
      let result = answer["result"] as? [String: Any], result["isError"] as? Bool != true,
      let structured = result["structuredContent"] as? [String: Any],
      let apps = structured["apps"] as? [Any]
    else {
      throw HelperError(code: "list_failed", message: "Cua Driver could not list apps.")
    }
    return ["apps": apps]
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

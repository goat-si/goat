import Darwin
import Foundation

/// Each direction owns one writer and blocks on backpressure without queueing more frames.
/// Separate pumps keep cancellation readable while output stalls and the driver accepts input.
/// All pumps remain in the session group, so Stop never waits behind a blocked pipe.
func relayMcp(
  toDriver: FileHandle, fromDriver: FileHandle,
  native: McpNativeSession? = nil,
  fail: @escaping (Int32, String) -> Never
) -> DispatchGroup {
  let outputDrained = DispatchGroup()
  outputDrained.enter()
  func pump(_ input: FileHandle, _ output: FileHandle, tail: Bool,
            handle: ((Data) throws -> Void)?, done: @escaping () -> Void) {
    DispatchQueue.global().async {
      defer { done() }
      do {
        try pumpMcpFrames(from: input, to: output, acceptTail: tail, handle: handle)
      } catch is McpFrameError {
        fail(65, "The MCP stream must contain bounded UTF-8 JSON objects, one per line.")
      } catch {
        fail(74, "The MCP transport pipe failed.")
      }
    }
  }
  pump(FileHandle.standardInput, toDriver, tail: false, handle: native.map { owner in { try owner.fromProvider($0) } }) {
    native?.endInput()
    try? toDriver.close()
  }
  pump(fromDriver, FileHandle.standardOutput, tail: true, handle: native.map { owner in { try owner.fromDriver($0) } }) {
    native?.endInput()
    try? fromDriver.close()
    outputDrained.leave()
  }
  return outputDrained
}

// MARK: - Agent connection (D3 amendment 2)

/// Failures in --mcp mode: stdout already belongs to MCP, so the reason goes to stderr and the
/// exit code names it for the proxy (77 parent, 79 driver, 64 arguments, 78 spawn).
func mcpFail(_ code: Int32, _ message: String) -> Never {
  try? FileHandle.standardError.write(contentsOf: Data(("GOAT Computer Use: " + message + "\n").utf8))
  exit(code)
}

/// One agent connection: the bundled driver's MCP server owns its runtime in a direct child of
/// this service, through GOAT-owned pipes. There is no socket, so nothing but the
/// process that launched this helper reaches the driver (#1210). The driver inherits this
/// process's disclaimed responsibility, so macOS charges its grants to this bundle.
func runMcp() -> Never {
  // The launcher this service was started by, captured before anything can re-parent it.
  let launcher = getppid()
  guard launcherIsSelf() else { mcpFail(77, "Start the helper through its launcher.") }
  guard WindowServer.connected else {
    mcpFail(70, "The helper service started without a window server connection.")
  }
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let flag = arguments.firstIndex(of: "--capability-manifest"),
    flag + 1 < arguments.count, arguments[flag + 1].hasPrefix("/")
  else { mcpFail(64, "--mcp needs --capability-manifest with an absolute path.") }
  let service = DriverService()
  // Readiness binds the driver's reported parent to this service. Send our identity before
  // the driver can write to shared stderr; stdout remains exclusively MCP.
  let greeting: [String: Any] = [
    "type": "hello", "protocol": protocolVersion, "pid": Int(getpid()),
    "bundleId": service.bundleId,
  ]
  let launched: SessionDriver
  do {
    // Only the knobs a host may set come from this process's environment; the rest is fixed.
    launched = try launchDriver(
      service, manifestPath: arguments[flag + 1],
      settable: ProcessInfo.processInfo.environment.map { ["name": $0.key, "value": $0.value] },
      beforeSpawn: {
        if let data = try? JSONSerialization.data(withJSONObject: greeting) {
          try? FileHandle.standardError.write(contentsOf: data + Data([0x0A]))
        }
      })
  } catch let error as HelperError {
    mcpFail(["driver_missing", "driver_untrusted"].contains(error.code) ? 79 : 78, error.message)
  } catch { mcpFail(78, "Could not start Cua Driver.") }
  let child = launched.pid
  signal(SIGPIPE, SIG_IGN)
  let terminal = NSLock()
  let terminate: (Int32, String) -> Never = { code, reason in
    terminal.lock()
    kill(child, SIGKILL)
    // Exit only once the driver has: a launcher that found it still running would end its whole
    // group, and the proxy would see a signal instead of this typed code.
    var info = siginfo_t()
    while waitid(P_PID, id_t(child), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
    mcpFail(code, reason)
  }
  let driverWire = McpWire(launched.input, failure: { terminate($0, $1) })
  let providerWire = McpWire(FileHandle.standardOutput, failure: { terminate($0, $1) })
  let native = McpNativeSession(
    driver: driverWire, provider: providerWire,
    manifest: readNativeManifest(arguments[flag + 1]), fail: { terminate($0, $1) })
  let outputDrained = relayMcp(
    toDriver: launched.input, fromDriver: launched.output,
    native: native, fail: terminate)
  // A launcher that dies alone (a crash, a stray SIGKILL) no longer watches the proxy, so this
  // service ends the driver it started. The driver is waited on without reaping below, so
  // `child` names it for as long as this process runs.
  let endDriver = {
    kill(child, SIGKILL)
    exit(137)
  }
  let launcherWatch = DispatchSource.makeProcessSource(
    identifier: launcher, eventMask: .exit, queue: .main)
  launcherWatch.setEventHandler(handler: endDriver)
  launcherWatch.resume()
  retained.append(launcherWatch)
  if getppid() != launcher { endDriver() }
  for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { kill(child, signalNumber) }
    source.resume()
    retained.append(source)
  }
  DispatchQueue.global().async {
    var info = siginfo_t()
    while waitid(P_PID, id_t(child), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
    // Normal exit drains through pipe EOF; Stop and fatal transport errors never wait here.
    outputDrained.wait()
    terminal.lock()
    exit(info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status)
  }
  // The cursor overlay (Overlay.swift) runs AppKit's loop when the proxy opened its channel.
  runOverlayIfConnected(native: native)
  dispatchMain()
}

/// Starts the bundled driver as this service's direct child through GOAT-owned pipes, after the
/// bundle's seal check, with one capability manifest. Only the driver's pipe ends and stderr
/// survive into it, and only host-settable knobs come from settable.
func launchDriver(
  _ service: DriverService, manifestPath: String, settable: [[String: Any]],
  beforeSpawn: () -> Void = {}
) throws -> SessionDriver {
  guard let driverPath = service.driverPath, FileManager.default.isExecutableFile(atPath: driverPath)
  else { throw HelperError(code: "driver_missing", message: "The helper bundle has no Cua Driver.") }
  if let refusal = service.driverRefusal(driverPath) {
    throw HelperError(code: "driver_untrusted", message: refusal)
  }
  let allowed = settable.filter {
    ($0["name"] as? String).map(DriverEnvironment.hostSettableNames.contains) == true
  }
  var environment = service.driverEnvironment(allowed)
  environment["CUA_DRIVER_CAPABILITY_MANIFEST_FILE"] = manifestPath
  environment["CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED"] = "1"
  environment["CUA_DRIVER_PERMISSION_MODE"] = "standard"
  let failed = { (message: String) in HelperError(code: "spawn_failed", message: message) }
  let driverArguments: [String] =
    [driverPath, "mcp", "--direct", "--embedded", "--host-bundle-id", service.bundleId]
  let requests = Pipe()
  let replies = Pipe()
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else {
    throw failed("Could not prepare Cua Driver's pipes.")
  }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard
    posix_spawn_file_actions_adddup2(&actions, requests.fileHandleForReading.fileDescriptor, STDIN_FILENO) == 0,
    posix_spawn_file_actions_adddup2(&actions, replies.fileHandleForWriting.fileDescriptor, STDOUT_FILENO) == 0,
    posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO) == 0
  else { throw failed("Could not prepare Cua Driver's pipes.") }
  var attributes: posix_spawnattr_t?
  guard posix_spawnattr_init(&attributes) == 0 else {
    throw failed("Could not prepare Cua Driver's spawn attributes.")
  }
  defer { posix_spawnattr_destroy(&attributes) }
  guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0 else {
    throw failed("Could not isolate Cua Driver's descriptors.")
  }
  beforeSpawn()
  let argv = driverArguments.map { strdup($0) } + [nil]
  let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  var child: pid_t = 0
  let status = posix_spawn(&child, driverPath, &actions, &attributes, argv, envp)
  argv.forEach { free($0) }
  envp.forEach { free($0) }
  try? requests.fileHandleForReading.close()
  try? replies.fileHandleForWriting.close()
  guard status == 0 else {
    try? requests.fileHandleForWriting.close()
    try? replies.fileHandleForReading.close()
    throw failed("Could not start Cua Driver (\(status)).")
  }
  return SessionDriver(
    pid: child, input: requests.fileHandleForWriting, output: replies.fileHandleForReading)
}

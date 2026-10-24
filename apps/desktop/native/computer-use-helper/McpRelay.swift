import Darwin
import Foundation

/// Each direction owns one writer and blocks on backpressure without queueing more frames.
/// Separate pumps keep cancellation readable while output stalls and the driver accepts input.
/// All pumps remain in the session group, so Stop never waits behind a blocked pipe.
func relayMcp(
  toDriver: FileHandle, fromDriver: FileHandle,
  fail: @escaping (Int32, String) -> Never
) -> DispatchGroup {
  let outputDrained = DispatchGroup()
  outputDrained.enter()
  func pump(_ input: FileHandle, _ output: FileHandle, tail: Bool, done: @escaping () -> Void) {
    DispatchQueue.global().async {
      defer { done() }
      do {
        try pumpMcpFrames(from: input, to: output, acceptTail: tail)
      } catch is McpFrameError {
        fail(65, "The MCP stream must contain bounded UTF-8 JSON objects, one per line.")
      } catch {
        fail(74, "The MCP transport pipe failed.")
      }
    }
  }
  pump(FileHandle.standardInput, toDriver, tail: false) { try? toDriver.close() }
  pump(fromDriver, FileHandle.standardOutput, tail: true) {
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
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let flag = arguments.firstIndex(of: "--capability-manifest"),
    flag + 1 < arguments.count, arguments[flag + 1].hasPrefix("/")
  else { mcpFail(64, "--mcp needs --capability-manifest with an absolute path.") }
  let service = DriverService()
  guard let driverPath = service.driverPath, FileManager.default.isExecutableFile(atPath: driverPath)
  else { mcpFail(79, "The helper bundle has no Cua Driver.") }
  if let refusal = service.driverRefusal(driverPath) { mcpFail(79, refusal) }

  // Only the knobs a host may set come from this process's environment; the rest is fixed.
  let settable = ProcessInfo.processInfo.environment.filter { hostSettableNames.contains($0.key) }
    .map { ["name": $0.key, "value": $0.value] }
  var environment = service.driverEnvironment(settable)
  environment["CUA_DRIVER_CAPABILITY_MANIFEST_FILE"] = arguments[flag + 1]
  environment["CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED"] = "1"
  environment["CUA_DRIVER_PERMISSION_MODE"] = "standard"

  let argv =
    [driverPath, "mcp", "--direct", "--embedded", "--host-bundle-id", service.bundleId].map {
      strdup($0)
    } + [nil]
  let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  var child: pid_t = 0
  let requests = Pipe()
  let replies = Pipe()
  // Only the driver ends of these pipes and stderr survive into the direct child.
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else {
    mcpFail(78, "Could not prepare Cua Driver's pipes.")
  }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard
    posix_spawn_file_actions_adddup2(&actions, requests.fileHandleForReading.fileDescriptor, STDIN_FILENO) == 0,
    posix_spawn_file_actions_adddup2(&actions, replies.fileHandleForWriting.fileDescriptor, STDOUT_FILENO) == 0,
    posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO) == 0
  else { mcpFail(78, "Could not prepare Cua Driver's pipes.") }
  var attributes: posix_spawnattr_t?
  guard posix_spawnattr_init(&attributes) == 0 else {
    mcpFail(78, "Could not prepare Cua Driver's spawn attributes.")
  }
  defer { posix_spawnattr_destroy(&attributes) }
  guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0 else {
    mcpFail(78, "Could not isolate Cua Driver's descriptors.")
  }
  let status = posix_spawn(&child, driverPath, &actions, &attributes, argv, envp)
  argv.forEach { free($0) }
  envp.forEach { free($0) }
  guard status == 0 else { mcpFail(78, "Could not start Cua Driver (\(status)).") }
  try? requests.fileHandleForReading.close()
  try? replies.fileHandleForWriting.close()
  signal(SIGPIPE, SIG_IGN)
  let terminal = NSLock()
  let outputDrained = relayMcp(
    toDriver: requests.fileHandleForWriting, fromDriver: replies.fileHandleForReading,
    fail: { code, reason in
      // Fatal teardown wins over the child-exit waiter awakened by this kill.
      terminal.lock()
      kill(child, SIGKILL)
      mcpFail(code, reason)
    })
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
  runOverlayIfConnected()
  dispatchMain()
}


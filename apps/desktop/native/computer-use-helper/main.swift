// GOAT Computer Use helper (macOS).
//
// GOAT's desktop host launches this bundle's executable with stdio pipes. Its launcher
// verifies the parent and re-execs with TCC responsibility disclaimed. The service answers
// grant, app-listing and observation requests, or runs the bundled driver's direct MCP server
// through GOAT-owned pipes. The driver is this service's child, so macOS attributes its grants to
// this bundle. The host supplies the capability manifest and a fixed set of tuning knobs.

import AppKit
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

/// The code of the process that launched this one, named by its audit token. Nil when the parent
/// cannot be read or is gone.
///
/// A pid reused after the parent exits cannot stand in for it: macOS re-parents an orphan to
/// launchd, so if the parent died at any point before the final getppid() that call no longer
/// returns the pid we looked up, whatever process took that pid. What remains is a parent that
/// exits after the check, which no longer matters. The stronger check, asking the kernel who
/// holds the other end of stdin, is not available: macOS reports peer credentials only for
/// Unix sockets (LOCAL_PEERTOKEN), not pipes.
func parentCode(_ parent: pid_t = getppid()) -> SecCode? {
  // launchd: the launcher is already orphaned, or was started by launchd itself.
  guard parent > 1 else { return nil }
  var task: mach_port_name_t = 0
  guard task_name_for_pid(mach_task_self_, parent, &task) == KERN_SUCCESS else { return nil }
  defer { mach_port_deallocate(mach_task_self_, task) }
  var token = audit_token_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<audit_token_t>.size / MemoryLayout<natural_t>.size)
  let status = withUnsafeMutablePointer(to: &token) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(task, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count)
    }
  }
  guard status == KERN_SUCCESS, audit_token_to_pid(token) == parent else { return nil }
  let data = Data(bytes: &token, count: MemoryLayout<audit_token_t>.size)
  var code: SecCode?
  let attributes = [kSecGuestAttributeAudit: data] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
    // Still the same parent: had it exited, this process would have been re-parented.
    getppid() == parent
  else { return nil }
  return code
}

func satisfies(_ code: SecCode, _ requirementText: String) -> Bool {
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
    == errSecSuccess, let requirement
  else { return false }
  return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

/// Release builds serve any process signed by this helper's own Developer ID team, whatever its
/// identifier: the agent's lease proxy runs as GOAT's Electron `<name> Helper` (#1548), and the
/// standalone server as GOAT's signed CLI runtime. Each of them runs arbitrary JavaScript as Node,
/// so pinning one identifier refuses real parents without making the check stronger. A dev
/// helper (built with GOATComputerUseAllowAnyParent) serves an unpackaged Electron or a terminal.
///
/// This is not enough on its own: GOAT's signed executables run any JavaScript under
/// ELECTRON_RUN_AS_NODE, NODE_OPTIONS or Node inspect arguments (its Electron fuses are on, since
/// GOAT's backend, CLI and lease proxy run it as Node), so any same-user program can pass this
/// check by running its own code as GOAT. The helper does not read the parent's fuses at launch:
/// a check of the framework on disk cannot be tied to the image the parent loaded without copying
/// the whole framework, and could only refuse every signed GOAT today. Closing this (a separate
/// runtime for those, the fuses off, checked when the app is packaged) is #1352.
func parentRefusal(_ parent: pid_t) -> String? {
  codeRefusal(allowsAnyParent ? nil : parentCode(parent), "launched the helper")
}

/// A dev helper (GOATComputerUseAllowAnyParent) serves any process of this user.
let allowsAnyParent =
  Bundle.main.object(forInfoDictionaryKey: "GOATComputerUseAllowAnyParent") as? Bool == true

/// The one signing policy for whoever reaches the helper, a parent or a session socket's peer:
/// signed by this helper's own Developer ID team (see parentRefusal for what that leaves open).
func codeRefusal(_ code: SecCode?, _ role: String) -> String? {
  if allowsAnyParent { return nil }
  guard let own = selfStaticCode(), let team = signingTeam(own) else {
    return "This helper has no Developer ID team, so it cannot verify who \(role)."
  }
  guard let code,
    satisfies(code, "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"")
  else {
    return "The process that \(role) is not signed by GOAT's team \(team)."
  }
  return nil
}

/// A session socket's peer: this user, and, in a release helper, code signed by GOAT's team,
/// read from the kernel's audit token for the connection (LOCAL_PEERTOKEN), never from a pid.
func socketPeerRefusal(_ fd: Int32) -> String? {
  var uid: uid_t = 0
  var gid: gid_t = 0
  guard getpeereid(fd, &uid, &gid) == 0, uid == geteuid() else {
    return "The connection does not come from this user."
  }
  if allowsAnyParent { return nil }
  var token = audit_token_t()
  var length = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0,
    length == socklen_t(MemoryLayout<audit_token_t>.size)
  else { return "The connection's peer cannot be identified." }
  let data = Data(bytes: &token, count: MemoryLayout<audit_token_t>.size)
  var code: SecCode?
  let attributes = [kSecGuestAttributeAudit: data] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else {
    return "The connection's peer cannot be identified."
  }
  return codeRefusal(code, "connected")
}

/// The service half accepts only its own launcher as a parent, so setting the disclaimed
/// variable by hand cannot skip the launcher's parent check.
func launcherIsSelf() -> Bool {
  guard let own = selfStaticCode(), let parent = parentCode() else { return false }
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
  // An agent connection's stdout is MCP; its refusal goes to stderr (see mcpFail).
  if CommandLine.arguments.contains("--mcp") {
    FileHandle.standardError.write(Data(("GOAT Computer Use: " + message + "\n").utf8))
    exit(code)
  }
  emit(["type": "refused", "reason": reason, "message": message])
  exit(code)
}

/// SIGKILL to every other process in this launcher's group, so a driver that handles or ignores
/// SIGTERM cannot outlive its service; killpg would end this launcher too, before it reports
/// the service's exit status. A pid is signalled only while it is still in this group. It settles
/// only on a complete listing whose every member but this launcher was already a zombie at the
/// previous pass's check: a zombie cannot fork, so no living process can be missing from that
/// listing, whatever forked while an earlier SIGKILL was pending. If the group cannot be listed
/// or does not settle within about a second, the whole group, this launcher with it, is killed
/// instead: cleanup matters more than the exit status.
func killGroupMembers() {
  let group = getpgrp()
  /// Members seen as zombies by the previous pass's check, each with its start time. A pid the
  /// kernel reaps and hands to a new member in between starts later, so it never counts.
  var zombies: [pid_t: ProcessStart] = [:]
  for _ in 0..<100 {
    let size = proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(group), nil, 0)
    // Room for members started while the list is read.
    let capacity = max(0, Int(size)) / MemoryLayout<pid_t>.size + 32
    var pids = [pid_t](repeating: 0, count: capacity)
    let filled =
      size > 0
      ? proc_listpids(
        UInt32(PROC_PGRP_ONLY), UInt32(group), &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
      : -1
    guard filled > 0 else { break }
    let count = Int(filled) / MemoryLayout<pid_t>.size
    let members = pids.prefix(count).filter { $0 > 0 && $0 != getpid() }
    // A full buffer may have cut the listing short, so it never settles anything. Each member
    // is read again: it must still be the zombie the previous check saw, not a pid reused since.
    let settled = members.allSatisfy { pid in
      if case .zombie(let start) = processState(pid) { return zombies[pid] == start }
      return false
    }
    if count < capacity && settled { return }
    zombies = [:]
    for pid in members {
      switch processState(pid) {
      case .zombie(let start): zombies[pid] = start
      case .gone: break
      case .living: if getpgid(pid) == group { kill(pid, SIGKILL) }
      }
    }
    // A SIGKILLed process takes a moment to become a zombie; this runs only after a crash.
    usleep(10_000)
  }
  killpg(group, SIGKILL)
}

/// When a process started, which tells it apart from a later process given the same pid.
struct ProcessStart: Equatable {
  let seconds: Int
  let microseconds: Int32
}

enum ProcessState { case living, zombie(ProcessStart), gone }

/// A zombie has exited and waits only to be reaped; a gone pid names no process now. Read with
/// sysctl: proc_pidinfo cannot read a zombie, which has no task left.
func processState(_ pid: pid_t) -> ProcessState {
  var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  // A failed read keeps it living, so it is signalled and listed again rather than trusted.
  guard sysctl(&name, UInt32(name.count), &info, &size, nil, 0) == 0 else { return .living }
  if size == 0 { return .gone }
  guard info.kp_proc.p_stat == SZOMB else { return .living }
  let started = info.kp_proc.p_starttime
  return .zombie(ProcessStart(seconds: started.tv_sec, microseconds: started.tv_usec))
}

/// An agent connection's helper ends with the proxy that started it, however that proxy ends:
/// a driver mid-action reads stdin's end only between calls, so it must not outlive the proxy
/// that enforces its lease. This launcher leads the connection's process group (the proxy
/// starts it detached), so the whole group goes: service and driver too.
func endWithParent(_ parent: pid_t, service: pid_t) {
  // Only a group this launcher leads is safe to end whole; otherwise end what it started.
  let end = {
    if getpgrp() == getpid() { killpg(getpid(), SIGKILL) } else { kill(service, SIGKILL) }
    exit(137)
  }
  let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
  source.setEventHandler(handler: end)
  source.resume()
  retained.append(source)
  // The proxy may have gone at any point since this launcher started: then this process has
  // been re-parented, so getppid() no longer names the parent it was started by.
  if getppid() != parent { end() }
}

func runLauncher() -> Never {
  // The parent this launcher was started by, captured once: every later check compares with it,
  // so a parent that dies before the watch below starts is still noticed.
  let parent = getppid()
  if CommandLine.arguments.contains("--mcp") && parent <= 1 {
    refuse("untrusted_parent", "The process that started this connection is gone.", 77)
  }
  if let refusal = parentRefusal(parent) { refuse("untrusted_parent", refusal, 77) }
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
  // Whatever the inherited environment says: the service learns GOAT's pid only from here.
  environment[HostIdentity.hostPidVariable] = String(parent)
  let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  // The service gets this launch's arguments: --mcp selects the agent connection mode.
  let argv = ([executable] + CommandLine.arguments.dropFirst()).map { strdup($0) } + [nil]
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
  if CommandLine.arguments.contains("--mcp") { endWithParent(parent, service: child) }
  DispatchQueue.global().async {
    // Wait without reaping: the service stays a zombie until this launcher exits, so its PID, and
    // every signal forwarded to it above, can never reach a recycled process.
    var info = siginfo_t()
    while waitid(P_PID, id_t(child), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
    // A service that died alone (a crash, a stray SIGKILL) leaves its drivers behind: one for an
    // agent connection, one per session for the shared service. This launcher still leads the
    // group and is alive, so the group id is still this group's.
    if getpgrp() == getpid() { killGroupMembers() }
    exit(info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status)
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


final class DriverService {
  let queue = DispatchQueue(label: "si.goat.computer-use.service")
  let privateMode = PrivateModeWatch()
  let frames = FrameCapture()
  let bundleId = Bundle.main.bundleIdentifier ?? ""
  /// Agent sessions (ADR-0023 D3 amendment 3); the socket opens with the first one.
  lazy var sessions = AgentSessions(
    launchToken: Data(randomToken().utf8),
    launch: { [unowned self] spec in
      try launchDriver(self, manifestPath: spec.manifestPath, settable: spec.settable)
    },
    report: { emit($0) })
  private var listener: SessionListener?

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
      case "listApps": result = try listApps()
      case "watch": result = try privateMode.watch(params)
      case "unwatch": result = try privateMode.unwatch(params)
      case "openSession": result = try openSession(params)
      case "stopSession": result = ["stopped": stopSession(params)]
      case "closeSession": result = closeSession(params)
      case "frames":
        guard frameCaptureAvailable else {
          throw HelperError(code: "unknown_method", message: "This macOS cannot capture windows.")
        }
        result = try frames.frames(params)
      case "captureCheck":
        guard frameCaptureAvailable else {
          throw HelperError(code: "unknown_method", message: "This macOS cannot capture windows.")
        }
        result = try frames.captureCheck(params)
      default: throw HelperError(code: "unknown_method", message: "Unknown method \(method).")
      }
      emit(["id": id, "result": result])
      // A new watch's first state follows its answer (computerUseProtocol.ts watch ordering).
      if method == "watch" { privateMode.announce() }
    } catch let error as HelperError {
      emit(["id": id, "error": ["code": error.code, "message": error.message]])
    } catch {
      emit(["id": id, "error": ["code": "internal", "message": "\(error)"]])
    }
  }

  /// Read without prompting unless asked. Both answers are this bundle's own grants; macOS
  /// caches them per process, so the host starts a fresh helper to see a change, and a "no"
  /// is read again for a moment before it counts (GrantSettle).
  func permissions(prompt: Bool) -> [String: Any] {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let granted = GrantSettle.read(
      prompt: prompt,
      accessibility: { AXIsProcessTrustedWithOptions([key: $0] as CFDictionary) },
      screenRecording: { $0 ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess() },
      wait: { Thread.sleep(forTimeInterval: $0) })
    return ["accessibility": granted.accessibility, "screenRecording": granted.screenRecording]
  }

  func driverEnvironment(_ settable: [[String: Any]]) -> [String: String] {
    DriverEnvironment.make(
      inherited: ProcessInfo.processInfo.environment, settable: settable, hostPid: getpid())
  }

  /// The apps the driver can see, for the host's capability manifest. The driver runs only
  /// after the same seal check as MCP, as a short-lived socket-free process in this helper's
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
    // desktop.
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
    var environment = driverEnvironment([])
    environment["CUA_DRIVER_PERMISSION_MODE"] = "standard"
    let arguments: [String] = [driverPath, "mcp", "--direct", "--embedded", "--host-bundle-id", bundleId]
    let argv = arguments.map { strdup($0) } + [nil]
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

  func shutDown() -> Never {
    queue.sync {
      privateMode.end()
      frames.end()
      sessions.closeAll()
      listener?.remove()
    }
    exit(0)
  }

  // MARK: Agent sessions

  /// Registers a session the desktop opened for an agent connection. Its token arrives here, on
  /// the launcher-checked stdio channel, and the reply carries this launch's token; neither is
  /// ever logged or written anywhere else.
  func openSession(_ params: [String: Any]) throws -> [String: Any] {
    guard let id = params["sessionId"] as? String, (1...128).contains(id.utf8.count),
      id.utf8.allSatisfy({ $0 == 0x2D || $0 == 0x5F || (0x30...0x39).contains($0)
        || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) }),
      let token = params["token"] as? String, (32...512).contains(token.utf8.count),
      let manifest = params["capabilityManifestPath"] as? String, manifest.hasPrefix("/")
    else {
      throw HelperError(
        code: "bad_request",
        message: "openSession needs a sessionId, a token and an absolute capabilityManifestPath.")
    }
    let settable = (params["environment"] as? [[String: Any]] ?? []).filter {
      ($0["name"] as? String).map(DriverEnvironment.hostSettableNames.contains) == true
    }
    if listener == nil {
      listener = try SessionListener(
        peerRefusal: socketPeerRefusal,
        serve: { [unowned self] fd, sequence, request in serveSession(fd, sequence, request) })
      sessions.fenceAccepts = { [listener] in listener?.fence() ?? 0 }
    }
    try sessions.open(
      id: id, token: Data(token.utf8), spec: AgentSessions.Spec(manifestPath: manifest, settable: settable))
    return [
      "sessionId": id, "socketPath": listener?.path ?? "", "servicePid": Int(getpid()),
      "launch": String(decoding: sessions.launchToken, as: UTF8.self),
    ]
  }

  func stopSession(_ params: [String: Any]) -> Bool {
    guard let id = params["sessionId"] as? String else { return false }
    return sessions.stop(id: id)
  }

  func closeSession(_ params: [String: Any]) -> [String: Any] {
    if let id = params["sessionId"] as? String { sessions.close(id: id) }
    return [:]
  }

  /// One authenticated connection: MCP runs the session's driver, overlay draws its cursor.
  func serveSession(_ fd: Int32, _ sequence: UInt64, _ request: [String: Any]) {
    let refuse = { (refusal: AgentSessions.Refusal) in
      sessionLine(fd, ["type": "refused", "reason": refusal.rawValue])
      close(fd)
    }
    switch request["channel"] as? String {
    case "mcp":
      let attached = sessions.attachMcp(request, sequence: sequence, connection: fd) {
        [sessions] attachment, driver, manifest in
        let end = { (_: Int32, _: String) in sessions.end(attachment) }
        // The provider writer owns a duplicate, closed with it, so a late native write can never
        // reach a descriptor number the relay already closed and the kernel reused.
        let provider = FileHandle(fileDescriptor: dup(fd), closeOnDealloc: true)
        return McpNativeSession(
          driver: McpWire(driver.input, failure: end),
          provider: McpWire(provider, failure: end),
          manifest: manifest, fail: end)
      }
      switch attached {
      case .failure(let refusal): refuse(refusal)
      case .success(let attachment):
        sessionLine(fd, [
          "type": "attached", "channel": "mcp", "servicePid": Int(getpid()),
          "driverPid": Int(attachment.driver?.pid ?? 0), "generation": Int(attachment.generation),
          "bundleId": bundleId,
        ])
        relaySession(attachment, sessions: sessions)
      }
    case "overlay":
      let attached = sessions.attachOverlay(request, sequence: sequence, connection: fd) {
        [sessions] attachment in
        sessionLine(fd, [
          "type": "attached", "channel": "overlay", "servicePid": Int(getpid()),
          "driverPid": Int(attachment.driver?.pid ?? 0), "generation": Int(attachment.generation),
        ])
        return DispatchQueue.main.sync {
          OverlayChannel(channel: fd, closesChannel: true) { [weak sessions] in
            sessions?.native(of: attachment)
          }
        }
      }
      if case .failure(let refusal) = attached { refuse(refusal) }
    default: refuse(.invalid)
    }
  }
}

// MARK: - Private mode (#1235)

/**
 * Watches, only while the host asks, whether a secure text field (a password or passkey prompt)
 * has focus anywhere on this Mac, and reports changes. Never reads what the field holds. An
 * empty target list watches every window; the host narrows it to the lease's apps later.
 */
final class PrivateModeWatch {
  let queue = DispatchQueue(label: "si.goat.computer-use.private-mode")
  var watchId: String?
  var timer: DispatchSourceTimer?
  /// The secure field's window last reported active under watchId. An unreadable focus is not
  /// reported (HelperSafety.pausingWindow).
  var active: (pid: Int, windowId: Int)?

  /// The window a focus answer holds private, or nil when nothing does.
  private func privateTarget(_ focus: FocusedSecureField) -> (pid: Int, windowId: Int)? {
    if HelperSafety.privateModeDisabled { return nil }
    return HelperSafety.pausingWindow(focus)
  }

  func watch(_ params: [String: Any]) throws -> [String: Any] {
    guard let watchId = params["watchId"] as? String, !watchId.isEmpty else {
      throw HelperError(code: "bad_request", message: "watch needs a watchId.")
    }
    queue.sync {
      // The old watch clears what it reported before its replacement answers.
      clear()
      self.watchId = watchId
      if timer == nil {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        source.setEventHandler { [weak self] in self?.tick() }
        source.resume()
        timer = source
      }
    }
    return ["watchId": watchId]
  }

  func unwatch(_ params: [String: Any]) throws -> [String: Any] {
    let watchId = params["watchId"] as? String
    queue.sync {
      guard watchId == nil || watchId == self.watchId else { return }
      stopOnQueue()
    }
    return [:]
  }

  /// Stops watching after clearing what was reported; safe to call when not watching.
  func end() { queue.sync { stopOnQueue() } }

  /// Sends the current state once, active or not, under the watch in force.
  func announce() {
    queue.async { [weak self] in
      guard let self, self.watchId != nil else { return }
      let now = self.privateTarget(focusedSecureField())
      self.active = now
      self.send(active: now != nil, target: now ?? (pid: 0, windowId: 0))
    }
  }

  private func clear() {
    if let previous = active { send(active: false, target: previous) }
    active = nil
  }

  private func stopOnQueue() {
    clear()
    timer?.cancel()
    timer = nil
    watchId = nil
  }

  private func tick() {
    guard watchId != nil else { return }
    let now = privateTarget(focusedSecureField())
    if now?.pid == active?.pid && now?.windowId == active?.windowId { return }
    clear()
    if let now {
      active = now
      send(active: true, target: now)
    }
  }

  private func send(active: Bool, target: (pid: Int, windowId: Int)) {
    guard let watchId else { return }
    emit([
      "type": "event", "watchId": watchId,
      "event": [
        "type": "privateMode", "active": active,
        "target": ["pid": target.pid, "windowId": target.windowId],
      ],
    ])
  }
}

/// Whether a secure text field has focus, and in which window. A focus that cannot be read
/// (a missing or stale Accessibility grant, an app that does not answer) is `.unknown`, which
/// keeps windows out of frames (HelperSafety.isPrivate) but pauses no agent.
func focusedSecureField() -> FocusedSecureField {
  let system = AXUIElementCreateSystemWide()
  var focused: CFTypeRef?
  let read = AXUIElementCopyAttributeValue(
    system, kAXFocusedUIElementAttribute as CFString, &focused)
  if HelperSafety.focusReadIsUnknown(read) { return .unknown }
  guard read == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else {
    return .none
  }
  let element = focused as! AXUIElement
  var subrole: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole) == .success,
    (subrole as? String) == (kAXSecureTextFieldSubrole as String)
  else { return .none }
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success else { return .unknown }
  return .secure(pid: Int(pid), windowId: frontWindow(of: pid) ?? 0)
}

/// The app's frontmost ordinary window: the one its focused field almost always sits in.
func frontWindow(of pid: pid_t) -> Int? {
  guard
    let windows = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  return windows.first { window in
    (window[kCGWindowOwnerPID as String] as? Int) == Int(pid)
      && (window[kCGWindowLayer as String] as? Int) == 0
  }?[kCGWindowNumber as String] as? Int
}

func runService() -> Never {
  guard launcherIsSelf() else {
    refuse("untrusted_parent", "Start the helper through its launcher.", 77)
  }
  // Started any way but WindowServer.startHelper, the first capture would abort the service.
  guard WindowServer.connected else {
    refuse("window_server", "The helper service started without a window server connection.", 70)
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
    // Methods beyond the protocol's first set, so the host never relies on one this build lacks.
    // Agent connections already report a person's input (InputActivity), but "humanInput" is
    // not advertised until a signed helper has been checked live on a real Mac (#1235, D7):
    // advertising it lets unattended turns run.
    "features": (frameCaptureAvailable ? ["watch", "frames", "captureCheck"] : ["watch"])
      + ["sessions"],
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
  // Session overlays are AppKit panels, so the service runs AppKit's loop, which also serves
  // the main dispatch queue the signal sources above use.
  NSApplication.shared.setActivationPolicy(.accessory)
  NSApplication.shared.run()
  dispatchMain()
}

/// 32 bytes from the system CSPRNG, base64url without padding.
func randomToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    fatalError("The system random source failed.")
  }
  return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

WindowServer.startHelper(
  disclaimed: ProcessInfo.processInfo.environment[disclaimedVariable] == "1",
  mcp: CommandLine.arguments.contains("--mcp"),
  launcher: runLauncher,
  mcpServer: runMcp,
  service: runService
)

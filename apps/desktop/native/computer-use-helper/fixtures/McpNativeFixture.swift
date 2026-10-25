import Foundation

// The production AX adapter is deliberately absent from this executable. Any accidental
// default-runtime use must fail rather than inspect the host or request TCC permission.
enum SettleWatchEvent {
  case ready([String]), changed, destroyed, unsupported(String)
}
protocol SettleWatch: AnyObject {
  func start(_ emit: @escaping (SettleWatchEvent) -> Void)
  func check(_ ready: @escaping (Bool) -> Void)
  func cancel()
}
func makeWindowSettleWatch(pid: Int32, windowID: UInt32, permitted: @escaping () -> Bool) -> SettleWatch {
  fatalError("The injected fixture must never construct a live AX observer.")
}

private struct ContractFailure: Error, CustomStringConvertible {
  let description: String
}
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw ContractFailure(description: message) }
}
private func dictionary(_ data: Data) throws -> [String: Any] {
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw ContractFailure(description: "Expected a JSON object")
  }
  return value
}
private func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

private final class ManualClock {
  private final class Alarm {
    let at: Int64
    let order: Int
    let action: () -> Void
    var active = true
    init(_ at: Int64, _ order: Int, _ action: @escaping () -> Void) {
      self.at = at; self.order = order; self.action = action
    }
  }
  var now: Int64 = 0
  private var next = 0
  private var alarms: [Alarm] = []
  func schedule(_ at: Int64, _ action: @escaping () -> Void) -> (() -> Void) {
    next += 1
    let alarm = Alarm(at, next, action)
    alarms.append(alarm)
    return { alarm.active = false }
  }
  func advance(_ to: Int64) throws {
    try require(to >= now, "Manual time cannot move backwards")
    while let alarm = alarms.filter({ $0.active && $0.at <= to }).min(by: {
      $0.at == $1.at ? $0.order < $1.order : $0.at < $1.at
    }) {
      alarm.active = false
      now = alarm.at
      alarm.action()
    }
    now = to
  }
}

private final class FakeWatch: SettleWatch {
  var started = false
  var cancelled = false
  var holdChecks = false
  var allowed = true
  private var checks: [(Bool) -> Void] = []
  var emit: ((SettleWatchEvent) -> Void)?
  func start(_ emit: @escaping (SettleWatchEvent) -> Void) { started = true; self.emit = emit }
  func cancel() { cancelled = true }
  func check(_ ready: @escaping (Bool) -> Void) {
    if holdChecks { checks.append(ready) }
    else { ready(allowed && !cancelled) }
  }
  func completeChecks(_ allowed: Bool) {
    let pending = checks
    checks.removeAll()
    for ready in pending { ready(allowed) }
  }
  // Keep the callback so tests can deliver a callback already queued at cancellation.
  func send(_ event: SettleWatchEvent) { emit?(event) }
}

private final class FakeWriter: McpWriting {
  private struct Queued {
    let data: Data
    let live: () -> Bool
    let done: (Bool) -> Void
  }
  var frames: [Data] = []
  var held = false
  private var closed = false
  private var queued: [Queued] = []
  @discardableResult
  func write(_ frame: Data, live: () -> Bool) throws -> Bool {
    guard live() else { return false }
    frames.append(frame)
    return true
  }
  func enqueue(_ frame: Data, live: @escaping () -> Bool, done: @escaping (Bool) -> Void) {
    guard !closed else { done(false); return }
    queued.append(Queued(data: frame, live: live, done: done))
    if !held { flush() }
  }
  func flush() {
    while !queued.isEmpty {
      let item = queued.removeFirst()
      let written = item.live()
      if written { frames.append(item.data) }
      item.done(written)
    }
  }
  func closeNative() {
    closed = true
    let items = queued
    queued.removeAll()
    for item in items { item.done(false) }
  }
}

private let allowedManifest = """
# Written by GOAT at each driver start. See ADR-0022.
version: 3
resources:
  desktop:
    display: true
  apps:
    - bundle_id: "si.goat.fixture"
allow:
  tools:
    - "get_window_state"

"""

private final class Harness {
  let clock = ManualClock()
  let watch = FakeWatch()
  let driver = FakeWriter()
  let provider = FakeWriter()
  private(set) var watchCount = 0
  private(set) var observedTarget: (Int32, UInt32)?
  private(set) var failures: [String] = []
  var session: McpNativeSession!
  init(manifest: String = allowedManifest, bundle: String? = "si.goat.fixture") {
    session = McpNativeSession(driver: driver, provider: provider,
      manifest: NativeManifest(text: manifest), runtime: SettleRuntime(
        now: { [clock] in clock.now },
        schedule: { [clock] at, action in clock.schedule(at, action) },
        bundleID: { _ in bundle },
        watch: { [unowned self] pid, window, _ in
          self.watchCount += 1
          self.observedTarget = (pid, window)
          return self.watch
        }), fail: { [unowned self] code, message in self.failures.append("\(code): \(message)") })
  }
  func input(_ frame: Data) throws {
    try validateMcpObjectSyntax(frame)
    try session.fromProvider(frame)
    try require(failures.isEmpty, "Native transport failed: \(failures)")
  }
  func call(_ id: Any = "wait", _ tool: String = "wait_for_window_settle",
            _ args: [String: Any] = ["pid": 41, "window_id": 73, "quiet_ms": 200, "timeout_ms": 1000]) throws {
    try input(mcpJSON(["jsonrpc": "2.0", "id": id, "method": "tools/call",
      "params": ["name": tool, "arguments": args]]))
  }
  func ready() { watch.send(.ready(["window", "application"])) }
  func cancel(_ id: Any = "wait") throws {
    try input(mcpJSON(["jsonrpc": "2.0", "method": "notifications/cancelled", "params": ["requestId": id]]))
  }
  func reply(_ index: Int, token: String = "snapshot", invalidated: [String] = [],
             code: String? = nil, rpcCode: Int? = nil, degraded: Bool = false) throws {
    let request = try dictionary(driver.frames[index])
    guard let id = request["id"] else { throw ContractFailure(description: "Driver request has no ID") }
    var envelope: [String: Any] = ["jsonrpc": "2.0", "id": id]
    if let rpcCode {
      envelope["error"] = ["code": rpcCode, "message": "CannotComplete"]
    } else {
      var structured: [String: Any] = ["snapshot_id": token, "invalidated_snapshot_ids": invalidated,
        "tree": "fixture-tree", "degraded": degraded, "pid": 41, "window_id": 73]
      if let code { structured["code"] = code }
      envelope["result"] = ["structuredContent": structured, "isError": code != nil,
        "content": [["type": "text", "text": "fixture sample"],
          ["type": "image", "mimeType": "image/png", "data": "Zml4dHVyZQ=="]]]
    }
    try driverReply(mcpJSON(envelope))
  }
  func driverReply(_ frame: Data) throws {
    try validateMcpObjectSyntax(frame)
    try session.fromDriver(frame)
    try require(failures.isEmpty, "Native transport failed: \(failures)")
  }
  func result(_ index: Int = 0) throws -> [String: Any] {
    try require(provider.frames.count > index, "Missing provider result \(index)")
    return object(try dictionary(provider.frames[index])["result"])
  }
  func detail(_ index: Int = 0) throws -> [String: Any] { object(try result(index)["structuredContent"]) }
  func expectCode(_ code: String, _ index: Int = 0) throws {
    try require(try result(index)["isError"] as? Bool == true, "\(code) must be an MCP tool error")
    try require(try detail(index)["code"] as? String == code, "Expected error \(code), got \(try detail(index))")
  }
  func expectOutcome(_ outcome: String, unavailable: Bool, _ index: Int = 0) throws {
    let detail = try detail(index)
    try require(object(detail["settle"])["outcome"] as? String == outcome, "Expected \(outcome), got \(detail)")
    let sample = object(detail["sample"])
    try require(sample["unavailable"] as? Bool == unavailable, "Incorrect sample availability: \(sample)")
    if unavailable { try require(!(sample["reason"] as? String ?? "").isEmpty, "Unavailable sample requires a reason") }
  }
}

private func fresh() throws {
  let h = Harness()
  try h.call("wait", "wait_for_window_settle", ["pid": 41, "window_id": 73,
    "quiet_ms": 200, "timeout_ms": 1000, "session": "fixture-session"])
  try require(h.watch.started && h.driver.frames.isEmpty, "Subscription readiness must precede the baseline")
  try require(h.observedTarget?.0 == 41 && h.observedTarget?.1 == 73, "Observer must use the exact requested PID/window")
  h.ready()
  try require(h.driver.frames.count == 1, "Ready must dispatch baseline")
  let baseline = object(object(try dictionary(h.driver.frames[0])["params"])["arguments"])
  try require(baseline["pid"] as? Int == 41 && baseline["window_id"] as? Int == 73, "Sample must use the exact observed PID/window")
  try require(baseline["session"] as? String == "fixture-session", "Samples must use the same driver session")
  try h.clock.advance(20)
  try h.reply(0, token: "baseline", invalidated: ["older"])
  try h.clock.advance(199)
  try require(h.driver.frames.count == 1 && h.provider.frames.isEmpty, "Baseline cannot establish settled")
  try h.clock.advance(200)
  try require(h.driver.frames.count == 2, "Quiet must start a fresh final read")
  try h.clock.advance(210)
  try h.reply(1, token: "final", invalidated: ["baseline", "older"])
  try h.expectOutcome("settled", unavailable: false)
  let detail = try h.detail()
  try require(detail["snapshot_id"] as? String == "final", "Must retain the actual final snapshot token")
  try require(object(detail["sample"])["started_after_ms"] as? Int == 200, "Fresh sample must start after quiet")
  try require(object(detail["sample"])["completed_after_ms"] as? Int == 210, "Sample completion must reflect the read")
  try require(Set(detail["invalidated_snapshot_ids"] as? [String] ?? []) == ["older", "baseline"], "Withheld invalidations must aggregate")
  let content = try h.result()["content"] as? [[String: Any]] ?? []
  try require(content.contains { $0["type"] as? String == "image" }, "Screenshot content must remain at the reply root")
  try require(h.watch.cancelled, "Settled must detach observer")
  let slow = Harness()
  try slow.call(); slow.ready(); try slow.clock.advance(250)
  try require(slow.driver.frames.count == 1 && slow.provider.frames.isEmpty, "Quiet cannot overlap a second read with a slow baseline")
  try slow.reply(0, token: "slow-baseline")
  try require(slow.driver.frames.count == 2 && slow.provider.frames.isEmpty, "A baseline completing after quiet still requires a new final read")
  try slow.clock.advance(260); try slow.reply(1, token: "fresh-after-slow")
  try slow.expectOutcome("settled", unavailable: false)
  try require(object(try slow.detail()["sample"])["started_after_ms"] as? Int == 250, "A slow baseline cannot supply final start metadata")
}

private func dirtyFinal() throws {
  let h = Harness()
  try h.call(); h.ready(); try h.reply(0, token: "baseline")
  try h.clock.advance(200)
  try h.clock.advance(250); h.watch.send(.changed)
  try h.clock.advance(260); try h.reply(1, token: "dirty", invalidated: ["baseline"])
  try require(h.provider.frames.isEmpty, "An event during the final read invalidates settled")
  try h.clock.advance(449)
  try require(h.driver.frames.count == 2, "Dirty final needs a new quiet interval")
  try h.clock.advance(450)
  try require(h.driver.frames.count == 3, "New quiet interval must start another read")
  try h.clock.advance(460); try h.reply(2, token: "clean", invalidated: ["dirty"])
  try h.expectOutcome("settled", unavailable: false)
  try require(try h.detail()["snapshot_id"] as? String == "clean", "Dirty sample must never escape")
  try require(object(try h.detail()["sample"])["started_after_ms"] as? Int == 450, "Final freshness must use the new quiet interval")
}

private func deadline() throws {
  for phase in ["startup", "baseline", "final"] {
    let h = Harness()
    try h.call()
    if phase != "startup" { h.ready() }
    if phase == "final" { try h.reply(0, token: "baseline"); try h.clock.advance(200) }
    try h.clock.advance(1000)
    try h.expectOutcome("pending", unavailable: true)
    try require(try h.detail()["snapshot_id"] == nil, "Deadline must not reuse a baseline while final is in flight")
    try require(h.watch.cancelled, "Deadline must synchronously detach")
    let outputs = h.provider.frames.count
    h.watch.send(.ready(["late"])); h.watch.send(.changed)
    try h.clock.advance(5000)
    try require(h.provider.frames.count == outputs, "Late observer callbacks cannot produce results")
  }
  let h = Harness()
  try h.call("wait", "wait_for_window_settle", ["pid": 41, "window_id": 73, "quiet_ms": 50, "timeout_ms": 100])
  h.ready(); try h.reply(0, token: "latest")
  try h.clock.advance(50)
  try require(h.driver.frames.count == 1 && h.provider.frames.isEmpty, "An insufficient read budget must await the actual deadline")
  try h.clock.advance(100)
  try h.expectOutcome("pending", unavailable: false)
  try require(try h.detail()["snapshot_id"] as? String == "latest", "Completed post-subscription sample may accompany pending")
}

private let metadataTools = ["health_report", "check_permissions", "get_guide", "list_apps", "list_windows"]

private func recovery(cancel: Bool) throws {
  let h = Harness()
  try h.call(); h.ready(); try h.reply(0, token: "baseline", invalidated: ["old"])
  try h.clock.advance(200)
  if cancel { try h.cancel(); try h.expectCode("cancelled") }
  else { try h.clock.advance(1000); try h.expectOutcome("pending", unavailable: true) }
  let nativeOutputs = h.provider.frames.count
  for (index, tool) in (metadataTools + ["click", "get_window_state", "wait_for_window_settle"]).enumerated() {
    try h.call("busy-\(index)", tool)
    try h.expectCode("busy", nativeOutputs + index)
  }
  try require(h.driver.frames.count == 2, "No tool may pass the outstanding actual-read drain barrier")
  let beforeDrain = h.provider.frames.count
  try h.reply(1, token: "late", invalidated: ["baseline"])
  try require(h.provider.frames.count == beforeDrain, "Actual late read reply must be discarded")
  for (index, tool) in metadataTools.enumerated() {
    let driverIndex = h.driver.frames.count
    try h.call("metadata-\(index)", tool)
    try require(h.driver.frames.count == driverIndex + 1, "Metadata \(tool) is allowed after drain")
    try h.reply(driverIndex)
  }
  let denied = h.provider.frames.count
  try h.call("action", "click"); try h.expectCode("fresh_observation_required", denied)
  try h.call("wrong-window", "get_window_state", ["pid": 41, "window_id": 74])
  try h.expectCode("fresh_observation_required", denied + 1)
  let readIndex = h.driver.frames.count
  try h.call("recover", "get_window_state", ["pid": 41, "window_id": 73, "since": "late",
    "include_accessibility_tree": false, "display_only": true, "full_output": true, "tree_format": "none"])
  let args = object(object(try dictionary(h.driver.frames[readIndex])["params"])["arguments"])
  try require(args["since"] == nil && args["include_accessibility_tree"] as? Bool == true,
    "Recovery must force a full same-target read without since")
  try require(args["display_only"] as? Bool == false && args["full_output"] as? Bool == false && args["tree_format"] as? String == "elements",
    "Recovery must return structured elements instead of a display-only or full-text tree")
  let recoveryOutput = h.provider.frames.count
  try h.reply(readIndex, code: "CannotComplete")
  try h.call("action-after-failed-recovery", "click")
  try h.expectCode("fresh_observation_required", recoveryOutput + 1)
  let retryIndex = h.driver.frames.count
  try h.call("recover-again", "get_window_state", ["pid": 41, "window_id": 73, "since": "baseline"])
  let successfulOutput = h.provider.frames.count
  try h.reply(retryIndex, token: "recovered", invalidated: ["late"])
  try require(Set(try h.detail(successfulOutput)["invalidated_snapshot_ids"] as? [String] ?? []) == ["old", "baseline", "late"],
    "Recovery must surface all invalidations, including the privately drained read")
  let actionIndex = h.driver.frames.count
  try h.call("action-after-recovery", "click")
  try require(h.driver.frames.count == actionIndex + 1, "Action must resume only after successful full recovery")
}

private func cancellation() throws {
  let h = Harness()
  try h.call(); try h.cancel(); try h.expectCode("cancelled")
  h.watch.send(.ready(["late"])); h.watch.send(.changed)
  try h.clock.advance(5000)
  try require(h.driver.frames.isEmpty && h.provider.frames.count == 1, "Cancelled observation cannot start reads or emit later results")
  let queued = Harness()
  try queued.call(); queued.ready(); try queued.reply(0); try queued.clock.advance(200)
  queued.provider.held = true
  try queued.reply(1, token: "undelivered", invalidated: ["queued-old"])
  try queued.cancel()
  queued.provider.flush()
  try require(queued.provider.frames.isEmpty, "Cancellation must invalidate a native result already queued for delivery")
  queued.provider.held = false
  // The provider never saw the sampled tokens, so the next action needs the same recovery fence.
  try queued.call("action", "click"); try queued.expectCode("fresh_observation_required")
  let readIndex = queued.driver.frames.count
  try queued.call("recover", "get_window_state", ["pid": 41, "window_id": 73])
  try queued.reply(readIndex, token: "recovered")
  try require(Set(try queued.detail(1)["invalidated_snapshot_ids"] as? [String] ?? []) == ["queued-old"],
    "Recovery must surface invalidations from the undelivered result")
  let actionIndex = queued.driver.frames.count
  try queued.call("action-after-recovery", "click")
  try require(queued.driver.frames.count == actionIndex + 1, "Action resumes after full recovery")
}

private func busy() throws {
  for ready in [false, true] {
    let h = Harness()
    try h.call()
    if ready { h.ready() }
    let reads = h.driver.frames.count
    for (index, tool) in (metadataTools + ["get_window_state", "click", "wait_for_window_settle"]).enumerated() {
      try h.call("busy-\(index)", tool)
      try h.expectCode("busy", index)
    }
    try require(h.driver.frames.count == reads, "Every tool call must be busy while observer startup or a sample is pending")
    let control = Data(#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}"#.utf8)
    try h.input(control)
    try require(h.driver.frames.last == control, "Control notifications must remain serviceable while busy")
    try h.input(Data(#"{"jsonrpc":"2.0","id":"list","method":"tools/list"}"#.utf8))
    try require(try dictionary(h.driver.frames.last ?? Data())["method"] as? String == "tools/list", "tools/list must remain serviceable while busy")
  }
  let ordinary = Harness()
  try ordinary.call("ordinary", "click")
  try ordinary.call(); try ordinary.expectCode("busy")
  try require(ordinary.watchCount == 0 && ordinary.driver.frames.count == 1, "Settle cannot overlap an outstanding ordinary tool call")
}

private func observerChecks() throws {
  for terminal in ["deadline", "cancel", "private"] {
    let h = Harness()
    h.watch.holdChecks = true
    try h.call(); h.ready()
    try require(h.driver.frames.isEmpty, "Observer recheck must complete before baseline dispatch")
    switch terminal {
    case "deadline": try h.clock.advance(1000); try h.expectOutcome("pending", unavailable: true)
    case "cancel": try h.cancel(); try h.expectCode("cancelled")
    default: h.session.interrupt()
    }
    let outputs = h.provider.frames.count
    h.watch.completeChecks(true)
    try h.clock.advance(5000)
    try require(h.driver.frames.isEmpty && h.provider.frames.count == outputs,
      "A late successful observer check cannot dispatch after \(terminal)")
  }
  let privateTarget = Harness()
  privateTarget.watch.allowed = false
  try privateTarget.call(); privateTarget.ready()
  try require(privateTarget.driver.frames.isEmpty, "A failed private-target recheck cannot dispatch baseline")
  try privateTarget.expectOutcome("unsupported", unavailable: true)
  let final = Harness()
  try final.call(); final.ready(); try final.reply(0)
  final.watch.holdChecks = true
  try final.clock.advance(200)
  try require(final.driver.frames.count == 1 && final.provider.frames.isEmpty, "Final sample must also await observer recheck")
  try final.clock.advance(1000)
  try final.expectOutcome("pending", unavailable: true)
  final.watch.completeChecks(true)
  try require(final.driver.frames.count == 1, "Late final recheck cannot dispatch beyond total deadline")
}

private func delayedCheck() throws {
  let h = Harness()
  try h.call(); h.ready(); try h.reply(0)
  h.watch.holdChecks = true
  try h.clock.advance(200)
  try require(h.driver.frames.count == 1, "Final read cannot start before observer check completes")
  try h.clock.advance(300)
  h.watch.completeChecks(true)
  try require(h.driver.frames.count == 2, "Successful observer recheck must dispatch within budget")
  let args = object(object(try dictionary(h.driver.frames[1])["params"])["arguments"])
  let timeout = args["timeout_ms"] as? Int
  try h.clock.advance(310); try h.reply(1, token: "after-check")
  try h.expectOutcome("settled", unavailable: false)
  let start = object(try h.detail()["sample"])["started_after_ms"] as? Int
  try require(timeout == 700 && start == 300,
    "Deferred check must leave timeout_ms=700, started_after_ms=300; got timeout_ms=\(String(describing: timeout)), started_after_ms=\(String(describing: start))")
}

private func interrupts() throws {
  let capture = Harness()
  registerNativeMcpSession(capture.session)
  try capture.call(); capture.ready()
  interruptNativeMcp(["op": "hide", "reason": "capture"])
  try capture.reply(0); try capture.clock.advance(200); try capture.reply(1)
  try capture.expectOutcome("settled", unavailable: false)
  for reason in ["private", "ended", "human_input", "takeover"] {
    let h = Harness()
    registerNativeMcpSession(h.session)
    try h.call(); h.ready()
    interruptNativeMcp(["op": "hide", "reason": reason])
    try require(h.watch.cancelled, "\(reason) must detach synchronously at command receipt")
    try h.reply(0); h.watch.send(.changed); try h.clock.advance(5000)
    try h.call("after-interrupt", "click")
    try require(h.provider.frames.isEmpty && h.driver.frames.count == 1, "\(reason) must suppress late replies and future reads/actions")
    let queued = Harness()
    registerNativeMcpSession(queued.session)
    try queued.call(); queued.ready(); try queued.reply(0); try queued.clock.advance(200)
    queued.provider.held = true; try queued.reply(1)
    interruptNativeMcp(["op": "hide", "reason": reason]); queued.provider.flush()
    try require(queued.provider.frames.isEmpty, "\(reason) must drop native output already queued")
  }
}

private func sampleErrors() throws {
  for final in [false, true] {
    let h = Harness()
    try h.call(); h.ready()
    if final { try h.reply(0); try h.clock.advance(200) }
    try h.reply(final ? 1 : 0, code: "window_id_not_found")
    try h.expectOutcome("destroyed", unavailable: true)
    try require(try h.detail()["snapshot_id"] == nil, "Missing window must not reuse a snapshot")
  }
  for rpc in [false, true] {
    let h = Harness()
    try h.call(); h.ready(); try h.reply(0, code: "CannotComplete")
    try require(h.provider.frames.isEmpty, "Generic baseline failure must not imply destruction")
    try h.clock.advance(200)
    try h.reply(1, code: rpc ? nil : "CannotComplete", rpcCode: rpc ? -32001 : nil)
    try h.expectCode("sample_failed")
    if rpc { try require(try h.detail()["driver_code"] as? Int == -32001, "Numeric driver RPC code must remain numeric") }
    else { try require(try h.detail()["driver_code"] as? String == "CannotComplete", "Actual driver code must remain attached to sample_failed") }
  }
  let destroyed = Harness()
  try destroyed.call(); destroyed.ready(); destroyed.watch.send(.destroyed)
  try destroyed.expectOutcome("destroyed", unavailable: true)
  try require(destroyed.watch.cancelled, "Exact destruction must detach")
}

private func unsupported() throws {
  for reason in ["missing_notification_coverage", "private_target", "unknown_target"] {
    let h = Harness()
    try h.call(); h.watch.send(.unsupported(reason))
    try h.expectOutcome("unsupported", unavailable: true)
    try require(h.driver.frames.isEmpty && h.watch.cancelled, "Unsupported \(reason) must refuse before baseline")
    h.ready(); try h.clock.advance(5000)
    try require(h.driver.frames.isEmpty && h.provider.frames.count == 1, "Unsupported observer must remain terminal")
  }
  let degraded = Harness()
  try degraded.call(); degraded.ready(); try degraded.reply(0); try degraded.clock.advance(200)
  try degraded.reply(1, degraded: true)
  try degraded.expectOutcome("unsupported", unavailable: true)
}

private func admission() throws {
  for (manifest, bundle) in [
    ("{}", "si.goat.fixture"),
    (allowedManifest.replacingOccurrences(of: "version: 3", with: "version: 99"), "si.goat.fixture"),
    (allowedManifest.replacingOccurrences(of: "get_window_state", with: "health_report"), "si.goat.fixture"),
    (allowedManifest, "si.goat.other"),
    (allowedManifest, nil),
  ] as [(String, String?)] {
    let h = Harness(manifest: manifest, bundle: bundle)
    try h.call(); try h.expectCode("app_not_approved")
    try require(h.watchCount == 0 && h.driver.frames.isEmpty, "Manifest and exact bundle admission must precede observation")
  }
}

private func arguments() throws {
  let invalid: [[String: Any]] = [
    ["pid": true], ["pid": 0], ["pid": -1], ["pid": 2147483648], ["pid": 1.5],
    ["window_id": true], ["window_id": 0], ["window_id": -1], ["window_id": 4294967296 as UInt64],
    ["quiet_ms": true], ["quiet_ms": 49], ["quiet_ms": 2001],
    ["timeout_ms": true], ["timeout_ms": 99], ["timeout_ms": 30001],
    ["quiet_ms": 201, "timeout_ms": 200], ["session": ""], ["session": "   "],
    ["session": String(repeating: "a", count: 129)], ["since": "opaque"],
  ]
  for changes in invalid {
    let h = Harness()
    let args: [String: Any] = ["pid": 41, "window_id": 73, "quiet_ms": 200, "timeout_ms": 1000]
    try h.call("wait", "wait_for_window_settle", args.merging(changes) { _, new in new })
    try h.expectCode("invalid_arguments")
    try require(h.watchCount == 0 && h.driver.frames.isEmpty, "Invalid native arguments must fail before observation: \(changes)")
  }
  for (quiet, timeout) in [(50, 100), (2000, 30000)] {
    let h = Harness()
    try h.call("bounds", "wait_for_window_settle", ["pid": 41, "window_id": 73, "quiet_ms": quiet, "timeout_ms": timeout])
    try require(h.watch.started && h.provider.frames.isEmpty, "Inclusive native bounds must be admitted")
  }
  let targetBounds = Harness()
  try targetBounds.call("target-bounds", "wait_for_window_settle", ["pid": Int32.max, "window_id": UInt32.max])
  try require(targetBounds.observedTarget?.0 == Int32.max && targetBounds.observedTarget?.1 == UInt32.max,
    "Inclusive PID/window bounds must reach the observer without truncation")
  for raw in ["{}", "[]", "null", #"{"pid":41,"window_id":73,"quiet_ms":1e400}"#,
              #"{"pid":41,"window_id":73,"session":"\ud800"}"#] {
    let h = Harness()
    let frame = Data((#"{"jsonrpc":"2.0","id":"invalid","method":"tools/call","params":{"name":"wait_for_window_settle","arguments":"# + raw + "}}").utf8)
    try h.input(frame); try h.expectCode("invalid_arguments")
    try require(h.watchCount == 0 && h.driver.frames.isEmpty, "Malformed native argument shapes cannot reach observation")
  }
  let defaults = Harness()
  try defaults.call("defaults", "wait_for_window_settle", ["pid": 41, "window_id": 73])
  defaults.ready(); try defaults.reply(0); try defaults.clock.advance(199)
  try require(defaults.driver.frames.count == 1, "Default quiet must last 200ms")
  try defaults.clock.advance(200); try defaults.reply(1)
  try defaults.expectOutcome("settled", unavailable: false)
  let defaultDeadline = Harness()
  try defaultDeadline.call("defaults", "wait_for_window_settle", ["pid": 41, "window_id": 73])
  defaultDeadline.ready(); try defaultDeadline.reply(0); try defaultDeadline.clock.advance(4999)
  try require(defaultDeadline.provider.frames.isEmpty, "Default deadline cannot expire before 5000ms")
  try defaultDeadline.clock.advance(5000); try defaultDeadline.expectOutcome("pending", unavailable: true)
}

private func collisions() throws {
  let h = Harness()
  let original = #""goat-native-settle:\u0073ample:1""#
  let request = Data((#"{"jsonrpc":"2.0","id":"# + original + #", "method":"tools/call","params":{"name":"health_report","arguments":{}},"opaque":"\ud800","huge":1e400}"#).utf8)
  try h.input(request)
  guard let forwarded = McpObject(h.driver.frames[0]), let mapped = forwarded.raw("id") else {
    throw ContractFailure(description: "Missing remapped provider ID")
  }
  try require(mapped != Data(original.utf8), "Every colliding provider ID must be remapped")
  let mappedText = String(decoding: mapped, as: UTF8.self)
  let expectedRequest = Data(String(decoding: request, as: UTF8.self).replacingOccurrences(of: original, with: mappedText).utf8)
  try require(h.driver.frames[0] == expectedRequest, "ID remapping must preserve every byte outside the ID")
  let cancel = Data((#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"# + original + #", "reason":"fixture"},"opaque":"\ud800","huge":1e400}"#).utf8)
  try h.input(cancel)
  let expected = Data(String(decoding: cancel, as: UTF8.self).replacingOccurrences(of: original, with: mappedText).utf8)
  try require(h.driver.frames.count == 2 && h.driver.frames[1] == expected, "Translated cancellation must retain the full envelope and opaque fields")
  var response = Data(#"{"jsonrpc":"2.0","id":"#.utf8)
  response.append(mapped); response.append(Data(#", "result":{"opaque":"\ud800","huge":1e400}}"#.utf8))
  try h.driverReply(response)
  let restored = McpObject(h.provider.frames[0])
  try require(restored?.raw("id") == Data(original.utf8), "Driver reply must restore the exact raw original ID spelling")
  let expectedResponse = Data(String(decoding: response, as: UTF8.self).replacingOccurrences(of: mappedText, with: original).utf8)
  try require(h.provider.frames[0] == expectedResponse, "Remapped reply must retain every opaque result byte")
  let privateRead = Harness()
  try privateRead.call(); privateRead.ready()
  let actual = try dictionary(privateRead.driver.frames[0])["id"]
  guard let actual else { throw ContractFailure(description: "No internal sample ID") }
  try privateRead.input(mcpJSON(["jsonrpc": "2.0", "id": actual, "result": ["forged": true]]))
  try require(privateRead.driver.frames.count == 1, "Provider responses cannot address private sample IDs")
  try privateRead.cancel(actual)
  try require(privateRead.driver.frames.count == 1 && privateRead.provider.frames.isEmpty, "Forged internal cancellation must never reach driver or cancel an unrelated settle")
  try privateRead.reply(0); try privateRead.clock.advance(200); try privateRead.reply(1)
  try privateRead.expectOutcome("settled", unavailable: false)
}

private func opaqueTraffic() throws {
  let h = Harness()
  let request = Data(#"{ "jsonrpc":"2.0", "id":1e0,"method":"fixture/ordinary","params":{"unknown":"\ud800","overflow":1e400},"extra":1e400 }"#.utf8)
  try h.input(request)
  try require(h.driver.frames == [request], "Ordinary request must be forwarded byte-identically")
  let response = Data(#"{ "jsonrpc":"2.0", "id":1e0,"result":{"unknown":"\ud800","overflow":1e400},"extra":1e400 }"#.utf8)
  try h.driverReply(response)
  try require(h.provider.frames == [response], "Ordinary response must preserve opaque surrogate and overflow byte-identically")
  let numeric = Harness()
  try numeric.call(7)
  try numeric.cancel(7.0)
  try numeric.expectCode("cancelled")
  let unicode = Harness()
  let composed = Data(#"{"jsonrpc":"2.0","id":"\u00e9","method":"fixture/ordinary"}"#.utf8)
  let decomposed = Data(#"{"jsonrpc":"2.0","id":"e\u0301","method":"fixture/ordinary"}"#.utf8)
  try unicode.input(composed)
  try unicode.input(decomposed)
  try require(unicode.driver.frames == [composed, decomposed], "Canonically equivalent Unicode IDs are distinct JSON-RPC identities")
}

private func discovery() throws -> [String: Any] {
  let h = Harness()
  let request = Data(#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#.utf8)
  try h.input(request)
  try require(h.driver.frames == [request], "Original tools/list request must reach the same driver")
  let reply = Data(#"{"jsonrpc":"2.0","id":"list","result":{"tools":[{"name":"original_tool","inputSchema":{"type":"object","opaque":"\ud800","huge":1e400}}],"cursor":"kept"}}"#.utf8)
  try h.driverReply(reply)
  guard let list = McpObject(h.provider.frames[0])?.object("result"), let tools = list.raw("tools") else {
    throw ContractFailure(description: "Missing tools/list result")
  }
  let text = String(decoding: tools, as: UTF8.self)
  try require(text.contains(#"{"name":"original_tool","inputSchema":{"type":"object","opaque":"\ud800","huge":1e400}}"#), "Native discovery must retain the original opaque descriptor")
  try require(String(decoding: h.provider.frames[0], as: UTF8.self).contains(#""cursor":"kept""#), "Native discovery must retain original result metadata")
  let plain = Harness()
  try plain.input(request)
  try plain.driverReply(Data(#"{"jsonrpc":"2.0","id":"list","result":{"tools":[{"name":"original_tool","inputSchema":{"type":"object"}}]}}"#.utf8))
  return try plain.result()
}

@main
private struct McpNativeFixture {
  static func main() {
    let name = CommandLine.arguments.dropFirst().first ?? ""
    do {
      var output: [String: Any] = ["ok": true, "case": name]
      switch name {
      case "fresh": try fresh()
      case "dirty-final": try dirtyFinal()
      case "deadline": try deadline()
      case "deadline-recovery": try recovery(cancel: false)
      case "cancel-recovery": try recovery(cancel: true)
      case "cancellation": try cancellation()
      case "busy": try busy()
      case "observer-checks": try observerChecks()
      case "delayed-check": try delayedCheck()
      case "interrupts": try interrupts()
      case "sample-errors": try sampleErrors()
      case "unsupported": try unsupported()
      case "admission": try admission()
      case "arguments": try arguments()
      case "collisions": try collisions()
      case "opaque": try opaqueTraffic()
      case "discovery": output["result"] = try discovery()
      default: throw ContractFailure(description: "Unknown fixture case \(name)")
      }
      FileHandle.standardOutput.write(try mcpJSON(output)); FileHandle.standardOutput.write(Data([10]))
    } catch {
      FileHandle.standardError.write(Data("\(name): \(error)\n".utf8))
      exit(1)
    }
  }
}

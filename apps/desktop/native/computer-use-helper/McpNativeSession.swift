import AppKit
import CoreFoundation
import Foundation

struct SettleRuntime {
  let now: () -> Int64
  let schedule: (Int64, @escaping () -> Void) -> (() -> Void)
  let bundleID: (Int32) -> String?
  let watch: (Int32, UInt32, @escaping () -> Bool) -> SettleWatch

  static let live = SettleRuntime(
    now: { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) },
    schedule: { at, action in
      let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
      let remaining = max(0, at - Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000))
      timer.schedule(deadline: .now() + .milliseconds(Int(remaining)))
      timer.setEventHandler(handler: action)
      timer.resume()
      return { timer.cancel() }
    },
    bundleID: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier },
    watch: makeWindowSettleWatch)
}

private struct McpIdentity {
  let raw: Data
  let key: String
  let text: String?
  init(_ raw: Data) {
    self.raw = raw
    let value = try? JSONSerialization.jsonObject(with: raw, options: [.fragmentsAllowed])
    text = value as? String
    // Swift keys normalize Unicode equality; JSON-RPC identities preserve scalar sequences.
    if let text { key = "s:" + Data(text.utf8).base64EncodedString() }
    else if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite {
      key = "n:" + String(n.doubleValue == 0 ? 0 : n.doubleValue)
    } else if value is NSNull { key = "null" }
    else { key = "opaque:" + raw.base64EncodedString() }
  }
}

private final class SettleOperation {
  let id: McpIdentity
  let request: SettleRequest
  let started: Int64
  let app: String
  let observation = McpGeneration()
  let delivery = McpGeneration()
  var state: WindowSettleState
  var watch: SettleWatch?
  var quiet: (() -> Void)?
  var deadline: (() -> Void)?
  var sampleID: String?
  var driverCode: Any?
  var didRead = false
  var checkingSample = false
  init(id: McpIdentity, request: SettleRequest, app: String, now: Int64) {
    self.id = id; self.request = request; self.app = app; started = now
    state = WindowSettleState(request: request, now: now)
  }
}

private struct NativePending {
  let original: McpIdentity
  let forwarded: Data
  // Routing flags only: retained method or tool strings would escape the ID byte budget.
  let catalog: Bool
  let toolCall: Bool
  let recovery: Bool
}

/// One native tool shares the existing child and authority; it never opens another driver.
/// State locks are never held across pipe writes or AX setup, so interruption stays local.
final class McpNativeSession {
  private typealias Action = () throws -> Void
  private let lock = NSRecursiveLock()
  private let generation = McpGeneration()
  private let driverOutput = McpGeneration()
  private let driver: any McpWriting
  private let provider: any McpWriting
  private let manifest: NativeManifest?
  private let runtime: SettleRuntime
  private let fail: (Int32, String) -> Void
  private var serial: UInt64 = 0
  private var pending: [String: NativePending] = [:]
  private var pendingBytes = 0
  private var samples: [String: SettleOperation] = [:]
  private var active: SettleOperation?
  private var deliveries: [String: McpGeneration] = [:]
  private var recovery: SettleRequest?
  private var invalidated = Set<String>()
  // A queued result that carries sampled tokens; losing it before delivery needs recovery.
  private var undelivered: [String: (request: SettleRequest, invalidated: Set<String>)] = [:]
  private let namespace = "goat-native-settle:"

  init(driver: any McpWriting, provider: any McpWriting, manifest: NativeManifest?, runtime: SettleRuntime = .live,
       fail: @escaping (Int32, String) -> Void) {
    self.driver = driver; self.provider = provider; self.manifest = manifest
    self.runtime = runtime; self.fail = fail
  }

  private func perform(_ body: () throws -> [Action]) throws {
    lock.lock()
    let actions: [Action]
    do { actions = try body() } catch { lock.unlock(); throw error }
    lock.unlock()
    for action in actions { try action() }
  }

  private func asynchronous(_ body: () throws -> [Action]) {
    do { try perform(body) }
    catch { fail(74, "The native MCP operation failed.") }
  }

  private func next(_ purpose: String) -> String {
    serial += 1
    return namespace + purpose + String(serial)
  }

  private func response(_ id: McpIdentity, result: [String: Any]) throws -> Data {
    var frame = Data("{\"jsonrpc\":\"2.0\",\"id\":".utf8)
    frame.append(id.raw)
    frame.append(Data(",\"result\":".utf8))
    frame.append(try mcpJSON(result)); frame.append(0x7d)
    return frame
  }

  private func answer(_ id: McpIdentity, result: [String: Any], gate: McpGeneration? = nil) throws -> Action {
    let frame = try response(id, result: result)
    let delivery = gate ?? McpGeneration()
    deliveries[id.key] = delivery
    return { [self] in
      provider.enqueue(frame, live: { self.generation.isActive && delivery.isActive }) { written in
        self.lock.lock()
        if self.deliveries[id.key] === delivery { self.deliveries.removeValue(forKey: id.key) }
        if let lost = self.undelivered.removeValue(forKey: id.key), !written { self.requireRecovery(lost) }
        self.lock.unlock()
      }
    }
  }

  private func requireRecovery(_ lost: (request: SettleRequest, invalidated: Set<String>)) {
    recovery = lost.request
    invalidated.formUnion(lost.invalidated)
  }

  private func refusal(_ id: McpIdentity, code: String, message: String) throws -> [Action] {
    [try answer(id, result: nativeToolFailure(code, message))]
  }

  func fromProvider(_ frame: Data) throws {
    try perform {
      guard generation.isActive else { return [] }
      guard let object = McpObject(frame) else {
        return [{ try self.driver.write(frame, live: { self.generation.isActive }) }]
      }
      guard let method = object.string("method") else {
        if let raw = object.raw("id"), McpIdentity(raw).text?.hasPrefix(namespace) == true { return [] }
        return [{ try self.driver.write(frame, live: { self.generation.isActive }) }]
      }
      if method == "notifications/cancelled", let raw = object.object("params")?.raw("requestId") {
        let id = McpIdentity(raw)
        if let gate = deliveries[id.key] {
          gate.invalidate()
          // Fence now: the blocked writer reports the drop later, after the next call may arrive.
          // A frame already written gets one redundant full read, which is the safe direction.
          if let lost = undelivered.removeValue(forKey: id.key) { requireRecovery(lost) }
        }
        if let op = active, op.id.key == id.key { return try effects(op, op.state.receive(.cancel, now: runtime.now())) }
        if let found = pending.first(where: { $0.value.original.key == id.key }),
          found.key != id.key, let params = object.object("params") {
          let changed = params.replacing("requestId", with: found.value.forwarded)
          return [{ try self.driver.write(changed, live: { self.generation.isActive }) }]
        }
        // An unrecognized external cancellation cannot address a private sample ID.
        if id.text?.hasPrefix(namespace) == true { return [] }
        return [{ try self.driver.write(frame, live: { self.generation.isActive }) }]
      }
      guard let raw = object.raw("id") else { return [{ try self.driver.write(frame, live: { self.generation.isActive }) }] }
      let id = McpIdentity(raw)
      guard pending.count < 128, raw.count <= mcpFrameLimit - pendingBytes,
        !pending.values.contains(where: { $0.original.key == id.key }), active?.id.key != id.key,
        deliveries[id.key] == nil
      else { throw McpFrameError.invalidObject }
      let params = object.object("params")
      let tool = method == "tools/call" ? params?.string("name") : nil
      if tool == windowSettleToolName {
        guard generation.isActive else { return [] }
        guard object.count("id") == 1, object.count("method") == 1, object.count("params") == 1,
          params?.count("name") == 1, params?.count("arguments") == 1,
          let arguments = params?.raw("arguments"), let request = settleArguments(arguments)
        else { return try refusal(id, code: "invalid_arguments", message: "Settle needs one exact PID/window and valid quiet/deadline bounds.") }
        guard active == nil, samples.isEmpty, recovery == nil, deliveries.isEmpty,
          !pending.values.contains(where: { $0.toolCall })
        else { return try refusal(id, code: "busy", message: "Another observation or tool call is outstanding. Finish it before waiting for notifications.") }
        guard let app = runtime.bundleID(request.pid), manifest?.permits(bundleID: app) == true else {
          return try refusal(id, code: "app_not_approved", message: "The native observation is outside this helper's app or observation ceiling.")
        }
        let op = SettleOperation(id: id, request: request, app: app, now: runtime.now())
        active = op
        return try effects(op, op.state.begin())
      }
      var outgoing = frame
      var recovering = false
      if method == "tools/call" {
        guard active == nil, samples.isEmpty else {
          return try refusal(id, code: "busy", message: "A notification observation is still in flight; this call did not run.")
        }
        if let target = recovery {
          let metadata = ["health_report", "check_permissions", "get_guide", "list_apps", "list_windows"]
          if !metadata.contains(tool ?? "") {
            guard !pending.values.contains(where: { $0.recovery }) else {
              return try refusal(id, code: "busy", message: "The required full recovery observation is still outstanding.")
            }
            guard tool == "get_window_state", let arguments = params?.raw("arguments"),
              var args = try? JSONSerialization.jsonObject(with: arguments) as? [String: Any],
              (args["pid"] as? NSNumber)?.int64Value == Int64(target.pid),
              (args["window_id"] as? NSNumber)?.uint64Value == UInt64(target.windowID),
              (args["session"] as? String) == target.session, let params
            else { return try refusal(id, code: "fresh_observation_required", message: "A cancelled or expired sample may have changed tokens. Read that exact PID/window and session fully before acting.") }
            args.removeValue(forKey: "since")
            args["include_accessibility_tree"] = true
            args["display_only"] = false
            args["full_output"] = false
            args["tree_format"] = "elements"
            outgoing = params.replacing("arguments", with: try mcpJSON(args))
            recovering = true
          }
        }
      }
      var forwardedID = id
      if id.text?.hasPrefix(namespace) == true {
        forwardedID = McpIdentity(try mcpJSON(next("forward:")))
        guard let changed = McpObject(outgoing) else { throw McpFrameError.invalidObject }
        outgoing = changed.replacing("id", with: forwardedID.raw)
      }
      pending[forwardedID.key] = NativePending(original: id, forwarded: forwardedID.raw,
        catalog: method == "tools/list", toolCall: tool != nil, recovery: recovering)
      pendingBytes += id.raw.count
      return [{ try self.driver.write(outgoing, live: { self.generation.isActive }) }]
    }
  }

  func fromDriver(_ frame: Data) throws {
    try perform {
      guard driverOutput.isActive else { return [] }
      guard let object = McpObject(frame), object.string("method") == nil, let raw = object.raw("id") else {
        return [{ try self.provider.write(frame, live: { self.driverOutput.isActive }) }]
      }
      let id = McpIdentity(raw)
      if let name = id.text, let op = samples.removeValue(forKey: name) {
        op.sampleID = nil
        let result = decodeSample(object, operation: op)
        if op.state.isFinished || active !== op {
          collect(result)
          recovery = op.request
          return []
        }
        return try effects(op, op.state.receive(.sampled(result), now: runtime.now()))
      }
      guard let call = pending.removeValue(forKey: id.key) else { return [{ try self.provider.write(frame, live: { self.driverOutput.isActive }) }] }
      pendingBytes -= call.original.raw.count
      var outgoing = object.replacing("id", with: call.original.raw)
      if call.catalog, let tools = object.object("result")?.span("tools"), frame[tools.lowerBound] == 0x5b {
        var insertion = try mcpJSON(windowSettleTool)
        let content = frame[(tools.lowerBound + 1)..<(tools.upperBound - 1)]
        if content.contains(where: { ![UInt8(0x20), 0x09, 0x0d, 0x0a].contains($0) }) { insertion.insert(0x2c, at: 0) }
        // Replace the id first, then find the array again because its offsets may move.
        guard let revised = McpObject(outgoing), let array = revised.object("result")?.span("tools") else { throw McpFrameError.invalidObject }
        outgoing.insert(contentsOf: insertion, at: array.upperBound - 1)
      }
      if call.recovery, let resultData = McpObject(outgoing)?.raw("result"),
        var result = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any] {
        var structured = result["structuredContent"] as? [String: Any] ?? [:]
        let ids = structured["invalidated_snapshot_ids"] as? [String] ?? []
        structured["invalidated_snapshot_ids"] = Array(invalidated.union(ids)).sorted()
        result["structuredContent"] = structured
        let complete = result["isError"] as? Bool != true && structured["snapshot_id"] is String
          && structured["degraded"] as? Bool != true && structured["degraded_reason"] == nil
        if complete || structured["code"] as? String == "window_id_not_found" {
          recovery = nil; invalidated.removeAll()
        }
        if let revised = McpObject(outgoing) { outgoing = revised.replacing("result", with: try mcpJSON(result)) }
      }
      return [{ try self.provider.write(outgoing, live: { self.driverOutput.isActive }) }]
    }
  }

  private func decodeSample(_ object: McpObject, operation: SettleOperation) -> SettleSampleResult {
    operation.didRead = true
    if let error = object.object("error") {
      let code = error.raw("code").flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
      operation.driverCode = code
      return .failure(code: code.map { String(describing: $0) }, message: error.string("message") ?? "Driver RPC error.")
    }
    guard let data = object.raw("result"), let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      operation.driverCode = nil
      return .failure(code: nil, message: "The driver returned an invalid sample.")
    }
    let structured = result["structuredContent"] as? [String: Any] ?? [:]
    operation.driverCode = structured["code"]
    guard (structured["pid"] as? NSNumber)?.int64Value == Int64(operation.request.pid),
      (structured["window_id"] as? NSNumber)?.uint64Value == UInt64(operation.request.windowID)
    else { return .failure(code: nil, message: "The driver sample did not identify the exact requested window.") }
    let ids = structured["invalidated_snapshot_ids"] as? [String] ?? []
    invalidated.formUnion(ids)
    if result["isError"] as? Bool == true {
      if structured["code"] as? String == "window_id_not_found" { return .missing }
      let text = (result["content"] as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: "\n")
      return .failure(code: structured["code"] as? String, message: String((text ?? "Driver observation failed.").prefix(2048)))
    }
    let degraded = structured["degraded"] as? Bool == true || structured["degraded_reason"] != nil
    guard degraded || structured["snapshot_id"] is String else {
      return .failure(code: nil, message: "The driver sample contained no fresh accessibility snapshot.")
    }
    return .success(SettleSnapshot(result: data, invalidated: ids, degraded: degraded))
  }

  private func collect(_ result: SettleSampleResult) {
    if case .success(let sample) = result { invalidated.formUnion(sample.invalidated) }
  }

  private func event(_ event: SettleEvent, operation: SettleOperation) {
    asynchronous {
      guard self.active === operation, self.generation.isActive else { return [] }
      return try self.effects(operation, operation.state.receive(event, now: self.runtime.now()))
    }
  }

  private func effects(_ op: SettleOperation, _ effects: [SettleEffect]) throws -> [Action] {
    var actions: [Action] = []
    for effect in effects {
      switch effect {
      case .observe:
        actions.append { [self, op] in
          guard op.observation.isActive, self.generation.isActive else { return }
          let watch = self.runtime.watch(op.request.pid, op.request.windowID) { [weak self, weak op] in
            guard let self, let op, op.observation.isActive, self.generation.isActive,
              let app = self.runtime.bundleID(op.request.pid), Data(app.utf8) == Data(op.app.utf8)
            else { return false }
            return self.manifest?.permits(bundleID: app) == true
          }
          self.lock.lock(); op.watch = watch; self.lock.unlock()
          guard op.observation.isActive, self.generation.isActive else { watch.cancel(); return }
          watch.start { [weak self, weak op] event in
            guard let self, let op, op.observation.isActive else { return }
            switch event {
            case .ready(let coverage): self.event(.ready(coverage: coverage), operation: op)
            case .received: self.event(.received, operation: op)
            case .changed: self.event(.changed, operation: op)
            case .ignored: self.event(.ignored, operation: op)
            case .destroyed: self.event(.destroyed, operation: op)
            case .unsupported(let reason): self.event(.unsupported(reason), operation: op)
            }
          }
        }
      case .detach:
        op.observation.invalidate()
        if let watch = op.watch { actions.append { watch.cancel() } }
      case .scheduleQuiet(let epoch, let at):
        actions.append { [self, op] in
          let cancel = self.runtime.schedule(at) { [weak self, weak op] in
            if let self, let op { self.event(.quiet(epoch), operation: op) }
          }
          self.lock.lock()
          if op.state.isFinished { self.lock.unlock(); cancel() }
          else { op.quiet = cancel; self.lock.unlock() }
        }
      case .scheduleDeadline(let at):
        actions.append { [self, op] in
          let cancel = self.runtime.schedule(at) { [weak self, weak op] in
            if let self, let op { self.event(.deadline, operation: op) }
          }
          self.lock.lock()
          if op.state.isFinished { self.lock.unlock(); cancel() }
          else { op.deadline = cancel; self.lock.unlock() }
        }
      case .cancelQuiet:
        if let cancel = op.quiet { actions.append(cancel); op.quiet = nil }
      case .cancelDeadline:
        if let cancel = op.deadline { actions.append(cancel); op.deadline = nil }
      case .sample(let final, let timeout):
        let id = next("sample:")
        op.sampleID = id; samples[id] = op; op.checkingSample = true
        var args: [String: Any] = ["pid": Int(op.request.pid), "window_id": Int(op.request.windowID),
          "tree_format": "elements", "include_accessibility_tree": true, "include_screenshot": final, "timeout_ms": min(timeout, 1000)]
        if let session = op.request.session { args["session"] = session }
        let frame = try mcpJSON(["jsonrpc": "2.0", "id": id, "method": "tools/call",
          "params": ["name": "get_window_state", "arguments": args]])
        actions.append { [self, op] in
          guard let watch = op.watch else { self.checkedSample(false, frame: frame, id: id, operation: op); return }
          watch.check { [weak self, weak op] allowed in
            if let self, let op { self.checkedSample(allowed, frame: frame, id: id, operation: op) }
          }
        }
      case .cancelSample:
        // Do not replace the eventual tool reply with an early cancellation acknowledgement:
        // its blocking AX walk may still publish a snapshot. Drain the actual read, privately.
        if op.sampleID != nil { recovery = op.request }
      case .finish(let completion):
        invalidated.formUnion(completion.invalidated)
        active = nil
        if op.checkingSample, let id = op.sampleID {
          samples.removeValue(forKey: id); op.sampleID = nil; op.checkingSample = false
          if !op.didRead && samples.isEmpty { recovery = nil }
        }
        if op.sampleID != nil || (completion.sample == nil && op.didRead) {
          recovery = op.request
        }
        var result = settleToolResult(completion, request: op.request, startedAt: op.started, driverCode: op.driverCode)
        if completion.outcome == "cancelled" {
          result = nativeToolFailure("cancelled", "The notification observation was cancelled.")
        }
        if !invalidated.isEmpty {
          var structured = result["structuredContent"] as? [String: Any] ?? [:]
          structured["invalidated_snapshot_ids"] = Array(invalidated).sorted()
          result["structuredContent"] = structured
        }
        if generation.isActive {
          if completion.sample != nil || !invalidated.isEmpty {
            undelivered[op.id.key] = (op.request, invalidated)
          }
          actions.append(try answer(op.id, result: result, gate: op.delivery))
        }
        if samples.isEmpty && recovery == nil { invalidated.removeAll() }
      }
    }
    return actions
  }

  private func discardUnwritten(_ id: String, operation op: SettleOperation) {
    lock.lock()
    if samples[id] === op {
      samples.removeValue(forKey: id); op.sampleID = nil; op.checkingSample = false
      if !op.didRead && samples.isEmpty { recovery = nil }
    }
    lock.unlock()
  }

  private func checkedSample(_ allowed: Bool, frame: Data, id: String, operation op: SettleOperation) {
    lock.lock()
    let live = samples[id] === op && active === op && op.observation.isActive && generation.isActive
    lock.unlock()
    guard live else { discardUnwritten(id, operation: op); return }
    let remaining = op.started + op.request.timeoutMs - runtime.now()
    if remaining <= 0 {
      event(.deadline, operation: op); discardUnwritten(id, operation: op); return
    }
    guard allowed else {
      event(.unsupported("pre_sample_check_failed"), operation: op)
      discardUnwritten(id, operation: op); return
    }
    guard remaining >= 100 else { discardUnwritten(id, operation: op); return }
    lock.lock()
    let admitted = samples[id] === op && active === op && op.observation.isActive && generation.isActive
    if admitted { op.checkingSample = false }
    lock.unlock()
    guard admitted else { discardUnwritten(id, operation: op); return }
    // The privacy check consumed part of the total budget; do not send the earlier allowance.
    var outgoing = frame
    if let object = McpObject(frame), let args = object.object("params")?.object("arguments") {
      outgoing = args.replacing("timeout_ms", with: Data(String(min(1000, remaining)).utf8))
    }
    driver.enqueue(outgoing, live: { self.beginSampleDispatch(id, operation: op) }) { written in
      if !written { self.discardUnwritten(id, operation: op) }
    }
  }

  private func beginSampleDispatch(_ id: String, operation op: SettleOperation) -> Bool {
    lock.lock()
    let live = samples[id] === op && active === op && op.observation.isActive && generation.isActive
    lock.unlock()
    guard live else { return false }
    event(.sampleStarted, operation: op)
    lock.lock()
    let admitted = samples[id] === op && active === op && op.observation.isActive && generation.isActive
    lock.unlock()
    return admitted
  }

  /// Called at fd3 receipt, before AppKit queues its hide/ack. A pause is irreversible in
  /// this helper generation; the proxy starts a new child when control resumes.
  func interrupt() {
    driverOutput.invalidate()
    endInput()
  }

  /// Normal input EOF still drains ordinary driver replies, while cancelling native work.
  func endInput() {
    generation.invalidate()
    lock.lock()
    let op = active
    op?.observation.invalidate(); op?.delivery.invalidate()
    for gate in deliveries.values { gate.invalidate() }
    active = nil
    lock.unlock()
    op?.watch?.cancel(); op?.quiet?(); op?.deadline?()
    driver.closeNative(); provider.closeNative()
  }
}

private let nativeSessionLock = NSLock()
private weak var currentNativeSession: McpNativeSession?
func registerNativeMcpSession(_ session: McpNativeSession) {
  nativeSessionLock.lock(); currentNativeSession = session; nativeSessionLock.unlock()
}
func interruptNativeMcp(_ command: [String: Any]) {
  guard command["op"] as? String == "hide", let reason = command["reason"] as? String,
    ["human_input", "takeover", "private", "ended"].contains(reason) else { return }
  nativeSessionLock.lock(); let session = currentNativeSession; nativeSessionLock.unlock()
  session?.interrupt()
}

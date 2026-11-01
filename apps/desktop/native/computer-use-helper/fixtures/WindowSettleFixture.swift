import Foundation

private struct FixtureFailure: Error, CustomStringConvertible {
  let description: String
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw FixtureFailure(description: message) }
}

private func snapshot(_ token: String, invalidated: [String] = [], degraded: Bool = false)
  -> SettleSampleResult
{
  .success(SettleSnapshot(result: Data(token.utf8), invalidated: invalidated, degraded: degraded))
}

private struct DispatchRecord {
  let at: Int64
  let final: Bool
  let budget: Int
}

private struct Harness {
  var state: WindowSettleState
  var now: Int64
  var quiet: (epoch: Int, at: Int64)?
  var deadline: Int64?
  var dispatches: [DispatchRecord] = []
  var completions: [SettleCompletion] = []
  var observing = false
  var sampleActive = false
  var cancelledSamples = 0

  init(start: Int64 = 0, quietMs: Int64 = 200, timeoutMs: Int64 = 1000,
    begin: Bool = true) throws
  {
    now = start
    state = WindowSettleState(
      request: SettleRequest(pid: 41, windowID: 73, quietMs: quietMs,
        timeoutMs: timeoutMs, session: "fixture-session"), now: start)
    if begin { try apply(state.begin()) }
  }

  mutating func send(_ event: SettleEvent, at: Int64) throws {
    now = at
    if case .sampled = event { sampleActive = false }
    try apply(state.receive(event, now: at))
  }

  mutating func fireQuiet(at: Int64) throws {
    guard let timer = quiet else { throw FixtureFailure(description: "no quiet timer") }
    try send(.quiet(timer.epoch), at: at)
  }

  mutating func apply(_ effects: [SettleEffect]) throws {
    for effect in effects {
      switch effect {
      case .observe:
        try require(deadline != nil, "observation must already be deadline bounded")
        observing = true
      case .detach: observing = false
      case .scheduleQuiet(let epoch, let at): quiet = (epoch, at)
      case .scheduleDeadline(let at): deadline = at
      case .cancelQuiet: quiet = nil
      case .cancelDeadline: deadline = nil
      case .sample(let final, let timeoutMs):
        try require(!state.isFinished && !sampleActive, "terminal or overlapping sample dispatch")
        try require(timeoutMs >= 100, "driver budget below minimum")
        sampleActive = true
        dispatches.append(DispatchRecord(at: now, final: final, budget: timeoutMs))
      case .cancelSample:
        sampleActive = false
        cancelledSamples += 1
      case .finish(let completion):
        try require(state.isFinished && !state.inFlight, "finish was not latched before effects")
        try require(!observing && quiet == nil && deadline == nil && !sampleActive,
          "terminal output preceded cancellation/detachment")
        completions.append(completion)
      }
    }
  }

  func completion(_ outcome: String) throws -> SettleCompletion {
    try require(completions.count == 1, "expected exactly one completion")
    guard let result = completions.first else { throw FixtureFailure(description: "no result") }
    try require(result.outcome == outcome, "expected \(outcome), got \(result.outcome)")
    return result
  }

  mutating func assertTerminalIsSilent() throws {
    let count = dispatches.count
    let outputs = completions.count
    let events: [SettleEvent] = [
      .ready(coverage: ["late"]), .changed, .destroyed, .unsupported("late"),
      .quiet(1), .deadline, .sampled(snapshot("late", invalidated: ["late-token"])), .cancel,
    ]
    for event in events {
      try require(state.receive(event, now: now + 1000).isEmpty,
        "event after terminal produced effects")
    }
    try require(state.begin().isEmpty, "begin after terminal produced effects")
    try require(dispatches.count == count && completions.count == outputs,
      "terminal state dispatched or emitted again")
  }
}

@main
enum WindowSettleFixture {
  static func main() throws {
    let name = CommandLine.arguments.dropFirst().first ?? ""
    switch name {
    case "freshness": try freshness()
    case "dirty-final": try dirtyFinal()
    case "attribution": try attribution()
    case "deadline": try deadline()
    case "budget": try budget()
    case "failures": try failures()
    case "destruction": try destruction()
    case "cancellation": try cancellation()
    case "invalidations": try invalidations()
    default: throw FixtureFailure(description: "unknown scenario \(name)")
    }
    print("PASS \(name)")
  }

  private static func freshness() throws {
    var h = try Harness(start: 1000)
    try require(h.dispatches.isEmpty, "sample before subscription")
    try h.send(.sampled(snapshot("before-ready")), at: 1001)
    try h.send(.changed, at: 1010)
    try h.send(.ready(coverage: ["window", "application"]), at: 1050)
    try h.send(.ready(coverage: ["duplicate"]), at: 1060)
    try h.send(.sampled(snapshot("baseline")), at: 1100)
    try h.fireQuiet(at: 1249)
    try require(h.dispatches.count == 1 && h.completions.isEmpty, "quiet ended early")
    try h.fireQuiet(at: 1250)
    try h.send(.sampled(snapshot("fresh")), at: 1270)
    let result = try h.completion("settled")
    try require(h.dispatches.map(\.at) == [1050, 1250], "sample freshness boundary")
    try require(h.dispatches.last?.final == true, "settled using baseline")
    try require(result.sample?.result == Data("fresh".utf8), "wrong settled sample")
    try require(result.sampleStartedAt == 1250 && result.sampleCompletedAt == 1270,
      "sample metadata must use injected monotonic time")
    try require(result.coverage == ["window", "application"] && result.observedQuietMs >= 200,
      "subscription coverage or quiet evidence lost")
    try h.assertTerminalIsSilent()

    var slow = try Harness()
    try slow.send(.ready(coverage: ["window"]), at: 10)
    try slow.fireQuiet(at: 210)
    try require(slow.dispatches.count == 1, "overlapping final read")
    try slow.send(.sampled(snapshot("slow-baseline")), at: 250)
    try require(slow.dispatches.last?.at == 250 && slow.dispatches.last?.final == true,
      "baseline completed after quiet without fresh final read")
    try slow.send(.sampled(snapshot("slow-fresh")), at: 260)
    _ = try slow.completion("settled")
  }

  private static func dirtyFinal() throws {
    var h = try Harness()
    try h.send(.ready(coverage: ["window"]), at: 0)
    try h.send(.sampled(snapshot("baseline")), at: 10)
    let oldEpoch = h.quiet?.epoch ?? -1
    try h.fireQuiet(at: 200)
    try h.send(.changed, at: 220)
    try h.send(.sampled(snapshot("dirty")), at: 230)
    try h.send(.quiet(oldEpoch), at: 400)
    try require(h.completions.isEmpty && h.dispatches.count == 2, "dirty final established settled")
    try h.fireQuiet(at: 420)
    try h.send(.sampled(snapshot("fresh")), at: 430)
    let result = try h.completion("settled")
    try require(result.sample?.result == Data("fresh".utf8), "reused dirty final sample")
    try require(result.sampleStartedAt == 420 && result.observedQuietMs == 210,
      "fresh quiet interval was not required")
    try h.assertTerminalIsSilent()
  }

  private static func attribution() throws {
    // A received notification is unattributed until the observer resolves it.
    var held = try Harness()
    try held.send(.ready(coverage: ["window"]), at: 0)
    try held.send(.sampled(snapshot("baseline")), at: 10)
    try held.fireQuiet(at: 200)
    try held.send(.received, at: 210)
    try held.send(.sampled(snapshot("held")), at: 220)
    try require(held.completions.isEmpty, "final sample settled during unresolved attribution")
    try held.send(.ignored, at: 230)
    let released = try held.completion("settled")
    try require(released.sample?.result == Data("held".utf8) && released.sampleCompletedAt == 220,
      "ignored notification must release the held sample unchanged")
    try held.assertTerminalIsSilent()

    var dirty = try Harness()
    try dirty.send(.ready(coverage: ["window"]), at: 0)
    try dirty.send(.sampled(snapshot("baseline")), at: 10)
    try dirty.fireQuiet(at: 200)
    try dirty.send(.received, at: 210)
    try dirty.send(.sampled(snapshot("dirty")), at: 220)
    try dirty.send(.changed, at: 230)
    try require(dirty.completions.isEmpty && dirty.dispatches.count == 2, "held dirty sample escaped")
    try dirty.fireQuiet(at: 430)
    try dirty.send(.sampled(snapshot("fresh")), at: 440)
    let fresh = try dirty.completion("settled")
    try require(fresh.sample?.result == Data("fresh".utf8), "a resolved change needs a fresh quiet read")

    var waiting = try Harness()
    try waiting.send(.ready(coverage: ["window"]), at: 0)
    try waiting.send(.sampled(snapshot("baseline")), at: 10)
    try waiting.send(.received, at: 150)
    try waiting.fireQuiet(at: 200)
    try require(waiting.dispatches.count == 1, "quiet started a final read during unresolved attribution")
    try waiting.send(.ignored, at: 210)
    try require(waiting.dispatches.count == 2 && waiting.dispatches[1].final && waiting.dispatches[1].at == 210,
      "release after quiet starts the final read")
  }

  private static func deadline() throws {
    for phase in ["setup", "baseline", "final", "ready-at-deadline", "reply-at-deadline"] {
      var h = try Harness()
      if phase != "setup" && phase != "ready-at-deadline" {
        try h.send(.ready(coverage: ["window"]), at: 10)
        if phase == "final" || phase == "reply-at-deadline" {
          try h.send(.sampled(snapshot("older-baseline", invalidated: ["older"])), at: 20)
          try h.fireQuiet(at: 210)
        }
      }
      if phase == "ready-at-deadline" {
        try h.send(.ready(coverage: ["window"]), at: 1000)
      } else if phase == "reply-at-deadline" {
        try h.send(.sampled(snapshot("too-late", invalidated: ["late"])), at: 1000)
      } else {
        try h.send(.deadline, at: 1000)
      }
      let result = try h.completion("pending")
      try require(result.sample == nil && result.sampleStartedAt == nil
        && result.sampleCompletedAt == nil, "deadline exposed stale/in-flight sample in \(phase)")
      if phase == "ready-at-deadline" {
        try require(h.dispatches.isEmpty, "dispatched after startup consumed deadline")
      }
      if phase == "reply-at-deadline" {
        try require(result.invalidated == ["older", "late"], "deadline reply lost invalidations")
      }
      try h.assertTerminalIsSilent()
    }

    var completed = try Harness()
    try completed.send(.ready(coverage: ["window"]), at: 0)
    try completed.send(.sampled(snapshot("latest")), at: 10)
    try completed.send(.changed, at: 950)
    try completed.send(.deadline, at: 999)
    try require(completed.completions.isEmpty, "early deadline timer reported pending")
    try completed.send(.deadline, at: 1000)
    let result = try completed.completion("pending")
    try require(result.sample?.result == Data("latest".utf8)
      && result.sampleStartedAt == 0 && result.sampleCompletedAt == 10,
      "deadline without in-flight sample lost post-subscription read")
  }

  private static func budget() throws {
    var setup = try Harness()
    try setup.send(.ready(coverage: ["window"]), at: 901)
    try require(setup.dispatches.isEmpty && setup.completions.isEmpty, "early pending on short budget")
    try setup.send(.deadline, at: 1000)
    _ = try setup.completion("pending")

    var exact = try Harness()
    try exact.send(.ready(coverage: ["window"]), at: 900)
    try require(exact.dispatches.first?.budget == 100, "100ms baseline budget rejected")
    try exact.send(.cancel, at: 901)

    var final = try Harness(quietMs: 50, timeoutMs: 300)
    try final.send(.ready(coverage: ["window"]), at: 0)
    try final.send(.changed, at: 170)
    try final.send(.sampled(snapshot("baseline")), at: 180)
    try final.fireQuiet(at: 220)
    try require(final.dispatches.count == 1 && final.completions.isEmpty,
      "final dispatch or pending before deadline with <100ms")
    try final.send(.deadline, at: 300)
    let result = try final.completion("pending")
    try require(result.sample?.result == Data("baseline".utf8), "discarded completed short-budget sample")

    var finalExact = try Harness(quietMs: 200, timeoutMs: 300)
    try finalExact.send(.ready(coverage: ["window"]), at: 0)
    try finalExact.send(.sampled(snapshot("baseline")), at: 10)
    try finalExact.fireQuiet(at: 200)
    try require(finalExact.dispatches.last?.final == true
      && finalExact.dispatches.last?.budget == 100, "100ms final budget rejected")
    try finalExact.send(.sampled(snapshot("final")), at: 299)
    _ = try finalExact.completion("settled")
  }

  private static func failures() throws {
    var baseline = try Harness()
    try baseline.send(.ready(coverage: ["window"]), at: 0)
    try baseline.send(.sampled(.failure(code: "CannotComplete", message: "baseline failed")), at: 10)
    try require(baseline.completions.isEmpty, "generic baseline failure inferred destruction")
    try baseline.fireQuiet(at: 200)
    try baseline.send(.sampled(snapshot("recovered")), at: 210)
    _ = try baseline.completion("settled")

    for kind in ["error", "degraded", "missing", "unsupported"] {
      var h = try Harness()
      try h.send(.ready(coverage: ["window"]), at: 0)
      try h.send(.sampled(snapshot("baseline")), at: 10)
      try h.fireQuiet(at: 200)
      switch kind {
      case "error":
        try h.send(.sampled(.failure(code: "-32017", message: "CannotComplete")), at: 210)
        let result = try h.completion("sample_failed")
        try require(result.driverCode == "-32017" && result.message == "CannotComplete",
          "final driver error code/message were not preserved")
        try require(result.sample == nil, "final failure reused baseline")
      case "degraded":
        try h.send(.sampled(snapshot("degraded", degraded: true)), at: 210)
        let result = try h.completion("unsupported")
        try require(!result.reason.isEmpty, "degraded final lacks reason")
      case "missing":
        try h.send(.sampled(.missing), at: 210)
        let result = try h.completion("destroyed")
        try require(result.sample == nil, "missing reused snapshot")
      default:
        try h.send(.unsupported("coverage_incomplete"), at: 210)
        let result = try h.completion("unsupported")
        try require(result.reason == "coverage_incomplete", "unsupported reason lost")
      }
      try h.assertTerminalIsSilent()
    }

    var missingBaseline = try Harness()
    try missingBaseline.send(.ready(coverage: ["window"]), at: 0)
    try missingBaseline.send(.sampled(.missing), at: 10)
    _ = try missingBaseline.completion("destroyed")
  }

  private static func destruction() throws {
    var h = try Harness()
    try h.send(.ready(coverage: ["window"]), at: 0)
    try h.send(.sampled(snapshot("old", invalidated: ["prior"])), at: 10)
    try h.fireQuiet(at: 200)
    try h.send(.destroyed, at: 210)
    let result = try h.completion("destroyed")
    try require(result.sample == nil && result.invalidated == ["prior"],
      "destruction reused snapshot or lost invalidations")
    try require(h.cancelledSamples == 1, "destruction did not cancel final read")
    try h.assertTerminalIsSilent()
  }

  private static func cancellation() throws {
    for phase in ["before-start", "setup", "baseline", "waiting", "final"] {
      var h = try Harness(begin: phase != "before-start")
      if phase != "setup" && phase != "before-start" {
        try h.send(.ready(coverage: ["window"]), at: 0)
        if phase != "baseline" {
          try h.send(.sampled(snapshot("baseline")), at: 10)
          if phase == "final" { try h.fireQuiet(at: 200) }
        }
      }
      try h.send(.cancel, at: 220)
      let result = try h.completion("cancelled")
      try require(result.sample == nil, "cancel exposed snapshot")
      try require(h.cancelledSamples == (phase == "baseline" || phase == "final" ? 1 : 0),
        "in-flight cancellation was not reflected")
      try h.assertTerminalIsSilent()
    }
  }

  private static func invalidations() throws {
    var h = try Harness()
    try h.send(.ready(coverage: ["window"]), at: 0)
    try h.send(.sampled(snapshot("baseline-token", invalidated: ["a", "b", "a"])), at: 10)
    try h.fireQuiet(at: 200)
    try h.send(.changed, at: 210)
    try h.send(.sampled(snapshot("dirty-token", invalidated: ["b", "c"])), at: 220)
    try h.fireQuiet(at: 410)
    let raw = Data(#"{"snapshot_id":"opaque-driver-token","number":1e400,"text":"\ud800"}"#.utf8)
    try h.send(.sampled(.success(SettleSnapshot(result: raw,
      invalidated: ["d", "a"], degraded: false))), at: 420)
    let result = try h.completion("settled")
    try require(result.invalidated == ["a", "b", "c", "d"], "withheld invalidations not merged")
    try require(result.sample?.result == raw, "driver bytes or opaque token were rewritten")
    try h.assertTerminalIsSilent()
  }
}

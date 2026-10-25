import Foundation

struct SettleRequest {
  let pid: Int32
  let windowID: UInt32
  let quietMs: Int64
  let timeoutMs: Int64
  let session: String?
}

struct SettleSnapshot {
  let result: Data
  let invalidated: [String]
  let degraded: Bool
}

enum SettleSampleResult {
  case success(SettleSnapshot)
  case missing
  case failure(code: String?, message: String)
}

enum SettleEvent {
  case ready(coverage: [String])
  case received
  case changed
  case ignored
  case destroyed
  case unsupported(String)
  case quiet(Int)
  case deadline
  case sampled(SettleSampleResult)
  case sampleStarted
  case cancel
}

enum SettleEffect {
  case observe
  case detach
  case scheduleQuiet(epoch: Int, at: Int64)
  case scheduleDeadline(at: Int64)
  case cancelQuiet
  case cancelDeadline
  case sample(final: Bool, timeoutMs: Int)
  case cancelSample
  case finish(SettleCompletion)
}

struct SettleCompletion {
  let outcome: String
  let reason: String
  let sample: SettleSnapshot?
  let sampleStartedAt: Int64?
  let sampleCompletedAt: Int64?
  let invalidated: [String]
  let coverage: [String]
  let observedQuietMs: Int64
  let driverCode: String?
  let message: String?
}

struct WindowSettleState {
  private struct PendingSample {
    let final: Bool
    var startedAt: Int64
    let epoch: Int
  }

  private struct CompletedSample {
    let snapshot: SettleSnapshot
    let startedAt: Int64
    let completedAt: Int64
  }

  private let request: SettleRequest
  private let deadlineAt: Int64
  private var begun = false
  private var subscribed = false
  private var coverage: [String] = []
  private var quietEpoch = 0
  private var lastChangeAt: Int64?
  private var pendingSample: PendingSample?
  private var latestSample: CompletedSample?
  // AX callbacks are serial, so at most one received notification awaits attribution. While it
  // does, quiet cannot start the final read and a final sample waits for the verdict.
  private var attributing = false
  private var heldFinal: (sample: CompletedSample, epoch: Int)?
  private var invalidated: [String] = []
  private var invalidatedSet: Set<String> = []
  private(set) var isFinished = false

  var inFlight: Bool { pendingSample != nil }

  init(request: SettleRequest, now: Int64) {
    self.request = request
    deadlineAt = now + request.timeoutMs
  }

  mutating func begin() -> [SettleEffect] {
    guard !begun && !isFinished else { return [] }
    begun = true
    return [.scheduleDeadline(at: deadlineAt), .observe]
  }

  mutating func receive(_ event: SettleEvent, now: Int64) -> [SettleEffect] {
    guard !isFinished else { return [] }
    if case .cancel = event {
      return finish("cancelled", reason: "cancelled", now: now)
    }
    guard begun else { return [] }

    // A reply delivered at the deadline still invalidates tokens even though it cannot
    // establish freshness. Replies after terminal belong to the bridge's drain fence.
    if case .sampled(.success(let snapshot)) = event, inFlight {
      mergeInvalidations(snapshot.invalidated)
    }
    if now >= deadlineAt {
      return finish("pending", reason: "deadline", now: now,
        sample: inFlight ? nil : latestSample)
    }

    switch event {
    case .sampleStarted:
      guard pendingSample != nil else { return [] }
      pendingSample?.startedAt = now
      return []
    case .ready(let readyCoverage):
      guard !subscribed else { return [] }
      subscribed = true
      coverage = readyCoverage
      let effects = resetQuiet(now: now)
      return effects + dispatchSample(final: false, now: now)
    case .received:
      guard subscribed else { return [] }
      attributing = true
      return []
    case .ignored:
      guard attributing else { return [] }
      attributing = false
      if let held = heldFinal {
        heldFinal = nil
        if held.epoch == quietEpoch {
          return finish("settled", reason: "quiet_window", now: now, sample: held.sample)
        }
      }
      return sampleAfterQuiet(now: now)
    case .changed:
      attributing = false
      heldFinal = nil
      guard subscribed else { return [] }
      return [.cancelQuiet] + resetQuiet(now: now)
    case .destroyed:
      return finish("destroyed", reason: "window_destroyed", now: now)
    case .unsupported(let reason):
      return finish("unsupported", reason: reason, now: now)
    case .quiet(let epoch):
      guard subscribed && epoch == quietEpoch else { return [] }
      return sampleAfterQuiet(now: now)
    case .sampled(let result):
      guard let pending = pendingSample else { return [] }
      pendingSample = nil
      switch result {
      case .missing:
        return finish("destroyed", reason: "window_id_not_found", now: now)
      case .failure(let code, let message):
        if pending.final {
          return finish("sample_failed", reason: "final_sample_failed", now: now,
            driverCode: code, message: message)
        }
      case .success(let snapshot):
        let completed = CompletedSample(snapshot: snapshot,
          startedAt: pending.startedAt, completedAt: now)
        latestSample = completed
        if pending.final {
          if snapshot.degraded {
            return finish("unsupported", reason: "degraded_final_sample", now: now)
          }
          if pending.epoch == quietEpoch {
            if attributing {
              heldFinal = (completed, pending.epoch)
              return []
            }
            return finish("settled", reason: "quiet_window", now: now, sample: completed)
          }
        }
      }
      return sampleAfterQuiet(now: now)
    case .deadline, .cancel:
      return []
    }
  }

  private mutating func resetQuiet(now: Int64) -> [SettleEffect] {
    quietEpoch += 1
    lastChangeAt = now
    return [.scheduleQuiet(epoch: quietEpoch, at: now + request.quietMs)]
  }

  private func observedQuiet(now: Int64) -> Int64 {
    guard let changedAt = lastChangeAt else { return 0 }
    return max(0, now - changedAt)
  }

  private mutating func sampleAfterQuiet(now: Int64) -> [SettleEffect] {
    guard subscribed && !attributing && observedQuiet(now: now) >= request.quietMs else { return [] }
    let effects = dispatchSample(final: true, now: now)
    return effects.isEmpty ? [] : [.cancelQuiet] + effects
  }

  private mutating func dispatchSample(final: Bool, now: Int64) -> [SettleEffect] {
    let remaining = deadlineAt - now
    guard !inFlight && remaining >= 100 else { return [] }
    pendingSample = PendingSample(final: final, startedAt: now, epoch: quietEpoch)
    return [.sample(final: final, timeoutMs: Int(remaining))]
  }

  private mutating func mergeInvalidations(_ tokens: [String]) {
    for token in tokens where invalidatedSet.insert(token).inserted {
      invalidated.append(token)
    }
  }

  private mutating func finish(
    _ outcome: String, reason: String, now: Int64, sample: CompletedSample? = nil,
    driverCode: String? = nil, message: String? = nil
  ) -> [SettleEffect] {
    let cancelSample = inFlight
    isFinished = true
    pendingSample = nil
    let completion = SettleCompletion(
      outcome: outcome, reason: reason, sample: sample?.snapshot,
      sampleStartedAt: sample?.startedAt, sampleCompletedAt: sample?.completedAt,
      invalidated: invalidated, coverage: coverage, observedQuietMs: observedQuiet(now: now),
      driverCode: driverCode, message: message)
    var effects: [SettleEffect] = [.cancelQuiet, .cancelDeadline, .detach]
    if cancelSample { effects.append(.cancelSample) }
    effects.append(.finish(completion))
    return effects
  }
}

// A person's own keyboard and pointer use while an agent connection runs (#1235).

import CoreGraphics
import Foundation

/// Which tapped events are reported, kept free of the system so it can be tested
/// (apps/desktop/src/cua/ComputerUseHelperInput.test.ts). It is given an event's type and the time
/// it arrived, nothing else, and reports every pointer event with its own time: none is dropped,
/// held back or merged here (#1488). The lease proxy sends whatever has piled up in one report
/// (apps/server/src/cua/agentInputReports.ts), so a stream of moves cannot queue the safety
/// reports behind each other.
enum PointerTap {
  /// The eventSourceUserData tag ("GOATCUA1") the GOAT driver sets on pointer CGEvents it posts.
  static let driverEventUserData: Int64 = 0x474F_4154_4355_4131

  /// Pointer event types the tap reports as activity.
  static let types: [CGEventType] = [
    .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
    .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  ]

  static func isDriverOwned(userData: Int64) -> Bool {
    userData == driverEventUserData
  }

  /// The time to report for a tapped event of `type` that arrived at `at`, or nil.
  static func report(_ type: CGEventType, userData: Int64 = 0, at: Double) -> Double? {
    guard !isDriverOwned(userData: userData) else { return nil }
    return types.contains(type) ? at : nil
  }
}

enum EscapeTap {
  static func shouldStop(type: CGEventType, keyCode: Int64, userData: Int64, active: Bool) -> Bool {
    active && type == .keyDown && keyCode == 53 && !PointerTap.isDriverOwned(userData: userData)
  }
}

/// One kind's poll of its newest event, kept free of the system so it can be tested. The system
/// keeps only each kind's newest event, so a poll reports at most one; two events of a kind within
/// one interval show as the later one. The interval is short so that hardly happens between a
/// person's key and an agent's next one: the driver types about one key every 38 ms.
struct PolledKind {
  static let interval = 0.025
  private var latest: Double

  /// Whatever happened before this connection is no one's concern here.
  init(newestAtStart: Double) { latest = newestAtStart }

  /// The time to report for the kind's newest event, or nil when it was already reported.
  mutating func poll(newest at: Double) -> Double? {
    // A millisecond of slack: the same event read twice must not count as a new one.
    guard at.isFinite, at > latest + 0.001 else { return nil }
    latest = at
    return at
  }
}

/// Reports a person's keyboard and pointer use: the kind and the time only, never a key, a
/// position, a button or a window. The driver posts some of the agent's input through the same
/// system, so this reports the agent's events too; the lease proxy and the server know when input
/// calls ran and keep only the rest (apps/server/src/cua/agentInputLog.ts).
///
/// Pointer events come one by one from a listen-only event tap, which needs no grant. Keyboard
/// events are polled every PolledKind.interval. With Input Monitoring, Esc is also read by the
/// tap. If no tap can be made, the
/// pointer is polled the same way. Nothing listens once the connection ends.
final class InputActivity {
  private static let keyboard: [CGEventType] = [.keyDown, .flagsChanged]
  private let report: (String, Double) -> Void
  private let onEscape: () -> Void
  private let isActive: () -> Bool
  private(set) var escapeAvailable = false
  private let queue = DispatchQueue(label: "si.goat.computer-use.input")
  private var tap: CFMachPort?
  private var timer: DispatchSourceTimer?
  private var polled: [(source: String, types: [CGEventType], kind: PolledKind)] = []
  private var stopped = false
  private var tapLoop: CFRunLoop?

  /// `at` is on `InputActivity.now()`'s clock, so a later writer can say how long ago it was.
  init(
    report: @escaping (_ source: String, _ at: Double) -> Void,
    isActive: @escaping () -> Bool = { false },
    onEscape: @escaping () -> Void = {}
  ) {
    self.report = report
    self.isActive = isActive
    self.onEscape = onEscape
  }

  /// Seconds on a clock that never steps back with the wall clock.
  static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

  /// Stops listening; nothing is reported after it returns, and it is safe to call again.
  func stop() {
    let loop: CFRunLoop? = queue.sync {
      stopped = true
      timer?.cancel()
      timer = nil
      return tapLoop
    }
    if let tap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
    }
    if let loop { CFRunLoopStop(loop) }
  }

  func start() {
    let tapped = startTap()
    startPolling(
      [("keyboard", Self.keyboard)] + (tapped ? [] : [("pointer", PointerTap.types)]))
  }

  // MARK: Pointer tap

  private func startTap() -> Bool {
    let pointerMask = PointerTap.types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let keyboardAllowed = CGPreflightListenEventAccess()
    let mask = pointerMask | (keyboardAllowed ? (CGEventMask(1) << CGEventType.keyDown.rawValue) : 0)
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, type, event, info in
          // Read only the driver tag and, on keyDown, the key code used to detect Esc.
          if let info {
            let userData = event.getIntegerValueField(.eventSourceUserData)
            let keyCode = type == .keyDown ? event.getIntegerValueField(.keyboardEventKeycode) : -1
            Unmanaged<InputActivity>.fromOpaque(info).takeUnretainedValue()
              .received(type, userData: userData, keyCode: keyCode)
          }
          return Unmanaged.passUnretained(event)
        },
        userInfo: Unmanaged.passUnretained(self).toOpaque())
    else { return false }
    self.tap = tap
    escapeAvailable = keyboardAllowed
    let thread = Thread {
      let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      let loop = CFRunLoopGetCurrent()
      let stopped: Bool = self.queue.sync {
        self.tapLoop = loop
        return self.stopped
      }
      if !stopped { CFRunLoopRun() }
    }
    thread.name = "si.goat.computer-use.pointer-tap"
    thread.start()
    return true
  }

  /// On the tap's thread, as each event arrives.
  private func received(_ type: CGEventType, userData: Int64 = 0, keyCode: Int64 = -1) {
    // The system turns off a tap it judges slow or during secure input; listening goes on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    let at = Self.now()
    queue.async { [self] in
      guard !stopped else { return }
      if EscapeTap.shouldStop(type: type, keyCode: keyCode, userData: userData, active: isActive()) {
        onEscape()
      }
      if let at = PointerTap.report(type, userData: userData, at: at) { report("pointer", at) }
    }
  }

  // MARK: Polling

  /// When the newest event of these types happened, on now()'s clock.
  private static func newest(_ types: [CGEventType], now: Double) -> Double {
    now
      - (types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
        .min() ?? .infinity)
  }

  private func startPolling(_ kinds: [(source: String, types: [CGEventType])]) {
    queue.async { [self] in
      guard !stopped else { return }
      let now = Self.now()
      polled = kinds.map {
        ($0.source, $0.types, PolledKind(newestAtStart: Self.newest($0.types, now: now)))
      }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(
        deadline: .now() + PolledKind.interval, repeating: PolledKind.interval,
        leeway: .milliseconds(5))
      timer.setEventHandler { [weak self] in self?.poll() }
      timer.resume()
      self.timer = timer
    }
  }

  private func poll() {
    guard !stopped else { return }
    let now = Self.now()
    for index in polled.indices {
      let at = Self.newest(polled[index].types, now: now)
      if let at = polled[index].kind.poll(newest: at) { report(polled[index].source, at) }
    }
  }
}

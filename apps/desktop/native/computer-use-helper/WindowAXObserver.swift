import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

enum SettleWatchEvent {
  case ready([String])
  case changed
  case destroyed
  case unsupported(String)
}

protocol SettleWatch: AnyObject {
  func start(_ emit: @escaping (SettleWatchEvent) -> Void)
  func check(_ ready: @escaping (Bool) -> Void)
  func cancel()
}

func makeWindowSettleWatch(pid: Int32, windowID: UInt32, permitted: @escaping () -> Bool) -> SettleWatch {
  WindowAXWatch(pid: pid, windowID: windowID, api: SystemWindowAX(), executor: WindowAXRunLoop(),
    permitted: permitted)
}

// The wrapper owns its CF reference; fixture references are invented CF strings, never AX objects.
final class WindowAXElement {
  let reference: CFTypeRef
  init(_ reference: CFTypeRef) { self.reference = reference }
  func same(_ other: WindowAXElement) -> Bool { CFEqual(reference, other.reference) }
}

enum WindowAXAttribute {
  case element(WindowAXElement)
  case elements([WindowAXElement])
  case string(String)
  case absent
  case failure
}

protocol WindowAXSubscription: AnyObject {
  func add(_ element: WindowAXElement, notification: String) -> Bool
  func attach()
  func invalidate()
  func detach()
}

protocol WindowAXFunctions: AnyObject {
  func trusted() -> Bool
  func ownerPID(_ windowID: UInt32) -> Int32?
  func application(_ pid: Int32) -> WindowAXElement?
  func pid(_ element: WindowAXElement) -> Int32?
  func windowID(_ element: WindowAXElement) -> UInt32?
  func attribute(_ element: WindowAXElement, _ name: String) -> WindowAXAttribute
  func observer(_ pid: Int32, _ receive: @escaping (WindowAXElement, String) -> Void)
    -> WindowAXSubscription?
}

protocol WindowAXExecutor: AnyObject {
  func start(_ body: @escaping () -> Void)
  func enqueue(_ body: @escaping () -> Void)
  func finish()
}

private final class WindowAXSampleCheck {
  let ready: (Bool) -> Void
  init(_ ready: @escaping (Bool) -> Void) { self.ready = ready }
}

final class WindowAXWatch: SettleWatch {
  static let required = ["AXUIElementDestroyed", "AXValueChanged", "AXTitleChanged", "AXMoved",
    "AXResized", "AXSelectedChildrenChanged", "AXSelectedTextChanged", "AXFocusedUIElementChanged",
    "AXFocusedWindowChanged", "AXWindowCreated", "AXLayoutChanged"]

  private let pid: Int32
  private let windowID: UInt32
  private let api: WindowAXFunctions
  private let executor: WindowAXExecutor
  private let permitted: () -> Bool
  private let lock = NSLock()
  private var active = true
  private var started = false
  private var emit: ((SettleWatchEvent) -> Void)?
  private var pendingCheck: WindowAXSampleCheck?
  private var subscription: WindowAXSubscription?
  // All fields below are confined to the observer runloop.
  private var app: WindowAXElement?
  private var target: WindowAXElement?
  private var otherWindows: [WindowAXElement] = []
  private var subscribed = false

  init(pid: Int32, windowID: UInt32, api: WindowAXFunctions, executor: WindowAXExecutor,
    permitted: @escaping () -> Bool = { true }) {
    self.pid = pid
    self.windowID = windowID
    self.api = api
    self.executor = executor
    self.permitted = permitted
  }

  private var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return active
  }

  private var isAdmitted: Bool {
    guard isActive else { return false }
    // Runtime identity/approval lookup is external code and must never hold the invalidation lock.
    guard permitted() else {
      if isActive { refuse("app_not_approved") }
      return false
    }
    return isActive
  }

  func start(_ emit: @escaping (SettleWatchEvent) -> Void) {
    lock.lock()
    guard active, !started else { lock.unlock(); return }
    started = true
    self.emit = emit
    lock.unlock()
    executor.start { [self] in setup() }
  }

  func cancel() {
    lock.lock()
    let needsCleanup = active && started
    active = false
    emit = nil
    let pending = pendingCheck
    pendingCheck = nil
    let observer = subscription
    lock.unlock()
    observer?.invalidate()
    pending?.ready(false)
    if needsCleanup { executor.enqueue { [self] in cleanup() } }
  }

  func check(_ ready: @escaping (Bool) -> Void) {
    let request = WindowAXSampleCheck(ready)
    lock.lock()
    // The coordinator serializes samples; keep at most one validation queued for that sample.
    guard active, started, pendingCheck == nil else { lock.unlock(); ready(false); return }
    pendingCheck = request
    lock.unlock()
    executor.enqueue { [self] in
      guard isAdmitted else { complete(request, safe: false); return }
      if let reason = sampleRefusalReason() {
        if isActive { refuse(reason) }
        complete(request, safe: false)
      } else { complete(request, safe: true) }
    }
  }

  private func complete(_ request: WindowAXSampleCheck, safe: Bool) {
    if safe && !isAdmitted { return }
    lock.lock()
    guard pendingCheck === request else { lock.unlock(); return }
    pendingCheck = nil
    let permitted = active && safe
    lock.unlock()
    request.ready(permitted)
  }

  private func sampleRefusalReason() -> String? {
    guard isAdmitted else { return "invalidated" }
    guard subscribed, let app, let target else { return "observer_not_ready" }
    guard api.trusted() else { return "accessibility_not_granted" }
    guard isAdmitted else { return "invalidated" }
    guard api.ownerPID(windowID) == pid else { return "window_owner_changed" }
    guard isAdmitted else { return "invalidated" }
    guard api.windowID(target) == windowID else { return "window_identity_changed" }
    guard isAdmitted else { return "invalidated" }
    guard api.pid(target) == pid else { return "window_pid_mismatch" }
    guard privacyIsKnownSafe(app) else { return "private_or_unknown_focus" }
    return isAdmitted ? nil : "invalidated"
  }

  private func deliver(_ event: SettleWatchEvent, terminal: Bool = false) {
    if !terminal && !isAdmitted { return }
    lock.lock()
    guard active else { lock.unlock(); return }
    if terminal { active = false }
    let callback = emit
    let pending = terminal ? pendingCheck : nil
    if terminal { emit = nil; pendingCheck = nil }
    lock.unlock()
    // The caller updates its core synchronously here, then schedules IO outside its lock.
    // Its generation fence also covers a delivery already admitted when cancellation arrives.
    // Terminal state lands before cleanup: detachment is blocking AX IPC, during which the
    // driver could otherwise finish a final sample as settled.
    callback?(event)
    pending?.ready(false)
    if terminal { cleanup() }
  }

  private func refuse(_ reason: String) { deliver(.unsupported(reason), terminal: true) }

  private func cleanup() {
    lock.lock()
    let observer = subscription
    lock.unlock()
    // Keep it published until locally invalidated, so a concurrent cancel always finds a fence.
    observer?.invalidate()
    lock.lock()
    subscription = nil
    lock.unlock()
    observer?.detach()
    target = nil
    otherWindows = []
    app = nil
    subscribed = false
    executor.finish()
  }

  private func setup() {
    defer { if !isActive { cleanup() } }
    guard isAdmitted else { return }
    guard api.trusted() else { return refuse("accessibility_not_granted") }
    guard isAdmitted else { return }
    guard pid > 0, api.ownerPID(windowID) == pid else { return refuse("window_owner_unknown") }
    guard isAdmitted else { return }
    guard let app = api.application(pid) else { return refuse("application_unavailable") }
    self.app = app
    guard isAdmitted else { return }
    guard case .elements(let windows) = api.attribute(app, "AXWindows") else {
      return refuse("window_mapping_unavailable")
    }
    var matches: [WindowAXElement] = []
    for window in windows {
      guard isAdmitted else { return }
      guard let id = api.windowID(window) else { return refuse("window_mapping_unavailable") }
      if id == windowID { matches.append(window) }
    }
    guard matches.count == 1, let target = matches.first else { return refuse("window_mapping_ambiguous") }
    self.target = target
    otherWindows = windows.filter { !$0.same(target) }
    guard isAdmitted else { return }
    guard api.pid(target) == pid else { return refuse("window_pid_mismatch") }
    guard isAdmitted else { return }
    guard case .string("AXWindow") = api.attribute(target, "AXRole") else {
      return refuse("window_role_unknown")
    }
    guard privacyIsKnownSafe(app) else { if isActive { refuse("private_or_unknown_focus") }; return }
    guard isAdmitted else { return }
    guard let observer = api.observer(pid, { [weak self] element, name in self?.receive(element, name) }) else {
      return refuse("observer_unavailable")
    }
    lock.lock()
    subscription = observer
    let cancelled = !active
    lock.unlock()
    if cancelled { observer.invalidate(); return }
    for name in Self.required {
      guard isAdmitted else { return }
      guard observer.add(app, notification: name) else { return refuse("notification_unsupported:\(name)") }
    }
    guard isAdmitted else { return }
    observer.attach()
    guard isAdmitted else { return }
    // Register before readiness, and revalidate changes made while registration was in flight.
    guard api.ownerPID(windowID) == pid else { return refuse("window_owner_changed") }
    guard isAdmitted else { return }
    guard api.windowID(target) == windowID else { return refuse("window_identity_changed") }
    guard privacyIsKnownSafe(app) else { if isActive { refuse("private_or_unknown_focus") }; return }
    subscribed = true
    deliver(.ready(Self.required))
  }

  private func privacyIsKnownSafe(_ app: WindowAXElement) -> Bool {
    guard isAdmitted else { return false }
    guard api.trusted() else { return false }
    guard isAdmitted else { return false }
    guard case .element(let focused) = api.attribute(app, "AXFocusedUIElement") else { return false }
    guard !focused.same(app) else { return false }
    var node = focused
    var seen: [WindowAXElement] = []
    for _ in 0..<128 {
      guard isAdmitted else { return false }
      if node.same(app) { return true }
      guard !seen.contains(where: { $0.same(node) }) else { return false }
      seen.append(node)
      guard case .string(let role) = api.attribute(node, "AXRole"), !role.isEmpty,
        role != "AXSecureTextField", role != "AXUnknown" else { return false }
      guard isAdmitted else { return false }
      switch api.attribute(node, "AXSubrole") {
      case .string(let subrole): if subrole == "AXSecureTextField" { return false }
      case .absent: if role == "AXTextField" { return false }
      default: return false
      }
      guard isAdmitted else { return false }
      guard case .element(let parent) = api.attribute(node, "AXParent") else { return false }
      node = parent
    }
    return false
  }

  private func receive(_ element: WindowAXElement, _ notification: String) {
    guard isAdmitted, let target, let app else { return }
    // Destruction invalidates the callback's element. Compare retained identity before any query.
    if notification == "AXUIElementDestroyed" {
      if element.same(target) { deliver(.destroyed, terminal: true) }
      else if otherWindows.contains(where: { $0.same(element) }) { return }
      else { refuse("destroyed_element_ancestry_unknown") }
      return
    }
    guard Self.required.contains(notification) else { return refuse("notification_unknown") }
    guard privacyIsKnownSafe(app) else { if isActive { refuse("private_or_unknown_focus") }; return }
    var node = element
    var seen: [WindowAXElement] = []
    for _ in 0..<128 {
      guard isAdmitted else { return }
      if node.same(target) { deliver(.changed); return }
      if node.same(app) { return refuse("event_window_ambiguous") }
      guard !seen.contains(where: { $0.same(node) }) else { return refuse("event_ancestry_cycle") }
      seen.append(node)
      guard api.pid(node) == pid else { return refuse("event_pid_unknown") }
      guard isAdmitted else { return }
      guard case .string(let role) = api.attribute(node, "AXRole"), !role.isEmpty,
        role != "AXUnknown" else { return refuse("event_role_unknown") }
      if role == "AXWindow" {
        guard isAdmitted else { return }
        guard let id = api.windowID(node) else { return refuse("event_window_unknown") }
        if id == windowID { return refuse("event_target_identity_changed") }
        return
      }
      guard isAdmitted else { return }
      guard case .element(let parent) = api.attribute(node, "AXParent") else {
        return refuse("event_ancestry_unknown")
      }
      node = parent
    }
    refuse("event_ancestry_limit")
  }

}

private final class WindowAXRunLoop: WindowAXExecutor {
  private let lock = NSLock()
  private var loop: CFRunLoop?
  private var pending: [() -> Void] = []
  private var finished = false

  func start(_ body: @escaping () -> Void) {
    Thread.detachNewThread { [self] in
      let current = CFRunLoopGetCurrent()!
      var context = CFRunLoopSourceContext()
      let keepAlive = CFRunLoopSourceCreate(nil, 0, &context)!
      CFRunLoopAddSource(current, keepAlive, .defaultMode)
      lock.lock()
      loop = current
      let work = pending
      pending = []
      lock.unlock()
      body()
      for item in work { item() }
      lock.lock()
      let shouldRun = !finished
      lock.unlock()
      if shouldRun { CFRunLoopRun() }
      CFRunLoopRemoveSource(current, keepAlive, .defaultMode)
      lock.lock()
      loop = nil
      pending = []
      lock.unlock()
    }
  }

  func enqueue(_ body: @escaping () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return }
    if let loop {
      CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, body)
      CFRunLoopWakeUp(loop)
    } else { pending.append(body) }
  }

  func finish() {
    lock.lock()
    finished = true
    if let loop { CFRunLoopStop(loop) }
    lock.unlock()
  }
}

private final class SystemWindowAX: WindowAXFunctions {
  private typealias WindowBridge = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  private let bridge: WindowBridge?
  private let framework: UnsafeMutableRawPointer?

  init() {
    // Resolve our own bridge in the system framework; no driver implementation or token state.
    framework = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
    if let handle = framework {
      if let symbol = dlsym(handle, "_AXUIElementGetWindow") {
        bridge = unsafeBitCast(symbol, to: WindowBridge.self)
      } else { bridge = nil }
    } else { bridge = nil }
  }

  deinit { if let framework { dlclose(framework) } }

  private func ax(_ element: WindowAXElement) -> AXUIElement? {
    guard CFGetTypeID(element.reference) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(element.reference, to: AXUIElement.self)
  }

  func trusted() -> Bool { AXIsProcessTrusted() }

  func ownerPID(_ windowID: UInt32) -> Int32? {
    guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
      rows.count == 1, let row = rows.first,
      (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID,
      let owner = row[kCGWindowOwnerPID as String] as? NSNumber
    else { return nil }
    return owner.int32Value
  }

  func application(_ pid: Int32) -> WindowAXElement? { WindowAXElement(AXUIElementCreateApplication(pid)) }

  func pid(_ element: WindowAXElement) -> Int32? {
    guard let element = ax(element) else { return nil }
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
  }

  func windowID(_ element: WindowAXElement) -> UInt32? {
    guard let bridge, let element = ax(element) else { return nil }
    var id: CGWindowID = 0
    guard bridge(element, &id) == .success, id != 0 else { return nil }
    return id
  }

  func attribute(_ element: WindowAXElement, _ name: String) -> WindowAXAttribute {
    guard let element = ax(element) else { return .failure }
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if error == .noValue || error == .attributeUnsupported { return .absent }
    guard error == .success, let value else { return .failure }
    if CFGetTypeID(value) == AXUIElementGetTypeID() { return .element(WindowAXElement(value)) }
    if let string = value as? String { return .string(string) }
    if CFGetTypeID(value) == CFArrayGetTypeID(), let values = value as? [CFTypeRef] {
      guard values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { return .failure }
      return .elements(values.map(WindowAXElement.init))
    }
    return .failure
  }

  func observer(_ pid: Int32, _ receive: @escaping (WindowAXElement, String) -> Void)
    -> WindowAXSubscription? {
    SystemWindowAXSubscription(pid: pid, receive: receive)
  }
}

private final class WindowAXCallbackBox {
  var receive: ((WindowAXElement, String) -> Void)?
  init(_ receive: @escaping (WindowAXElement, String) -> Void) { self.receive = receive }
}

private final class SystemWindowAXSubscription: WindowAXSubscription {
  private let fenceLock = NSLock()
  private var source: CFRunLoopSource?
  private var invalidated = false
  private var observer: AXObserver?
  private let context: UnsafeMutableRawPointer
  private var registrations: [(WindowAXElement, String)] = []
  private var loop: CFRunLoop?

  init?(pid: Int32, receive: @escaping (WindowAXElement, String) -> Void) {
    context = Unmanaged.passRetained(WindowAXCallbackBox(receive)).toOpaque()
    let result = AXObserverCreate(pid, { _, element, name, refcon in
      guard let refcon else { return }
      let box = Unmanaged<WindowAXCallbackBox>.fromOpaque(refcon).retain().takeRetainedValue()
      box.receive?(WindowAXElement(element), name as String)
      withExtendedLifetime(box) {}
    }, &observer)
    guard result == .success, let observer else {
      Unmanaged<WindowAXCallbackBox>.fromOpaque(context).release()
      return nil
    }
    source = AXObserverGetRunLoopSource(observer)
  }

  func add(_ element: WindowAXElement, notification: String) -> Bool {
    guard let observer, CFGetTypeID(element.reference) == AXUIElementGetTypeID() else { return false }
    let ax = unsafeBitCast(element.reference, to: AXUIElement.self)
    guard AXObserverAddNotification(observer, ax, notification as CFString, context) == .success else {
      return false
    }
    registrations.append((element, notification))
    return true
  }

  func attach() {
    fenceLock.lock()
    defer { fenceLock.unlock() }
    guard !invalidated, let source else { return }
    loop = CFRunLoopGetCurrent()
    CFRunLoopAddSource(loop, source, .defaultMode)
  }

  func invalidate() {
    // This local CF operation must remain independent of any blocking AX messaging on the runloop.
    fenceLock.lock()
    defer { fenceLock.unlock() }
    guard !invalidated else { return }
    invalidated = true
    if let source { CFRunLoopSourceInvalidate(source) }
  }

  func detach() {
    guard let observer else { return }
    invalidate()
    // Callbacks and teardown share one runloop. Retire delivery before removing its source/refcon.
    Unmanaged<WindowAXCallbackBox>.fromOpaque(context).takeUnretainedValue().receive = nil
    fenceLock.lock()
    let source = self.source
    let attachedLoop = loop
    self.source = nil
    loop = nil
    fenceLock.unlock()
    if let source, let attachedLoop { CFRunLoopRemoveSource(attachedLoop, source, .defaultMode) }
    for (element, notification) in registrations {
      let ax = unsafeBitCast(element.reference, to: AXUIElement.self)
      AXObserverRemoveNotification(observer, ax, notification as CFString)
    }
    registrations = []
    self.observer = nil
    // The callback owns a temporary retain while unwinding; invalidating the source fences new ones.
    Unmanaged<WindowAXCallbackBox>.fromOpaque(context).release()
  }
}

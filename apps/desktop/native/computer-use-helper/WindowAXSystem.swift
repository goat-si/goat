import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

// The live AX adapter: a dedicated observer runloop, the system accessibility calls, and the
// AXObserver subscription. Fixtures replace all of this through WindowAXFunctions.
func makeWindowSettleWatch(pid: Int32, windowID: UInt32, permitted: @escaping () -> Bool) -> SettleWatch {
  WindowAXWatch(pid: pid, windowID: windowID, api: SystemWindowAX(), executor: WindowAXRunLoop(),
    permitted: permitted)
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
    if error == .noValue { return .absent }
    if error == .attributeUnsupported { return .unsupported }
    guard error == .success else { return .error(error.rawValue) }
    guard let value else { return .failure }
    if CFGetTypeID(value) == AXUIElementGetTypeID() { return .element(WindowAXElement(value)) }
    if let string = value as? String { return .string(string) }
    if CFGetTypeID(value) == CFArrayGetTypeID(), let values = value as? [CFTypeRef] {
      guard values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { return .failure }
      return .elements(values.map(WindowAXElement.init))
    }
    return .failure
  }

  func childCount(_ element: WindowAXElement) -> WindowAXCount {
    guard let element = ax(element) else { return .error(AXError.illegalArgument.rawValue) }
    var count: CFIndex = 0
    let error = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
    if error == .noValue { return .absent }
    if error == .attributeUnsupported { return .unsupported }
    return error == .success ? .count(count) : .error(error.rawValue)
  }

  func children(_ element: WindowAXElement, max: Int) -> WindowAXAttribute {
    guard let element = ax(element), max > 0 else { return .failure }
    var values: CFArray?
    let error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, max, &values)
    if error == .noValue { return .absent }
    if error == .attributeUnsupported { return .unsupported }
    guard error == .success else { return .error(error.rawValue) }
    guard let list = values as? [CFTypeRef] else { return .failure }
    guard list.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { return .failure }
    return .elements(list.map(WindowAXElement.init))
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

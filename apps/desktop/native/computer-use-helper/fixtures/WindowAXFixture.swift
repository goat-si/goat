import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL \(message)\n".utf8))
    exit(1)
  }
}

private func manifest(_ apps: [String], tools: [String] = ["get_window_state"]) -> String {
  func quote(_ value: String) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
  }
  return (["# Written by GOAT at each driver start. See ADR-0022.", "version: 3",
    "resources:", "  desktop:", "    display: true"]
    + (apps.isEmpty ? ["  apps: []"] : ["  apps:"] + apps.map { "    - bundle_id: " + quote($0) })
    + ["allow:", "  tools:"] + tools.map { "    - " + quote($0) } + [""]).joined(separator: "\n")
}

private final class ManualAXExecutor: WindowAXExecutor {
  var work: [() -> Void] = []
  var finished = false
  func start(_ body: @escaping () -> Void) { work.append(body) }
  func enqueue(_ body: @escaping () -> Void) { if !finished { work.append(body) } }
  func finish() { finished = true }
  func drain() {
    // Work is finite and explicitly supplied by the test; this never polls an external condition.
    let batch = work
    work = []
    for body in batch { body() }
  }
}

private final class FakeAXSubscription: WindowAXSubscription {
  var registered: [String] = []
  var roots: [String] = []
  var failNotification: String?
  var attached = false
  var invalidated = false
  var detached = false
  var duringAdd: (() -> Void)?
  var duringAttach: (() -> Void)?
  var duringDetach: (() -> Void)?
  func add(_ element: WindowAXElement, notification: String) -> Bool {
    roots.append(element.reference as! String)
    registered.append(notification)
    duringAdd?()
    return notification != failNotification
  }
  func attach() {
    duringAttach?()
    if !invalidated { attached = true }
  }
  func invalidate() { invalidated = true }
  func detach() { duringDetach?(); invalidate(); detached = true }
}

private final class FakeAX: WindowAXFunctions {
  let app = WindowAXElement("app" as NSString)
  let window = WindowAXElement("window" as NSString)
  let other = WindowAXElement("other" as NSString)
  let child = WindowAXElement("child" as NSString)
  let foreignChild = WindowAXElement("foreign-child" as NSString)
  let focus = WindowAXElement("focus" as NSString)
  let unknown = WindowAXElement("unknown" as NSString)
  let subscription = FakeAXSubscription()
  var receive: ((WindowAXElement, String) -> Void)?
  var queries: [String] = []
  var permission = true
  var owner: Int32? = 42
  var privateFocus = false
  var missingFocus = false
  var missingSubrole = false
  var duplicateTarget = false
  var unknownMapping = false
  var cannotComplete = false
  var duringAttribute: (() -> Void)?
  var duringObserver: (() -> Void)?
  var observerCount = 0
  var windowPID: Int32? = 42
  var childWindowID: UInt32?
  var childParent: WindowAXElement?

  func key(_ element: WindowAXElement) -> String { element.reference as! String }
  func trusted() -> Bool { queries.append("trusted"); return permission }
  func ownerPID(_ windowID: UInt32) -> Int32? { queries.append("owner"); return owner }
  func application(_ pid: Int32) -> WindowAXElement? { queries.append("application"); return app }
  func pid(_ element: WindowAXElement) -> Int32? {
    queries.append("pid:\(key(element))")
    return element.same(window) ? windowPID : 42
  }
  func windowID(_ element: WindowAXElement) -> UInt32? {
    queries.append("id:\(key(element))")
    if cannotComplete { return nil }
    if element.same(window) { return unknownMapping ? nil : 7 }
    if element.same(child) { return childWindowID }
    return element.same(other) ? 8 : nil
  }
  func attribute(_ element: WindowAXElement, _ name: String) -> WindowAXAttribute {
    queries.append("\(key(element)):\(name)")
    duringAttribute?()
    if cannotComplete { return .failure }
    switch name {
    case "AXWindows": return .elements(duplicateTarget ? [window, window] : [window, other])
    case "AXFocusedUIElement": return missingFocus ? .failure : .element(focus)
    case "AXRole": return .string(element.same(window) || element.same(other) ? "AXWindow" : "AXTextField")
    case "AXSubrole": return missingSubrole ? .absent : .string(privateFocus && element.same(focus) ? "AXSecureTextField" : "AXStandardWindow")
    case "AXParent":
      if element.same(focus) { return .element(window) }
      if element.same(child) { return .element(childParent ?? window) }
      if element.same(foreignChild) { return .element(other) }
      if element.same(window) || element.same(other) { return .element(app) }
      return .failure
    default: return .failure
    }
  }
  func observer(_ pid: Int32, _ receive: @escaping (WindowAXElement, String) -> Void) -> WindowAXSubscription? {
    observerCount += 1
    self.receive = receive
    duringObserver?()
    return subscription
  }
}

private final class WatchFixture {
  let api = FakeAX()
  let executor = ManualAXExecutor()
  var events: [String] = []
  var received = 0
  var ignored = 0
  var admitted = true
  lazy var watch = WindowAXWatch(pid: 42, windowID: 7, api: api, executor: executor,
    permitted: { [weak self] in self?.admitted == true })
  func start() {
    watch.start { [self] event in
      switch event {
      case .ready(let coverage):
        check(api.subscription.attached, "ready only after attach")
        check(coverage.contains("AXUIElementDestroyed"), "coverage includes destruction")
        events.append("ready")
      case .changed: events.append("changed")
      case .received: received += 1
      case .ignored: ignored += 1
      case .destroyed: events.append("destroyed")
      case .unsupported(let reason): events.append("unsupported:\(reason)")
      }
    }
    executor.drain()
  }
  func send(_ element: WindowAXElement, _ name: String = "AXValueChanged") { api.receive?(element, name) }
  func unsupported(_ why: String) {
    check(events.last?.hasPrefix("unsupported:") == true, why)
    check(!events.contains("destroyed"), "unknown AX errors never become destruction")
  }
}

private func runObserverFixture(_ scenario: String) {
  switch scenario {
  case "filter":
    let f = WatchFixture()
    f.start()
    check(f.events == ["ready"], "known target starts")
    f.send(f.api.foreignChild)
    f.executor.drain()
    check(f.events == ["ready"], "proven other-window descendant ignored")
    f.api.childWindowID = 7
    f.send(f.api.child)
    check(f.events == ["ready", "changed"], "attributed change is delivered before the callback returns")
    for _ in 0..<10_000 { f.send(f.api.child) }
    check(f.executor.work.isEmpty, "event floods never enqueue change delivery")
    f.executor.drain()
    check(f.events.last == "changed", "a child's window ID does not replace exact ancestor identity")
    f.send(f.api.unknown)
    f.unsupported("unattributable event fails closed")
    check(f.api.subscription.detached, "ambiguous event detaches")
    let cycle = WatchFixture()
    cycle.start()
    cycle.api.childParent = cycle.api.child
    cycle.send(cycle.api.child)
    cycle.unsupported("ancestry cycle fails closed")
  case "attribution":
    let f = WatchFixture()
    f.start()
    // The first blocking query of a callback must find the coordinator already fenced.
    var fencedAtFirstQuery: Bool?
    f.api.duringAttribute = { if fencedAtFirstQuery == nil { fencedAtFirstQuery = f.received == 1 } }
    f.send(f.api.window)
    check(fencedAtFirstQuery == true, "receipt reaches the coordinator before attribution queries")
    check(f.events == ["ready", "changed"] && f.ignored == 0, "exact target change resolves the receipt")
    f.send(f.api.foreignChild)
    check(f.received == 2 && f.ignored == 1 && f.events == ["ready", "changed"],
      "other-window notification releases its receipt without a change")
  case "destruction":
    let f = WatchFixture()
    f.start()
    f.api.queries = []
    f.send(f.api.other, "AXUIElementDestroyed")
    check(f.events == ["ready"] && f.api.queries.isEmpty, "known other destroyed window ignored without querying")
    f.api.cannotComplete = true
    // Real detachment is blocking AX IPC; the coordinator must already hold the terminal state.
    var destroyedBeforeDetach = false
    f.api.subscription.duringDetach = { destroyedBeforeDetach = f.events.last == "destroyed" }
    f.send(WindowAXElement("window" as NSString), "AXUIElementDestroyed")
    check(f.events == ["ready", "destroyed"], "CFEqual exact target destruction")
    check(destroyedBeforeDetach, "destruction reaches the coordinator before blocking detachment")
    check(f.api.queries.isEmpty, "never query destroyed reference")
    check(f.api.subscription.detached, "destruction detaches")
    let child = WatchFixture()
    child.start()
    child.api.queries = []
    child.send(child.api.child, "AXUIElementDestroyed")
    child.unsupported("dead descendant cannot be attributed by querying it")
    check(child.api.queries.isEmpty, "unknown destruction performs zero AX queries")
    let failed = WatchFixture()
    failed.start()
    failed.api.cannotComplete = true
    failed.send(failed.api.child)
    failed.unsupported("cannotComplete is not destruction")
  case "coverage":
    for notification in WindowAXWatch.required {
      let f = WatchFixture()
      f.api.subscription.failNotification = notification
      f.start()
      f.unsupported("each required registration is mandatory")
      check(!f.events.contains("ready"), "partial coverage cannot start")
      check(f.api.subscription.detached, "partial registration cleaned up")
      check(f.api.subscription.roots.allSatisfy { $0 == "app" }, "register app root")
    }
    for defect in ["owner", "mapping", "duplicate", "pid"] {
      let f = WatchFixture()
      if defect == "owner" { f.api.owner = 9 }
      if defect == "mapping" { f.api.unknownMapping = true }
      if defect == "duplicate" { f.api.duplicateTarget = true }
      if defect == "pid" { f.api.windowPID = 9 }
      f.start()
      f.unsupported("exact target verification \(defect)")
      check(f.api.observerCount == 0, "target gate precedes observer")
    }
  case "privacy":
    for defect in ["permission", "private", "unknown", "subrole"] {
      let f = WatchFixture()
      if defect == "permission" { f.api.permission = false }
      if defect == "private" { f.api.privateFocus = true }
      if defect == "unknown" { f.api.missingFocus = true }
      if defect == "subrole" { f.api.missingSubrole = true }
      f.start()
      f.unsupported("privacy gate \(defect)")
      check(f.api.observerCount == 0, "privacy gate precedes observation")
    }
    let f = WatchFixture()
    f.start()
    f.api.privateFocus = true
    var refusedBeforeDetach = false
    f.api.subscription.duringDetach = { refusedBeforeDetach = f.events.last?.hasPrefix("unsupported:") == true }
    f.send(f.api.child)
    f.unsupported("private focus at callback receipt fails closed")
    check(refusedBeforeDetach, "privacy refusal reaches the coordinator before blocking detachment")
    check(!f.events.contains("changed"), "private callback never delivers changed")
    let revoked = WatchFixture()
    revoked.start()
    revoked.api.permission = false
    revoked.send(revoked.api.child)
    revoked.executor.drain()
    revoked.unsupported("revoked AX trust cannot deliver changes")
  case "sample-gate":
    let safe = WatchFixture()
    safe.start()
    var permits: [Bool] = []
    safe.api.queries = []
    safe.watch.check { value in
      check(safe.events.first == "ready" && safe.api.subscription.attached, "subscription precedes sample permission")
      permits.append(value)
    }
    check(permits.isEmpty && safe.api.queries.isEmpty, "sample validation runs on observer executor")
    safe.executor.drain()
    check(permits == [true], "known safe exact target permits sample")
    for defect in ["private", "permission", "unknown", "subrole", "owner", "mapping", "pid"] {
      let f = WatchFixture()
      f.start()
      f.send(f.api.child)
      check(f.events.last == "changed", "dirty event reaches core before sample gate")
      var answers: [Bool] = []
      f.watch.check { value in
        f.unsupported("sample gate refusal is terminal before answering false")
        answers.append(value)
      }
      if defect == "private" { f.api.privateFocus = true }
      if defect == "permission" { f.api.permission = false }
      if defect == "unknown" { f.api.missingFocus = true }
      if defect == "subrole" { f.api.missingSubrole = true }
      if defect == "owner" { f.api.owner = nil }
      if defect == "mapping" { f.api.unknownMapping = true }
      if defect == "pid" { f.api.windowPID = nil }
      f.executor.drain()
      check(answers == [false] && f.api.subscription.detached, "sample gate rejects changed \(defect)")
    }
    let cancelled = WatchFixture()
    cancelled.start()
    var cancelledAnswers: [Bool] = []
    cancelled.watch.check { cancelledAnswers.append($0) }
    cancelled.watch.cancel()
    check(cancelled.api.subscription.invalidated, "cancel invalidates source immediately before executor drain")
    check(!cancelled.api.subscription.detached, "cancel retains registrations and refcon for original-runloop cleanup")
    cancelled.api.queries = []
    cancelled.executor.drain()
    check(cancelledAnswers == [false] && cancelled.api.queries.isEmpty, "queued check after cancel makes no AX queries or true callback")
    cancelled.watch.check { cancelledAnswers.append($0) }
    check(cancelledAnswers == [false, false] && cancelled.api.queries.isEmpty, "check after invalidation answers false without AX")
    let destroyed = WatchFixture()
    destroyed.start()
    var destroyedAnswers: [Bool] = []
    destroyed.watch.check { destroyedAnswers.append($0) }
    destroyed.api.queries = []
    destroyed.send(destroyed.api.window, "AXUIElementDestroyed")
    destroyed.executor.drain()
    check(destroyedAnswers == [false] && destroyed.api.queries.isEmpty, "destruction fences queued validation without querying dead refs")
    let interrupted = WatchFixture()
    interrupted.start()
    var interruptedAnswers: [Bool] = []
    interrupted.watch.check { interruptedAnswers.append($0) }
    interrupted.api.duringAttribute = { interrupted.watch.cancel() }
    interrupted.executor.drain()
    check(interruptedAnswers == [false], "cancel during validation never permits sample")
    check(interrupted.api.queries.last == "app:AXFocusedUIElement", "validation stops querying after in-flight call returns invalidated")
  case "admission":
    let denied = WatchFixture()
    denied.admitted = false
    denied.start()
    check(denied.events == ["unsupported:app_not_approved"] && denied.api.queries.isEmpty,
      "unapproved incarnation cannot reach initial AX queries")
    let event = WatchFixture()
    event.start()
    event.admitted = false
    event.api.queries = []
    event.send(event.api.child)
    check(event.events.last == "unsupported:app_not_approved" && event.api.queries.isEmpty,
      "revoked app ceiling blocks event AX queries and reports unsupported")
    check(event.api.subscription.invalidated && event.api.subscription.detached, "revoked event detaches observer")
    let sample = WatchFixture()
    sample.start()
    var answers: [Bool] = []
    sample.watch.check { answers.append($0) }
    sample.admitted = false
    sample.api.queries = []
    sample.executor.drain()
    check(answers == [false] && sample.api.queries.isEmpty, "revoked app ceiling blocks queued sample queries")
    check(sample.events.last == "unsupported:app_not_approved" && sample.api.subscription.detached,
      "revoked sample reports unsupported and detaches")
    let query = WatchFixture()
    query.start()
    query.api.duringAttribute = { query.admitted = false }
    query.watch.check { check(!$0, "ceiling revoked during query cannot permit sample") }
    query.executor.drain()
    check(query.events.last == "unsupported:app_not_approved", "ceiling checked between AX queries")
    check(query.api.queries.last == "app:AXFocusedUIElement", "unapproved incarnation receives no subsequent AX query")
    let attaching = WatchFixture()
    var queriesAtRevoke = 0
    attaching.api.subscription.duringAttach = {
      attaching.admitted = false
      queriesAtRevoke = attaching.api.queries.count
    }
    attaching.start()
    check(attaching.events == ["unsupported:app_not_approved"], "ceiling rechecked before ready")
    check(attaching.api.queries.count == queriesAtRevoke && attaching.api.subscription.detached,
      "post-attachment revalidation cannot query revoked incarnation")
  case "lifetime":
    let before = WatchFixture()
    before.watch.cancel()
    before.start()
    check(before.api.queries.isEmpty && before.events.isEmpty, "cancel before start performs no AX work")
    let setup = WatchFixture()
    setup.api.duringAttribute = { setup.watch.cancel() }
    setup.start()
    check(setup.api.queries.last == "app:AXWindows", "invalidation during query prevents later queries")
    check(setup.api.observerCount == 0 && setup.events.isEmpty, "pending setup cannot publish")
    let registration = WatchFixture()
    registration.api.subscription.duringAdd = {
      registration.watch.cancel()
      check(registration.api.subscription.invalidated, "published source invalidated during pending registration")
      check(!registration.api.subscription.detached, "pending registration keeps refcon alive")
    }
    registration.start()
    check(registration.api.subscription.registered.count == 1, "no registrations after cancel")
    check(registration.api.subscription.detached && registration.events.isEmpty, "cancelled setup detaches")
    let observer = WatchFixture()
    observer.api.duringObserver = { observer.watch.cancel() }
    observer.start()
    check(observer.api.subscription.detached && observer.api.subscription.registered.isEmpty, "late observer return cleans up")
    let attaching = WatchFixture()
    attaching.api.subscription.duringAttach = { attaching.watch.cancel() }
    attaching.start()
    check(attaching.api.subscription.invalidated && !attaching.api.subscription.attached,
      "cancel before source attachment prevents attachment afterward")
    check(attaching.events.isEmpty && attaching.api.subscription.detached, "cancel during attach cannot publish ready")
    let blocked = WatchFixture()
    blocked.start()
    blocked.api.duringAttribute = {
      blocked.watch.cancel()
      check(blocked.api.subscription.invalidated, "in-flight AX query cannot delay local source invalidation")
      check(!blocked.api.subscription.detached, "in-flight query retains context until returning to original runloop")
    }
    blocked.watch.check { check(!$0, "cancelled in-flight validation cannot permit sample") }
    blocked.executor.drain()
    check(blocked.api.subscription.invalidated && !blocked.api.subscription.detached,
      "source stays invalid while original-runloop cleanup is queued")
    blocked.executor.drain()
    check(blocked.api.subscription.detached, "returning query permits original-runloop teardown")
    let f = WatchFixture()
    f.start()
    f.send(f.api.child)
    f.watch.cancel()
    f.api.queries = []
    f.send(f.api.child)
    f.executor.drain()
    check(f.events == ["ready", "changed"] && f.api.queries.isEmpty, "late callbacks fenced after already-delivered dirty event")
    check(f.api.subscription.detached && f.executor.finished, "cancel retires observer executor")
    f.watch.cancel()
  default: check(false, "unknown fixture scenario")
  }
}

@main
private struct WindowAXFixture {
  static func main() {
    let scenario = CommandLine.arguments[1]
    if scenario == "manifest" {
      let text = manifest(["org.goat.fixture", "org.goat.한글"])
      check(NativeManifest(text: text)?.permits(bundleID: "org.goat.fixture") == true, "generated manifest grants exact app/tool")
      check(NativeManifest(text: text)?.permits(bundleID: "org.goat") == false, "no app prefix expansion")
      check(NativeManifest(text: manifest(["org.goat.caf\u{e9}"]))?.permits(bundleID: "org.goat.cafe\u{301}") == false,
        "bundle ceiling does not normalize distinct identifiers")
      check(NativeManifest(text: text)?.permits(bundleID: "org.goat.fixture", tool: "click") == false, "no tool expansion")
      check(NativeManifest(text: manifest([]))?.permits(bundleID: "org.goat.fixture") == false, "empty apps deny")
      check(NativeManifest(text: manifest(["org.goat.fixture"], tools: []))?.permits(bundleID: "org.goat.fixture") == false, "empty tools deny")
      for bad in [text.replacingOccurrences(of: "version: 3", with: "version: 4"),
        text.replacingOccurrences(of: "display: true", with: "display: false"),
        text + "allow:\n  tools:\n    - \"click\"\n",
        text.replacingOccurrences(of: "\"org.goat.fixture\"", with: "*all"),
        text.replacingOccurrences(of: "\"get_window_state\"", with: "[get_window_state]"),
        String(repeating: " ", count: 1_048_577)] {
        check(NativeManifest(text: bad) == nil, "unknown manifest format denies")
      }
      check(NativeManifest(text: manifest((0..<1000).map { "org.goat.fixture\($0)" })) != nil, "normal generated app ceiling fits")
    } else {
      runObserverFixture(scenario)
    }
    print("PASS \(scenario)")
  }
}

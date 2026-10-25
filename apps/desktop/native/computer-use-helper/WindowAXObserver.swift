import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

enum SettleWatchEvent {
  case ready([String])
  case received
  case changed
  case ignored
  case destroyed
  case unsupported(String)
}

protocol SettleWatch: AnyObject {
  func start(_ emit: @escaping (SettleWatchEvent) -> Void)
  func check(_ ready: @escaping (Bool) -> Void)
  func cancel()
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
  case unsupported
  /// Any other AXError, kept so a refusal can name the code.
  case error(Int32)
  case failure
}

protocol WindowAXSubscription: AnyObject {
  func add(_ element: WindowAXElement, notification: String) -> Bool
  func attach()
  func invalidate()
  func detach()
}

enum WindowAXCount {
  case count(Int)
  case absent
  case unsupported
  case error(Int32)
}

protocol WindowAXFunctions: AnyObject {
  func trusted() -> Bool
  func ownerPID(_ windowID: UInt32) -> Int32?
  func application(_ pid: Int32) -> WindowAXElement?
  func pid(_ element: WindowAXElement) -> Int32?
  func windowID(_ element: WindowAXElement) -> UInt32?
  func attribute(_ element: WindowAXElement, _ name: String) -> WindowAXAttribute
  /// AXChildren, fetching at most `max` elements so a huge container is never copied whole.
  func children(_ element: WindowAXElement, max: Int) -> WindowAXAttribute
  /// How many AXChildren an element reports, as separate evidence when reading them fails.
  func childCount(_ element: WindowAXElement) -> WindowAXCount
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
    if let refusal = privacyRefusal(app) { return refusal }
    return isAdmitted ? nil : "invalidated"
  }

  /// `admit: false` publishes without the external approval lookup, for receipt fences that
  /// must land before any code that can let a final sample through.
  private func deliver(_ event: SettleWatchEvent, terminal: Bool = false, admit: Bool = true) {
    if !terminal && admit && !isAdmitted { return }
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
    if let refusal = privacyRefusal(app) { if isActive { refuse(refusal) }; return }
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
    if let refusal = privacyRefusal(app) { if isActive { refuse(refusal) }; return }
    subscribed = true
    deliver(.ready(Self.required))
  }

  /// Nil when the app's focus and the target window are known safe; otherwise the refusal reason,
  /// naming the failed check and at most an AX role or subrole name, never a value (#1585).
  private func privacyRefusal(_ app: WindowAXElement) -> String? {
    guard isAdmitted else { return Self.privacy("invalidated") }
    guard api.trusted() else { return Self.privacy("accessibility_untrusted") }
    guard isAdmitted else { return Self.privacy("invalidated") }
    switch api.attribute(app, "AXFocusedUIElement") {
    case .element(let focused): return focusRefusal(focused, app: app, allowUnknown: true)
    // Only noValue says there is no focused element; unsupported leaves the app's focus unknown,
    // so it still refuses.
    case .absent:
      if let refusal = windowTreeRefusal() { return refusal }
      guard isAdmitted else { return Self.privacy("invalidated") }
      // Focus may have moved into a secure field elsewhere while the window was read.
      switch api.attribute(app, "AXFocusedUIElement") {
      case .absent: return nil
      case .element(let focused): return focusRefusal(focused, app: app, allowUnknown: false)
      case .unsupported: return Self.privacy("focus_unsupported")
      default: return Self.privacy("focus_unreadable")
      }
    case .unsupported: return Self.privacy("focus_unsupported")
    default: return Self.privacy("focus_unreadable")
    }
  }

  private static func privacy(_ detail: String) -> String { "private_or_unknown_focus:" + detail }

  /// Standard AX role names a reason may carry. Names are app-supplied, so anything else becomes
  /// "other": filtering characters alone would still let an app put text into the reason.
  private static let reportableNames: Set<String> = ["AXApplication", "AXWindow", "AXSheet", "AXDrawer",
    "AXPopover", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXScrollBar", "AXToolbar", "AXTabGroup",
    "AXLayoutArea", "AXLayoutItem", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXGrid", "AXRow",
    "AXColumn", "AXCell", "AXWebArea", "AXMenu", "AXMenuBar", "AXMenuItem", "AXButton", "AXStaticText",
    "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXImage", "AXCheckBox",
    "AXRadioButton", "AXMenuButton", "AXPopUpButton", "AXSlider", "AXValueIndicator", "AXIncrementor",
    "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXDisclosureTriangle", "AXColorWell",
    "AXSplitter", "AXHandle", "AXRelevanceIndicator", "AXLink", "AXHeading", "AXDateField",
    "AXTimeField", "AXMatte", "AXRuler", "AXUnknown"]

  private static func axName(_ name: String) -> String { reportableNames.contains(name) ? name : "other" }

  /// A focused element with no known role (Calculator reports AXUnknown, #1585) cannot be judged
  /// by its own chain, so it passes only inside the target window and only if that whole window
  /// is clean. `allowUnknown` is false for focus found by a recheck, which takes the strict chain.
  private func focusRefusal(_ focused: WindowAXElement, app: WindowAXElement, allowUnknown: Bool) -> String? {
    guard !focused.same(app) else { return Self.privacy("focus_is_application") }
    guard allowUnknown else { return focusChainRefusal(focused, app: app) }
    guard isAdmitted else { return Self.privacy("invalidated") }
    switch api.attribute(focused, "AXRole") {
    case .string(let role) where role == "AXUnknown" || role.isEmpty: return unknownFocusRefusal(focused, app: app)
    case .absent: return unknownFocusRefusal(focused, app: app)
    default: return focusChainRefusal(focused, app: app)
    }
  }

  private func unknownFocusRefusal(_ focused: WindowAXElement, app: WindowAXElement) -> String? {
    if let refusal = unknownFocusPlacementRefusal(focused, app: app) { return refusal }
    if let refusal = windowTreeRefusal(allowing: focused) { return refusal }
    guard isAdmitted else { return Self.privacy("invalidated") }
    switch api.attribute(app, "AXFocusedUIElement") {
    case .absent: return nil
    // The same element may have turned secure or moved while the window was read; check it again.
    case .element(let now) where now.same(focused): return unknownFocusPlacementRefusal(focused, app: app)
    case .element(let now): return focusRefusal(now, app: app, allowUnknown: false)
    case .unsupported: return Self.privacy("focus_unsupported")
    default: return Self.privacy("focus_unreadable")
    }
  }

  /// The unknown focus is not secure by subrole and sits inside the target window, under no secure
  /// or unreadable ancestor: the window walk covers only the target window.
  private func unknownFocusPlacementRefusal(_ focused: WindowAXElement, app: WindowAXElement) -> String? {
    guard let target else { return Self.privacy("tree_target_missing") }
    guard isAdmitted else { return Self.privacy("invalidated") }
    switch api.attribute(focused, "AXRole") {
    case .string(let role) where role == "AXUnknown" || role.isEmpty: break
    case .absent: break
    // A role that became known since the first read is judged by nobody here, so it refuses.
    default: return Self.privacy("focus_role_changed")
    }
    switch api.attribute(focused, "AXSubrole") {
    case .string(let subrole): if subrole == "AXSecureTextField" { return Self.privacy("focus_subrole:AXUnknown") }
    case .absent, .unsupported: break
    default: return Self.privacy("focus_subrole_unreadable:AXUnknown")
    }
    var node = focused
    var seen: [WindowAXElement] = []
    var inside = false
    for _ in 0..<128 {
      guard isAdmitted else { return Self.privacy("invalidated") }
      guard case .element(let parent) = api.attribute(node, "AXParent") else {
        return Self.privacy("focus_parent_unreadable:AXUnknown")
      }
      if parent.same(target) { inside = true; break }
      if parent.same(app) { return Self.privacy("focus_outside_window") }
      guard !seen.contains(where: { $0.same(parent) }) else { return Self.privacy("focus_chain_cycle") }
      seen.append(parent)
      guard case .string(let role) = api.attribute(parent, "AXRole") else {
        return Self.privacy("focus_ancestor_unreadable")
      }
      // Only the focused element itself may be unidentifiable; its ancestors must have known roles.
      guard !role.isEmpty, role != "AXUnknown" else { return Self.privacy("focus_ancestor:AXUnknown") }
      switch api.attribute(parent, "AXSubrole") {
      case .string(let subrole):
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
          return Self.privacy("focus_ancestor:" + Self.axName(role))
        }
      case .absent, .unsupported:
        if role == "AXSecureTextField" || role == "AXTextField" { return Self.privacy("focus_ancestor:" + Self.axName(role)) }
      default: return Self.privacy("focus_ancestor_unreadable")
      }
      node = parent
    }
    return inside ? nil : Self.privacy("focus_chain_limit")
  }

  private func focusChainRefusal(_ focused: WindowAXElement, app: WindowAXElement) -> String? {
    guard !focused.same(app) else { return Self.privacy("focus_is_application") }
    var node = focused
    var seen: [WindowAXElement] = []
    for _ in 0..<128 {
      guard isAdmitted else { return Self.privacy("invalidated") }
      if node.same(app) { return nil }
      guard !seen.contains(where: { $0.same(node) }) else { return Self.privacy("focus_chain_cycle") }
      seen.append(node)
      guard case .string(let role) = api.attribute(node, "AXRole") else {
        return Self.privacy("focus_role_unreadable")
      }
      guard !role.isEmpty, role != "AXSecureTextField", role != "AXUnknown" else {
        return Self.privacy("focus_role:" + Self.axName(role))
      }
      guard isAdmitted else { return Self.privacy("invalidated") }
      switch api.attribute(node, "AXSubrole") {
      case .string(let subrole):
        if subrole == "AXSecureTextField" { return Self.privacy("focus_subrole:" + Self.axName(role)) }
      case .absent, .unsupported:
        if role == "AXTextField" { return Self.privacy("focus_subrole:" + Self.axName(role)) }
      default: return Self.privacy("focus_subrole_unreadable:" + Self.axName(role))
      }
      guard isAdmitted else { return Self.privacy("invalidated") }
      guard case .element(let parent) = api.attribute(node, "AXParent") else {
        return Self.privacy("focus_parent_unreadable:" + Self.axName(role))
      }
      node = parent
    }
    return Self.privacy("focus_chain_limit")
  }

  private static let treeNodeLimit = 512
  private static let treeDepthLimit = 32
  /// Roles that never contain other elements, so an unsupported AXChildren still proves the
  /// subtree. Any other node must list its children, or be empty, for the walk to know its contents.
  private static let leafRoles: Set<String> = ["AXButton", "AXStaticText", "AXImage", "AXCheckBox",
    "AXRadioButton", "AXMenuButton", "AXPopUpButton", "AXSlider", "AXValueIndicator", "AXIncrementor",
    "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXDisclosureTriangle",
    "AXColorWell", "AXSplitter", "AXHandle", "AXRelevanceIndicator"]

  /// Reads the whole target window, within bounds, and fails closed on anything it cannot read or
  /// identify (AXUnknown, a container hiding its children), a secure field, or a tree past its bounds.
  private static let maxReportedProblems = 8
  /// Roles that can be a secure text input; only for these does an unreadable subrole leave the
  /// secure-field question open. Any other role cannot be a secure field whatever its subrole.
  private static let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField"]

  private static func token(_ attribute: WindowAXAttribute, _ name: String) -> String {
    switch attribute {
    case .string: return name + "_ok"
    case .elements(let list): return name + "\(list.count)"
    case .absent: return name + "_absent"
    case .unsupported: return name + "_unsupported"
    case .error(let code): return name + "_err\(abs(Int(code)))"
    default: return name + "_fail"
    }
  }

  /// `allowing` is the one AXUnknown focused element the caller already placed inside the window by
  /// its parent chain. It is a second root, so its own subtree is judged even when the window does not
  /// list it as a child. Every distinct problem is collected (up to a cap) instead of stopping at the
  /// first, and a refusal ends with "seen:" entries summarizing what each kind of node returned
  /// (role names, AX codes and counts only), so one live check shows every remaining blocker.
  private func windowTreeRefusal(allowing allowed: WindowAXElement? = nil) -> String? {
    guard let target else { return Self.privacy("tree_target_missing") }
    var pending: [(WindowAXElement, Int)] = [(target, 0)]
    if let allowed { pending.insert((allowed, 0), at: 0) }
    var visited = 0
    var problems: [String] = []
    var seen: [String: Int] = [:]
    var seenOrder: [String] = []
    func note(_ problem: String) {
      if problems.count < Self.maxReportedProblems, !problems.contains(problem) { problems.append(problem) }
    }
    func record(_ entry: String) {
      if seen[entry] == nil { seenOrder.append(entry) }
      seen[entry, default: 0] += 1
    }
    walk: while let (node, depth) = pending.popLast() {
      visited += 1
      guard visited <= Self.treeNodeLimit else { note("tree_node_limit"); break walk }
      guard depth <= Self.treeDepthLimit else { note("tree_depth_limit"); continue }
      guard isAdmitted else { return Self.privacy("invalidated") }
      let isAllowed = allowed?.same(node) == true
      let role: String
      switch api.attribute(node, "AXRole") {
      case .string(let value): role = value.isEmpty && isAllowed ? "AXUnknown" : value
      case .absent where isAllowed: role = "AXUnknown"
      default: note("tree_role_unreadable"); record("unreadable"); continue
      }
      let name = Self.axName(role)
      // A refused node's subtree is skipped: its own problem already refuses the window.
      guard !role.isEmpty, role != "AXSecureTextField", role != "AXUnknown" || isAllowed else {
        note("tree_role:" + name); record(name); continue
      }
      let subrole = api.attribute(node, "AXSubrole")
      switch subrole {
      case .string(let value):
        if value == "AXSecureTextField" { note("tree_subrole:" + name); record(name + ":sub_secure"); continue }
      case .absent, .unsupported:
        if role == "AXTextField" { note("tree_subrole:" + name); record(name + ":" + Self.token(subrole, "sub")); continue }
      default:
        // The focused AXUnknown element is held to text-input rules: its kind is not known.
        if Self.textInputRoles.contains(role) || isAllowed {
          let code = { if case .error(let c) = subrole { return ":err\(abs(Int(c)))" }; return "" }()
          note("tree_subrole_unreadable:" + name + code); record(name + ":" + Self.token(subrole, "sub")); continue
        }
      }
      // Ask for one more than the budget allows, so an overflow is refused and never truncated.
      let budget = Self.treeNodeLimit - visited - pending.count
      let isLeaf = Self.leafRoles.contains(role)
      let children = api.children(node, max: budget + 1)
      var entry = name + ":" + Self.token(subrole, "sub") + ":" + Self.token(children, "kids")
      switch children {
      case .elements(let list):
        guard list.count <= budget else { note("tree_node_limit"); record(entry); break walk }
        pending.append(contentsOf: list.map { ($0, depth + 1) })
      case .absent: break
      case .unsupported: if !isLeaf { note("tree_children_unsupported:" + name) }
      // A failing read proves nothing about children, whatever the role (Calculator's buttons return
      // an AX error, #1585); only a separate count of zero shows the node is empty.
      case .error(let code):
        let (problem, count) = emptyChildrenProblem(node, role: role, read: ":err\(abs(Int(code)))")
        entry += ":" + count
        if let problem { note(problem) }
      default:
        let (problem, count) = emptyChildrenProblem(node, role: role, read: "")
        entry += ":" + count
        if let problem { note(problem) }
      }
      record(entry)
    }
    guard !problems.isEmpty else { return nil }
    var reason = Self.privacy(problems.joined(separator: ","))
    for entry in seenOrder {
      let item = ",seen:" + entry + ":x\(seen[entry] ?? 0)"
      if reason.count + item.count > 600 { break }
      reason += item
    }
    return reason
  }

  /// Nil when an element whose children could not be read reports zero children; otherwise the
  /// problem, naming the read error and what the count said.
  private func emptyChildrenProblem(_ node: WindowAXElement, role: String, read: String) -> (String?, String) {
    let problem = "tree_children_unreadable:" + Self.axName(role) + read
    guard isAdmitted else { return (problem, "count_skipped") }
    switch api.childCount(node) {
    case .count(0): return (nil, "count0")
    case .absent: return (nil, "count_absent")
    case .count(let n): return (problem + ":count\(n)", "count\(n)")
    case .unsupported: return (problem + ":count_unsupported", "count_unsupported")
    case .error(let code): return (problem + ":count_err\(abs(Int(code)))", "count_err\(abs(Int(code)))")
    }
  }

  private func receive(_ element: WindowAXElement, _ notification: String) {
    // Only local state before the receipt fence; approval is rechecked before any AX query.
    guard isActive, let target, let app else { return }
    // Destruction invalidates the callback's element. Compare retained identity before any query.
    if notification == "AXUIElementDestroyed" {
      if element.same(target) { deliver(.destroyed, terminal: true) }
      else if otherWindows.contains(where: { $0.same(element) }) { return }
      else { refuse("destroyed_element_ancestry_unknown") }
      return
    }
    guard Self.required.contains(notification) else { return refuse("notification_unknown") }
    // Fence settlement before the blocking privacy and ancestry queries below; every
    // non-terminal path resolves this receipt as changed or ignored.
    deliver(.received, admit: false)
    guard isAdmitted else { return }
    if let refusal = privacyRefusal(app) { if isActive { refuse(refusal) }; return }
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
        return deliver(.ignored)
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

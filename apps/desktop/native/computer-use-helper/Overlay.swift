// The agent cursor overlay (#1214): a click-through panel over the window an agent acts on,
// drawn from commands the lease proxy sends on fd 3 (apps/server/src/cua/overlayChannel.ts).
// The proxy decides what shows (apps/server/src/cua/ComputerUseOverlay.ts); this file only
// draws it and answers once a change has reached the window server, so a capture the proxy
// forwards after a hide cannot contain it (#1321).
import AppKit
import QuartzCore

/// GOAT's own cursor and window glow. The artwork is drawn here and copies no other product's.
final class AgentOverlayView: NSView {
  // Redraw only on a change: a follow tick that finds nothing new must not repaint the border.
  var windowRect = NSRect.zero {
    didSet { if windowRect != oldValue { needsDisplay = true } }
  }
  var acting = false {
    didSet { if acting != oldValue { needsDisplay = true } }
  }
  var showsBorder = true {
    didSet { if showsBorder != oldValue { needsDisplay = true } }
  }

  var statusText = "" { didSet { if statusText != oldValue { needsDisplay = true } } }

  private let accent = NSColor(srgbRed: 0.27, green: 0.52, blue: 1.0, alpha: 1)

  override func draw(_ dirtyRect: NSRect) {
    guard showsBorder else { return }
    let glow = NSBezierPath(roundedRect: windowRect.insetBy(dx: -3, dy: -3), xRadius: 12, yRadius: 12)
    glow.lineWidth = acting ? 4 : 2
    accent.withAlphaComponent(acting ? 0.9 : 0.45).setStroke()
    glow.stroke()
    if !statusText.isEmpty {
      let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
        .foregroundColor: NSColor.white,
      ]
      let label = NSAttributedString(string: statusText, attributes: attributes)
      let size = label.size()
      let box = NSRect(x: windowRect.minX + 8, y: windowRect.maxY - size.height - 14,
        width: size.width + 16, height: size.height + 8)
      NSColor.black.withAlphaComponent(0.8).setFill()
      NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
      label.draw(at: NSPoint(x: box.minX + 8, y: box.minY + 4))
    }
  }
}

/// The window server's frame of a window, in Cocoa screen coordinates. Bounds need no Screen
/// Recording grant; only titles do.
func overlayWindowFrame(_ windowId: CGWindowID) -> NSRect? {
  guard
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]],
    let info = list.first,
    // A minimized window or one on another Space: nothing of it shows here, so neither does
    // the border (the panel joins every Space).
    HelperSafety.isOnScreen(info),
    let bounds = info[kCGWindowBounds as String] as? NSDictionary,
    let rect = CGRect(dictionaryRepresentation: bounds)
  else { return nil }
  // The window server's origin is the primary display's top left; Cocoa's is its bottom left.
  let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
  return NSRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
}

/// Every on-screen window, front to back, for OverlayOrder.raisesToFront.
func overlayListedWindows() -> [OverlayListedWindow] {
  guard
    let list = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  return list.compactMap { entry in
    guard let id = entry[kCGWindowNumber as String] as? Int,
      let pid = entry[kCGWindowOwnerPID as String] as? Int,
      let layer = entry[kCGWindowLayer as String] as? Int,
      let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds)
    else { return nil }
    return OverlayListedWindow(
      windowId: CGWindowID(id), pid: pid, layer: layer, width: rect.width, height: rect.height)
  }
}

final class AgentOverlay {
  /// Room around the window for the glow and a cursor at its edge.
  private let margin: CGFloat = 24
  private let panel: NSPanel
  private let view = AgentOverlayView(frame: .zero)
  private let cursorLayer = CAShapeLayer()
  private let thinkLayer = CAShapeLayer()
  private var target: (windowId: CGWindowID, point: CGPoint?)?
  private lazy var follow = OverlayFollowController(
    scheduler: OverlayTimerScheduler(),
    frame: { overlayWindowFrame($0) },
    onFrame: { [weak self] frame in
      self?.place(animate: false, frame: frame)
    },
    onSteady: { [weak self] in
      self?.keepStacked()
    },
    onBorder: { [weak self] visible in
      self?.view.showsBorder = visible
    })
  private var settledPoint: CGPoint?
  private var reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  var escapeAvailable = false
  private var currentPhase = "resting"
  private var motionObserver: NSObjectProtocol?

  init() {
    panel = NSPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    // Never takes a click, a key or focus from the window the agent or the person uses.
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    // No fade: a hide must be off screen before its ack, and a fading panel still showed in
    // captures taken right after it (measured on macOS 26 with screencapture).
    panel.animationBehavior = .none
    // Normal level, ordered just above the target window in place(): a window that covers the
    // target also covers its border and cursor, instead of the overlay showing over it.
    panel.level = .normal
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.contentView = view
    view.wantsLayer = true
    let arrow = CGMutablePath()
    arrow.move(to: .zero)
    arrow.addLine(to: CGPoint(x: 0, y: -22))
    arrow.addLine(to: CGPoint(x: 6, y: -16))
    arrow.addLine(to: CGPoint(x: 15, y: -17))
    arrow.closeSubpath()
    cursorLayer.path = arrow
    cursorLayer.fillColor = NSColor(srgbRed: 0.27, green: 0.52, blue: 1, alpha: 1).cgColor
    cursorLayer.strokeColor = NSColor.white.cgColor
    cursorLayer.lineWidth = 2
    cursorLayer.shadowColor = NSColor.black.cgColor
    cursorLayer.shadowOpacity = 0.3
    cursorLayer.shadowRadius = 2
    cursorLayer.shadowPath = arrow
    cursorLayer.isHidden = true
    view.layer?.addSublayer(cursorLayer)
    thinkLayer.path = CGPath(ellipseIn: CGRect(x: -12, y: -12, width: 24, height: 24), transform: nil)
    thinkLayer.fillColor = NSColor.clear.cgColor
    thinkLayer.strokeColor = NSColor(srgbRed: 0.27, green: 0.52, blue: 1, alpha: 0.55).cgColor
    thinkLayer.lineWidth = 2
    thinkLayer.opacity = 0.15
    thinkLayer.isHidden = true
    view.layer?.addSublayer(thinkLayer)
    motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      self.cursorLayer.removeAllAnimations()
      self.thinkLayer.removeAllAnimations()
      self.thinkLayer.isHidden = self.reducedMotion || self.currentPhase != "thinking" || self.target?.point == nil
      self.place(animate: false)
    }
  }

  deinit {
    if let motionObserver { NSWorkspace.shared.notificationCenter.removeObserver(motionObserver) }
  }

  /// One command from the proxy: {op:"show", windowId, point?:{fx,fy}, phase} or {op:"hide"}.
  func apply(_ command: [String: Any]) {
    guard command["op"] as? String == "show", let windowId = command["windowId"] as? Int else {
      return hide()
    }
    var point: CGPoint?
    if let fraction = command["point"] as? [String: Any], let fx = fraction["fx"] as? Double,
      let fy = fraction["fy"] as? Double
    {
      point = CGPoint(x: fx, y: fy)
    }
    let pid = command["pid"] as? Int
    let app = pid.flatMap { NSRunningApplication(processIdentifier: pid_t($0))?.localizedName } ?? "an app"
    let stopHint = escapeAvailable && command["escEnabled"] as? Bool == true
      ? "press Esc to stop" : "use Stop in GOAT"
    view.statusText = "GOAT is using \(app) — \(stopHint)"
    let phase = command["phase"] as? String ?? "resting"
    currentPhase = phase
    view.acting = phase == "acting" || phase == "moving"
    let previous = target?.windowId
    target = (CGWindowID(windowId), point)
    follow.show(windowId: CGWindowID(windowId), phase: phase == "resting" ? .resting : .active)
    if let frame = overlayWindowFrame(CGWindowID(windowId)) {
      place(animate: phase == "moving" || phase == "acting", frame: frame)
    } else if previous != CGWindowID(windowId) {
      // Nothing of the new window shows; the old one's border must not stay. For the same
      // window, one empty read is left to the follow controller's miss count.
      panel.orderOut(nil)
    }
    thinkLayer.removeAllAnimations()
    thinkLayer.isHidden = phase != "thinking" || reducedMotion || point == nil
    if !thinkLayer.isHidden {
      let pulse = CABasicAnimation(keyPath: "opacity")
      pulse.fromValue = 0.15
      pulse.toValue = 0.55
      pulse.duration = 0.6
      pulse.autoreverses = true
      pulse.repeatCount = 4
      thinkLayer.opacity = 0.15
      thinkLayer.add(pulse, forKey: "boundedThink")
    }
  }

  func hide() {
    currentPhase = "resting"
    follow.hide()
    target = nil
    cursorLayer.removeAllAnimations()
    thinkLayer.removeAllAnimations()
    cursorLayer.isHidden = true
    thinkLayer.isHidden = true
    settledPoint = nil
    panel.orderOut(nil)
  }

  private func place(animate: Bool) {
    guard let target else {
      panel.orderOut(nil)
      return
    }
    if let frame = overlayWindowFrame(target.windowId) { place(animate: animate, frame: frame) }
  }

  private func place(animate: Bool, frame: NSRect?) {
    guard let target, let frame else {
      panel.orderOut(nil)
      return
    }
    let panelFrame = frame.insetBy(dx: -margin, dy: -margin)
    if panel.frame != panelFrame {
      panel.setFrame(panelFrame, display: false)
      view.frame = NSRect(origin: .zero, size: panel.frame.size)
    }
    view.windowRect = NSRect(x: margin, y: margin, width: frame.width, height: frame.height)
    // fy counts down from the top of the screenshot; the view's y counts up from the bottom.
    let nextPoint = target.point.map {
      CGPoint(x: margin + $0.x * frame.width, y: margin + (1 - $0.y) * frame.height)
    }
    if let nextPoint {
      if !animate, !cursorLayer.isHidden, settledPoint == nextPoint {
        // Frame follow leaves the current position animation and opacity untouched.
      } else {
        let wasVisible = !cursorLayer.isHidden
        let oldPoint = wasVisible ? (cursorLayer.presentation()?.position ?? settledPoint) : nil
        let retargeting = cursorLayer.animation(forKey: "position") != nil
        cursorLayer.removeAnimation(forKey: "position")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursorLayer.position = nextPoint
        thinkLayer.position = nextPoint
        cursorLayer.isHidden = false
        CATransaction.commit()
        if animate && !reducedMotion, let oldPoint {
          let distance = hypot(nextPoint.x - oldPoint.x, nextPoint.y - oldPoint.y)
          if distance >= 4 {
            if retargeting {
              let spring = CASpringAnimation(keyPath: "position")
              spring.fromValue = NSValue(point: oldPoint)
              spring.toValue = NSValue(point: nextPoint)
              spring.mass = 1
              spring.stiffness = 324
              spring.damping = 36
              spring.duration = 0.6
              cursorLayer.add(spring, forKey: "position")
            } else {
              let duration = min(0.45, max(0.15, 0.15 + 0.075 * log2(1 + distance / 16)))
              let path = CAKeyframeAnimation(keyPath: "position")
              path.values = (0...20).map { index -> NSValue in
                let t = Double(index) / 20
                let progress = 10 * pow(t, 3) - 15 * pow(t, 4) + 6 * pow(t, 5)
                return NSValue(point: NSPoint(
                  x: oldPoint.x + (nextPoint.x - oldPoint.x) * progress,
                  y: oldPoint.y + (nextPoint.y - oldPoint.y) * progress))
              }
              path.duration = duration
              path.calculationMode = .linear
              cursorLayer.add(path, forKey: "position")
            }
          }
        } else if reducedMotion && (!wasVisible || settledPoint != nextPoint) {
          let fade = CABasicAnimation(keyPath: "opacity")
          fade.fromValue = 0.3
          fade.toValue = 1
          fade.duration = 0.1
          cursorLayer.add(fade, forKey: "reducedFade")
        }
        settledPoint = nextPoint
      }
    } else {
      cursorLayer.isHidden = true
      thinkLayer.isHidden = true
      settledPoint = nil
    }
    keepStacked()
  }

  /// Orders the panel above the target only when it is not there already, so a steady window
  /// costs one window list read per tick and no reordering.
  private func keepStacked() {
    guard let target else { return }
    let windows = overlayListedWindows()
    let ownPid = Int(getpid())
    if panel.isVisible,
      OverlayOrder.isStacked(
        overlay: CGWindowID(panel.windowNumber), target: target.windowId, ownPid: ownPid,
        windows: windows)
    {
      return
    }
    // Ordered relative to another app's window number: the window server accepts any window
    // number here, whatever process owns it.
    panel.order(.above, relativeTo: Int(target.windowId))
    if OverlayOrder.raisesToFront(
      target: target.windowId,
      frontmostPid: NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) },
      ownPid: ownPid,
      windows: windows)
    {
      panel.orderFrontRegardless()
    }
  }
}

/// One overlay channel: commands in, acks and a person's input out, for one agent connection.
/// Every write goes through one serial queue off the main thread, so a peer that stops reading
/// stalls only its own channel, and the descriptor closes on that queue after the last write.
final class OverlayChannel: SessionOverlay {
  private let channel: Int32
  private let closesChannel: Bool
  private let writes = DispatchQueue(label: "si.goat.computer-use.overlay-writes")
  private var closed = false
  /// Guards closed and ended across the reader, the writer queue, main and end().
  private let state = NSLock()
  private var ended = false
  private let overlay: AgentOverlay
  private var input: InputActivity?

  private var isEnded: Bool { state.lock(); defer { state.unlock() }; return ended }

  /// Call on the main thread. native names the session whose work a pausing hide interrupts.
  init(channel: Int32, closesChannel: Bool, native: @escaping () -> McpNativeSession?) {
    self.channel = channel
    self.closesChannel = closesChannel
    overlay = AgentOverlay()
    // A write to a proxy that is gone must not kill this process.
    var on: Int32 = 1
    setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    // A person's input is dated as it is written: time spent queued must not make it look newer.
    let input = InputActivity(report: { [weak self] source, at in
      self?.write {
        let ageMs = max(0, Int(((InputActivity.now() - at) * 1000).rounded()))
        return "{\"humanInput\":{\"source\":\"\(source)\",\"ageMs\":\(ageMs)}}\n"
      }
    }, isActive: { [weak self] in
      self.map { !$0.isEnded } ?? false
    }, onEscape: { [weak self] in
      self?.write { "{\"personStop\":\"person_esc\"}\n" }
    })
    self.input = input
    input.start()
    overlay.escapeAvailable = input.escapeAvailable
    let overlay = self.overlay
    Thread.detachNewThread { [self] in
      var buffer = [UInt8]()
      var chunk = [UInt8](repeating: 0, count: 4096)
      while true {
        let count = read(channel, &chunk, chunk.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { break }
        buffer.append(contentsOf: chunk[0..<count])
        while let end = buffer.firstIndex(of: 0x0A) {
          let line = Data(buffer[0..<end])
          buffer.removeSubrange(0...end)
          guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let seq = message["seq"] as? Int, let command = message["command"] as? [String: Any]
          else { continue }
          // Cancellation reaches native observations before a busy AppKit queue can delay it.
          interruptNativeMcp(command, session: native())
          if isEnded { continue }
          DispatchQueue.main.async {
            // end() queues its hide after setting ended, so no show can follow that hide.
            guard !self.isEnded else { return }
            overlay.apply(command)
            // Hand the change to the window server now, and answer on the next turn of the
            // main loop, after it has been committed.
            CATransaction.flush()
            DispatchQueue.main.async { self.write { "{\"ack\":\(seq)}\n" } }
          }
        }
      }
      end()
      // Only this reader closes the descriptor, after its last read and the queued writes, and
      // under the lock end() shuts it down with, so no shutdown reaches a reused number.
      if closesChannel {
        writes.async { [self] in
          state.lock(); closed = true; close(channel); state.unlock()
        }
      }
    }
  }

  private func write(_ line: @escaping () -> String) {
    writes.async { [self] in
      // closed changes only on this queue, so it cannot change during the write below.
      guard !closed, !isEnded else { return }
      let bytes = Array(line().utf8)
      _ = bytes.withUnsafeBytes { Darwin.write(channel, $0.baseAddress, $0.count) }
    }
  }

  /// Hides the overlay, stops reporting input and ends the channel's reads; idempotent. The
  /// shutdown happens here, never behind a write blocked on a peer that stopped reading, and
  /// it unblocks that write.
  func end() {
    state.lock()
    let first = !ended
    ended = true
    if first && closesChannel && !closed { shutdown(channel, SHUT_RDWR) }
    state.unlock()
    guard first else { return }
    input?.stop()
    DispatchQueue.main.async { [overlay] in overlay.hide() }
  }
}

/// Runs the overlay when the proxy opened fd 3 for it, and never returns then: AppKit needs the
/// main run loop, which also serves the main dispatch queue. Returns when there is no channel,
/// so the caller keeps its plain dispatchMain().
func runOverlayIfConnected(native: McpNativeSession) {
  let channel: Int32 = 3
  var info = stat()
  guard fstat(channel, &info) == 0, (info.st_mode & S_IFMT) == S_IFSOCK else { return }
  retained.append(OverlayChannel(channel: channel, closesChannel: false, native: { native }))
  NSApplication.shared.setActivationPolicy(.accessory)
  NSApplication.shared.run()
}

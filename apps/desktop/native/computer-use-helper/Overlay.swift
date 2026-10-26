// The agent cursor overlay (#1214): a click-through panel over the window an agent acts on,
// drawn from commands the lease proxy sends on fd 3 (apps/server/src/cua/overlayChannel.ts).
// The proxy decides what shows (apps/server/src/cua/ComputerUseOverlay.ts); this file only
// draws it and answers once a change has reached the window server, so a capture the proxy
// forwards after a hide cannot contain it (#1321).
import AppKit
import QuartzCore

/// GOAT's own cursor and window glow. The artwork is drawn here and copies no other product's.
final class AgentOverlayView: NSView {
  var windowRect = NSRect.zero
  var acting = false

  private let accent = NSColor(srgbRed: 0.27, green: 0.52, blue: 1.0, alpha: 1)

  override func draw(_ dirtyRect: NSRect) {
    let glow = NSBezierPath(roundedRect: windowRect.insetBy(dx: -3, dy: -3), xRadius: 12, yRadius: 12)
    glow.lineWidth = acting ? 4 : 2
    accent.withAlphaComponent(acting ? 0.9 : 0.45).setStroke()
    glow.stroke()
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
  private var follow: Timer?
  private var settledPoint: CGPoint?
  private var reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
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
      self.thinkLayer.isHidden = self.reducedMotion
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
    let phase = command["phase"] as? String ?? "idle"
    view.acting = phase == "acting" || phase == "moving"
    target = (CGWindowID(windowId), point)
    place(animate: phase == "moving" || phase == "acting")
    thinkLayer.removeAllAnimations()
    thinkLayer.isHidden = phase != "thinking" || reducedMotion || point == nil
    if !thinkLayer.isHidden {
      let pulse = CABasicAnimation(keyPath: "opacity")
      pulse.fromValue = 0.15
      pulse.toValue = 0.55
      pulse.duration = 0.6
      pulse.autoreverses = true
      pulse.repeatCount = 4
      thinkLayer.add(pulse, forKey: "boundedThink")
    }
    // External windows have no NSWindow notifications here. Sample geometry only briefly after
    // activity; static idle leaves no timer or display link running.
    follow?.invalidate()
    if phase == "moving" || phase == "acting" {
      var remaining = 4
      follow = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
        guard let self else { timer.invalidate(); return }
        self.place(animate: false)
        remaining -= 1
        if remaining == 0 { timer.invalidate(); self.follow = nil }
      }
    }
  }

  func hide() {
    follow?.invalidate()
    follow = nil
    target = nil
    cursorLayer.removeAllAnimations()
    thinkLayer.removeAllAnimations()
    cursorLayer.isHidden = true
    thinkLayer.isHidden = true
    settledPoint = nil
    panel.orderOut(nil)
  }

  private func place(animate: Bool) {
    guard let target, let frame = overlayWindowFrame(target.windowId) else {
      panel.orderOut(nil)
      return
    }
    panel.setFrame(frame.insetBy(dx: -margin, dy: -margin), display: false)
    view.frame = NSRect(origin: .zero, size: panel.frame.size)
    view.windowRect = NSRect(x: margin, y: margin, width: frame.width, height: frame.height)
    // fy counts down from the top of the screenshot; the view's y counts up from the bottom.
    let nextPoint = target.point.map {
      CGPoint(x: margin + $0.x * frame.width, y: margin + (1 - $0.y) * frame.height)
    }
    if let nextPoint {
      let oldPoint = cursorLayer.presentation()?.position ?? settledPoint
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
      } else if reducedMotion {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.3
        fade.toValue = 1
        fade.duration = 0.1
        cursorLayer.add(fade, forKey: "reducedFade")
      }
      settledPoint = nextPoint
    } else {
      cursorLayer.isHidden = true
      thinkLayer.isHidden = true
      settledPoint = nil
    }
    view.needsDisplay = true
    // Ordered relative to another app's window number: the window server accepts any window
    // number here, whatever process owns it.
    panel.order(.above, relativeTo: Int(target.windowId))
    if OverlayOrder.raisesToFront(
      target: target.windowId,
      frontmostPid: NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) },
      ownPid: Int(getpid()),
      windows: overlayListedWindows())
    {
      panel.orderFrontRegardless()
    }
  }
}

/// Runs the overlay when the proxy opened fd 3 for it, and never returns then: AppKit needs the
/// main run loop, which also serves the main dispatch queue. Returns when there is no channel,
/// so the caller keeps its plain dispatchMain().
func runOverlayIfConnected() {
  let channel: Int32 = 3
  var info = stat()
  guard fstat(channel, &info) == 0, (info.st_mode & S_IFMT) == S_IFSOCK else { return }
  // A write to a proxy that is gone must not kill this process. Ignoring SIGPIPE would pass on
  // to the driver it starts, so only this socket stops raising it.
  var on: Int32 = 1
  setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  let overlay = AgentOverlay()
  retained.append(overlay)
  let ack = { (seq: Int) in
    let line = Array("{\"ack\":\(seq)}\n".utf8)
    _ = line.withUnsafeBytes { write(channel, $0.baseAddress, $0.count) }
  }
  // A person's input goes to the proxy on the same channel, written from the main queue like
  // every ack, so two lines never interleave. Its age is taken as it is written: time spent
  // waiting for the main queue must not make the event look newer than it was.
  let input = InputActivity { source, at in
    DispatchQueue.main.async {
      let ageMs = max(0, Int(((InputActivity.now() - at) * 1000).rounded()))
      let line = Array("{\"humanInput\":{\"source\":\"\(source)\",\"ageMs\":\(ageMs)}}\n".utf8)
      _ = line.withUnsafeBytes { write(channel, $0.baseAddress, $0.count) }
    }
  }
  retained.append(input)
  input.start()
  DispatchQueue.global().async {
    var buffer = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = read(channel, &chunk, chunk.count)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 {
        DispatchQueue.main.async { overlay.hide() }
        return
      }
      buffer.append(contentsOf: chunk[0..<count])
      while let end = buffer.firstIndex(of: 0x0A) {
        let line = Data(buffer[0..<end])
        buffer.removeSubrange(0...end)
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let seq = message["seq"] as? Int, let command = message["command"] as? [String: Any]
        else { continue }
        // Cancellation reaches native observations before a busy AppKit queue can delay it.
        interruptNativeMcp(command)
        DispatchQueue.main.async {
          overlay.apply(command)
          // Hand the change to the window server now, and answer on the next turn of the main
          // loop, after it has been committed.
          CATransaction.flush()
          DispatchQueue.main.async { ack(seq) }
        }
      }
    }
  }
  NSApplication.shared.setActivationPolicy(.accessory)
  NSApplication.shared.run()
}

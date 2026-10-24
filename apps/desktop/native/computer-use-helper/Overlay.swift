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
  var point: NSPoint?
  var acting = false

  private let accent = NSColor(srgbRed: 0.27, green: 0.52, blue: 1.0, alpha: 1)

  override func draw(_ dirtyRect: NSRect) {
    let glow = NSBezierPath(roundedRect: windowRect.insetBy(dx: -3, dy: -3), xRadius: 12, yRadius: 12)
    glow.lineWidth = acting ? 4 : 2
    accent.withAlphaComponent(acting ? 0.9 : 0.45).setStroke()
    glow.stroke()
    guard let point else { return }
    if acting {
      let ring = NSBezierPath(ovalIn: NSRect(x: point.x - 11, y: point.y - 11, width: 22, height: 22))
      ring.lineWidth = 2
      accent.withAlphaComponent(0.6).setStroke()
      ring.stroke()
    }
    // An arrow whose tip is the point; Cocoa's y grows upward, so the body hangs below it.
    let arrow = NSBezierPath()
    arrow.move(to: point)
    arrow.line(to: NSPoint(x: point.x, y: point.y - 22))
    arrow.line(to: NSPoint(x: point.x + 6, y: point.y - 16))
    arrow.line(to: NSPoint(x: point.x + 15, y: point.y - 17))
    arrow.close()
    arrow.lineWidth = 2
    accent.setFill()
    arrow.fill()
    NSColor.white.setStroke()
    arrow.stroke()
  }
}

/// The window server's frame of a window, in Cocoa screen coordinates. Bounds need no Screen
/// Recording grant; only titles do.
func overlayWindowFrame(_ windowId: CGWindowID) -> NSRect? {
  guard
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]],
    let bounds = list.first?[kCGWindowBounds as String] as? NSDictionary,
    let rect = CGRect(dictionaryRepresentation: bounds)
  else { return nil }
  // The window server's origin is the primary display's top left; Cocoa's is its bottom left.
  let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
  return NSRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
}

final class AgentOverlay {
  /// Room around the window for the glow and a cursor at its edge.
  private let margin: CGFloat = 24
  private let panel: NSPanel
  private let view = AgentOverlayView(frame: .zero)
  private var target: (windowId: CGWindowID, point: CGPoint?)?
  private var follow: Timer?

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
    panel.level = .screenSaver
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.contentView = view
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
    view.acting = command["phase"] as? String == "acting"
    target = (CGWindowID(windowId), point)
    place()
    // The window can move or resize while the agent works; follow it while anything shows.
    if follow == nil {
      follow = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
        self?.place()
      }
    }
  }

  func hide() {
    follow?.invalidate()
    follow = nil
    target = nil
    panel.orderOut(nil)
  }

  private func place() {
    guard let target, let frame = overlayWindowFrame(target.windowId) else {
      panel.orderOut(nil)
      return
    }
    panel.setFrame(frame.insetBy(dx: -margin, dy: -margin), display: false)
    view.frame = NSRect(origin: .zero, size: panel.frame.size)
    view.windowRect = NSRect(x: margin, y: margin, width: frame.width, height: frame.height)
    // fy counts down from the top of the screenshot; the view's y counts up from the bottom.
    view.point = target.point.map {
      NSPoint(x: margin + $0.x * frame.width, y: margin + (1 - $0.y) * frame.height)
    }
    view.needsDisplay = true
    panel.orderFrontRegardless()
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

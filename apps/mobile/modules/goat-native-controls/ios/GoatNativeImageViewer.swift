import ImageIO
import UIKit

/// Full-screen image gallery modelled on Messages. It opens at once from the tapped thumbnail's
/// own pixels and sharpens when the original arrives, so a slow or failed load never holds it back.
final class GoatNativeImageViewer: NSObject {
  let identifier: String
  private let completion: (Error?) -> Void
  private let onFinish: () -> Void
  private weak var sources: GoatPresentationSources?
  private let sourceIdentifiers: [String]
  private var titles: [String] = []
  private var urls: [URL?] = []
  /// The original bytes on disk, kept for sharing.
  private var files: [URL?] = []
  private var placeholders: [UIImage?] = []
  private var preparations = GoatImagePreparationQueue()
  private var loads: [Int: Task<Void, Never>] = [:]
  private var decodes: [Int: Task<Void, Never>] = [:]
  /// The last queued decode; each one waits for it, so one original decodes at a time.
  private var decodeQueue: Task<Void, Never>?
  /// Pages showing their decoded original; only the current page and its neighbours keep one.
  private var decoded: Set<Int> = []
  private var currentIndex = 0
  private var controller: GoatImageViewerController?
  private var closing = false
  private var finished = false

  init(identifier: String, sources: GoatPresentationSources, sourceIdentifiers: [String],
       onFinish: @escaping () -> Void, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifiers = sourceIdentifiers
    self.onFinish = onFinish
    self.completion = completion
    super.init()
  }

  func present(urls: [URL?], titles: [String], selectedIndex: Int, from presenter: UIViewController) {
    self.urls = urls
    self.titles = titles
    files = Array(repeating: nil, count: urls.count)
    currentIndex = selectedIndex
    let viewer = GoatImageViewerController(titles: titles, selectedIndex: selectedIndex)
    viewer.sourceView = { [weak self] index in self?.sourceView(index) }
    viewer.fileForPage = { [weak self] index in self?.file(at: index) }
    viewer.onRetry = { [weak self] index in self?.retry(index) }
    viewer.onClosing = { [weak self] in self?.stopWork() }
    viewer.onDismissed = { [weak self] in self?.finish() }
    viewer.onPageChange = { [weak self] index in self?.show(page: index) }
    controller = viewer
    viewer.loadViewIfNeeded()
    placeholders = urls.indices.map { sourceView($0).flatMap(Self.thumbnail(of:)) }
    for (index, placeholder) in placeholders.enumerated() {
      if let placeholder { viewer.setImage(placeholder, at: index, full: false) }
    }
    presenter.present(GoatImageViewerNavigation(viewer: viewer), animated: false) { viewer.animateIn() }
    for index in urls.indices where urls[index] != nil { preparations.enqueue(index) }
    startPreparations()
  }

  /// Delivers a URL that was still resolving when the gallery opened, or nil when it never will.
  func update(index: Int, url: URL?) {
    guard !closing, urls.indices.contains(index), urls[index] == nil else { return }
    guard let url else {
      controller?.setFailed(at: index, retryable: false)
      return
    }
    urls[index] = url
    preparations.enqueue(index)
    startPreparations()
  }

  func dismiss() {
    guard !finished else { return }
    guard let controller else { finish(); return }
    controller.close()
  }

  /// Ends at once, for a new viewer that must open while this one is still animating away.
  func finishImmediately() {
    guard !finished else { return }
    controller?.navigationController?.dismiss(animated: false)
    finish()
  }

  private func file(at index: Int) -> URL? {
    files.indices.contains(index) ? files[index] : nil
  }

  private func sourceView(_ index: Int) -> UIView? {
    guard sourceIdentifiers.indices.contains(index), !sourceIdentifiers[index].isEmpty else { return nil }
    return sources?.view(for: sourceIdentifiers[index])
  }

  private func retry(_ index: Int) {
    guard !closing, urls[index] != nil else { return }
    controller?.setLoading(at: index)
    preparations.enqueue(index)
    startPreparations()
  }

  private func startPreparations() {
    guard !closing else { return }
    while let index = preparations.take(near: currentIndex) {
      guard let url = urls[index] else {
        preparations.complete(index)
        continue
      }
      prepare(index, url: url)
    }
  }

  private func prepare(_ index: Int, url: URL) {
    let title = titles[index]
    loads[index] = Task { @MainActor [self] in
      defer {
        loads[index] = nil
        preparations.complete(index)
        startPreparations()
      }
      do {
        let file = try await GoatNativeFilePresentation.prepareFile(url: url, title: title)
        guard !closing, !Task.isCancelled else { Self.remove(file); return }
        if let previous = files[index] { Self.remove(previous) }
        files[index] = file
        decoded.remove(index)
        if file.pathExtension.lowercased() == "svg" {
          controller?.offerSVGPreview(at: index)
        } else if isNearCurrent(index) {
          decode(index)
        }
      } catch {
        guard !closing, !Task.isCancelled else { return }
        controller?.setFailed(at: index, retryable: true)
      }
    }
  }

  /// Only the current page and its neighbors keep decoded originals.
  private func show(page index: Int) {
    currentIndex = index
    for other in decoded where !isNearCurrent(other) {
      decoded.remove(other)
      controller?.release(at: other, placeholder: placeholders[other])
    }
    // Cancel active and queued decodes for pages outside the new window.
    for (other, task) in decodes where !isNearCurrent(other) { task.cancel() }
    decode(index)
    for neighbor in [index - 1, index + 1] where files.indices.contains(neighbor) { decode(neighbor) }
    startPreparations()
  }

  private func isNearCurrent(_ index: Int) -> Bool { abs(index - currentIndex) <= 1 }

  private func decode(_ index: Int) {
    guard !closing, let file = file(at: index), file.pathExtension.lowercased() != "svg",
      !decoded.contains(index), decodes[index] == nil
    else { return }
    let previous = decodeQueue
    let task = Task { @MainActor [self] in
      await previous?.value
      var settled = false
      defer {
        decodes[index] = nil
        // Paged away and back while this run waited: it was cancelled, so the page asks again.
        if !settled, !closing, isNearCurrent(index), !decoded.contains(index) { decode(index) }
      }
      guard !closing, !Task.isCancelled, isNearCurrent(index), files[index] == file else { return }
      let image = await Self.decodeOffMain(file)
      guard !closing, !Task.isCancelled, isNearCurrent(index), files[index] == file else { return }
      settled = true
      if let image {
        decoded.insert(index)
        controller?.setImage(image, at: index, full: true)
      } else {
        Self.remove(file)
        files[index] = nil
        controller?.setFailed(at: index, retryable: true)
      }
    }
    decodes[index] = task
    decodeQueue = task
  }

  private func stopWork() {
    guard !closing else { return }
    closing = true
    for task in loads.values { task.cancel() }
    for task in decodes.values { task.cancel() }
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    stopWork()
    decodeQueue = nil
    for file in files.compactMap({ $0 }) { Self.remove(file) }
    files.removeAll()
    controller = nil
    DispatchQueue.main.async { [completion] in completion(nil) }
    // After queueing the completion, so a new presentation JS starts on seeing this lands behind it.
    onFinish()
  }

  private static func remove(_ file: URL) {
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  /// The decoded image a thumbnail already shows, uncropped, or a snapshot of a view that draws one.
  /// The largest image view wins, so an overlaid icon is never mistaken for the picture.
  private static func thumbnail(of view: UIView) -> UIImage? {
    var queue = [view]
    var best: (image: UIImage, area: CGFloat)?
    while let candidate = queue.popLast() {
      queue.append(contentsOf: candidate.subviews)
      guard let image = (candidate as? UIImageView)?.image, image.size.width > 0, image.size.height > 0 else { continue }
      let area = candidate.bounds.width * candidate.bounds.height
      if area > best?.area ?? 0 { best = (image, area) }
    }
    if let best, best.area >= view.bounds.width * view.bounds.height / 2 { return best.image }
    return snapshot(view, scale: view.window?.screen.scale ?? 2)
  }

  private static func snapshot(_ view: UIView, scale: CGFloat) -> UIImage? {
    guard view.bounds.width > 1, view.bounds.height > 1, view.window != nil else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = false
    return UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in
      view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
    }
  }

  nonisolated private static func decodeOffMain(_ file: URL) async -> UIImage? {
    let worker = Task.detached(priority: .userInitiated) { decode(file) }
    return await withTaskCancellationHandler {
      await worker.value
    } onCancel: {
      worker.cancel()
    }
  }

  /// Decodes at no more than zooming needs, and keeps GIFs animated.
  nonisolated private static func decode(_ file: URL) -> UIImage? {
    guard !Task.isCancelled, let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
    let count = CGImageSourceGetCount(source)
    guard count > 0 else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: 4096,
    ]
    var animationOptions = options
    animationOptions[kCGImageSourceThumbnailMaxPixelSize] = 1024
    animationOptions[kCGImageSourceShouldCacheImmediately] = nil
    // Every frame stays decoded while it plays, so an animation over this budget shows its first frame.
    if !Task.isCancelled, count > 1, let first = CGImageSourceCreateThumbnailAtIndex(source, 0, animationOptions as CFDictionary),
      count <= animationByteBudget / max(1, first.bytesPerRow * first.height) {
      var frames: [(image: UIImage, delay: Double)] = [(UIImage(cgImage: first), frameDuration(source, 0))]
      for index in 1..<count {
        guard !Task.isCancelled else { return nil }
        guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, animationOptions as CFDictionary) else { continue }
        frames.append((UIImage(cgImage: frame), frameDuration(source, index)))
      }
      // UIKit plays frames evenly, so each frame repeats once per tick of its delay; the repeats share
      // one bitmap. The tick grows with the animation's length to keep the timeline near 1,000 entries.
      let total = frames.reduce(0) { $0 + $1.delay }
      let tick = max(0.02, total / 1_000)
      guard !Task.isCancelled else { return nil }
      let timeline = frames.flatMap { frame in
        Array(repeating: frame.image, count: max(1, Int((frame.delay / tick).rounded())))
      }
      guard !Task.isCancelled else { return nil }
      if frames.count > 1 { return UIImage.animatedImage(with: timeline, duration: Double(timeline.count) * tick) }
    }
    guard !Task.isCancelled else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }

  nonisolated private static func frameDuration(_ source: CGImageSource, _ index: Int) -> Double {
    let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
    let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    let png = properties?[kCGImagePropertyPNGDictionary] as? [CFString: Any]
    let delay = gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double
      ?? gif?[kCGImagePropertyGIFDelayTime] as? Double
      ?? png?[kCGImagePropertyAPNGUnclampedDelayTime] as? Double
      ?? png?[kCGImagePropertyAPNGDelayTime] as? Double
      ?? 0.1
    // Browsers treat near-zero delays as 0.1s.
    return delay < 0.011 ? 0.1 : delay
  }
}

private let animationByteBudget = 64 * 1024 * 1024

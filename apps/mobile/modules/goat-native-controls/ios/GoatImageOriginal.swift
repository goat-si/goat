import Foundation

/// Holds the prepared original while the gallery or a consumer needs its bytes.
final class GoatImageOriginal: Sendable {
  let url: URL

  init(url: URL) {
    self.url = url
  }

  deinit {
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }

  func copyForPhotos() -> URL? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("goat-save-\(UUID().uuidString)", isDirectory: true)
    let copy = directory.appendingPathComponent(url.lastPathComponent)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: url, to: copy)
      return copy
    } catch {
      try? FileManager.default.removeItem(at: directory)
      return nil
    }
  }
}

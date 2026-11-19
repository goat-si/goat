import Foundation

@main
struct ImageOriginalTests {
  static func main() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let file = directory.appendingPathComponent("original.png")
    let bytes = Data([0, 17, 255])
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try bytes.write(to: file)

    var galleryOriginal: GoatImageOriginal? = GoatImageOriginal(url: file)
    let worker = Task.detached { [original = galleryOriginal] in original?.copyForPhotos() }
    galleryOriginal = nil
    guard let copy = await worker.value else { preconditionFailure("The file lease must survive gallery dismissal") }
    defer { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
    let savedBytes = try Data(contentsOf: copy)
    precondition(copy.lastPathComponent == file.lastPathComponent)
    precondition(savedBytes == bytes, "The copy keeps original bytes without re-encoding")
    print("Image original: copy retains the file and preserves its name and bytes")
  }
}

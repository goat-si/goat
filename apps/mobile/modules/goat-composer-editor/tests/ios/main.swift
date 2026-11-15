import UIKit
import UniformTypeIdentifiers

func check(_ passed: @autoclosure () -> Bool, _ message: String) {
  guard passed() else {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

private extension GoatComposerEditorView {
  var editor: ComposerTextView { subviews.compactMap { $0 as? ComposerTextView }.first! }
  var text: String { editor.serializedText() }

  func chip(at location: Int) -> ComposerTextAttachment? {
    guard location < editor.textStorage.length else { return nil }
    return editor.textStorage.attribute(.attachment, at: location, effectiveRange: nil) as? ComposerTextAttachment
  }

  func apply(_ value: String, tokensJson: String, echo: Bool = false) {
    let payload: [String: Any] = [
      "value": value,
      "selection": NSNull(),
      "tokensJson": tokensJson,
      "mostRecentEventCount": onComposerChange.payloads.last?["eventCount"] as? Int ?? 0,
      "isNativeEcho": echo,
    ]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    setControlledDocumentJson(String(decoding: data, as: UTF8.self))
  }
}

func mention(_ label: String, at start: Int, source: String = "@README.md") -> String {
  #"[{"type":"mention","source":"\#(source)","label":"\#(label)","start":\#(start),"end":\#(start + source.utf16.count)}]"#
}

func makeEditor(_ value: String, tokensJson: String = "[]") -> GoatComposerEditorView {
  let view = GoatComposerEditorView()
  view.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
  view.apply(value, tokensJson: tokensJson)
  check(view.text == value, "Initial controlled value did not reach UIKit")
  return view
}

do {
  let view = makeEditor("hi @README.md @README.md", tokensJson: mention("README.md", at: 3))
  guard let original = view.chip(at: 3) else { fatalError("Harness could not render the chip") }
  view.editor.selectedRange = NSRange(location: 2, length: 0)
  view.editor.insertText("!")
  let draft = "hi! @README.md @README.md"
  view.apply(draft, tokensJson: mention("README.md", at: 4), echo: true)
  check(view.chip(at: 4) === original, "An offset-only echo replaced the attachment")
  check(view.editor.selectedRange == NSRange(location: 3, length: 0), "An echo moved the caret")
  view.apply(draft, tokensJson: mention("Readme", at: 4))
  check(view.chip(at: 4)?.label == "Readme", "A relabeled chip was not redrawn")
  view.apply(draft, tokensJson: mention("Readme", at: 15))
  check(view.chip(at: 4) == nil && view.chip(at: 15) != nil, "A moved chip stayed at the old offset")
  print("Chip echo, relabel and move passed")
}

do {
  let original = "@\u{00E9}"
  let normalized = "@e\u{0301}"
  let view = makeEditor(original, tokensJson: mention("e", at: 0, source: original))
  view.apply(normalized, tokensJson: mention("e", at: 0, source: normalized))
  check(view.text.utf16.elementsEqual(normalized.utf16), "A renormalized chip kept the old UTF-16")
  print("Exact UTF-16 source passed")
}

do {
  let view = makeEditor("")
  view.setPlaceholder("Ask anything")
  check(view.editor.accessibilityLabel == "Ask anything", "VoiceOver cannot name the message field")
  print("Message field accessibility label passed")
}

do {
  let original = "hi @README.md ok"
  let chips = mention("Readme", at: 3)
  let view = makeEditor(original, tokensJson: chips)
  view.editor.selectedRange = NSRange(location: 3, length: 2)
  view.editor.cut(nil)
  check(view.text == "hi ok", "Cut did not remove the selection")
  check(view.editor.selectedRange == NSRange(location: 3, length: 0), "Cut did not collapse the selection")
  check(view.onComposerChange.payloads.last?["value"] as? String == "hi ok", "Cut did not emit an edit")
  view.apply("hi ok", tokensJson: "[]", echo: true)

  view.editor.undoManager?.undo()
  check(view.text == original, "Undo did not restore cut text and chip")
  let restored = view.chip(at: 3)
  let selection = view.editor.selectedRange
  check(restored?.label == "Readme", "Undo discarded chip metadata")
  check(view.onComposerChange.payloads.last?["value"] as? String == original, "Undo did not emit an edit")
  view.apply(original, tokensJson: chips, echo: true)
  check(view.chip(at: 3) === restored, "The Undo echo replaced the restored chip")
  check(view.editor.selectedRange == selection, "The Undo echo moved the selection")

  view.editor.undoManager?.redo()
  check(view.text == "hi ok", "Redo did not cut again")
  check(view.onComposerChange.payloads.last?["value"] as? String == "hi ok", "Redo did not emit an edit")
  print("Cut, Undo and Redo with controlled echoes passed")
}

do {
  let pasteboard = UIPasteboard.withUniqueName()
  defer { UIPasteboard.remove(withName: pasteboard.name) }
  let editor = ComposerTextView()
  editor.textPasteThresholdBytes = 32 * 1024
  let halfA = String(repeating: "A", count: 20_000)
  let halfB = String(repeating: "B", count: 20_000)
  var intercepted: String?
  editor.onPasteText = { text, _ in intercepted = text }

  pasteboard.strings = [halfA]
  check(!editor.interceptTextPaste(from: pasteboard), "A single short item should paste inline")
  pasteboard.strings = [halfA, halfB]
  check(editor.interceptTextPaste(from: pasteboard), "Combined items over the threshold must fold")
  check(intercepted == halfA + halfB, "The attachment lost text or changed pasteboard order")
  print("Multi-item text paste threshold passed")
}

// Two frames: compare original data so a still image cannot satisfy this check.
private let gifBytes = Data(base64Encoded: "R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAAoAAAAsAAAAAAEAAQCBAP8AAAAAAAAAAAAACAQAAQQEADs=")!
private let gifProvider = NSItemProvider()
gifProvider.registerDataRepresentation(forTypeIdentifier: UTType.gif.identifier, visibility: .all) { completion in
  completion(gifBytes, nil)
  return nil
}

private let stillImage = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
  UIColor.red.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
}
private let pasteEditor = ComposerTextView()
pasteEditor.onPasteImages = { uris in
  let urls = uris.compactMap(URL.init(string:))
  let contents = urls.compactMap { try? Data(contentsOf: $0) }
  urls.forEach { try? FileManager.default.removeItem(at: $0) }
  check(urls.map(\.pathExtension) == ["gif", "png"], "Mixed image paste changed formats or order: \(uris)")
  check(contents.first == gifBytes, "A pasted GIF lost its original bytes")
  check(contents.count == 2 && contents[1] == stillImage.pngData(), "The still image did not attach as PNG")
  print("Mixed GIF and PNG paste passed")
  exit(0)
}
pasteEditor.loadImages(from: [gifProvider, NSItemProvider(object: stillImage)])
dispatchMain()

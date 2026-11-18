import UIKit

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

import Foundation

struct NativeManifest {
  // Swift String equality normalizes Unicode; the manifest ceiling must preserve identifier bytes.
  private let apps: Set<Data>
  private let tools: Set<Data>

  init?(text: String) {
    // This is the generated GOAT ceiling, not a general YAML interpreter.
    guard text.utf8.count <= 1_048_576 else { return nil }
    let lines = text.components(separatedBy: "\n")
    let header = ["# Written by GOAT at each driver start. See ADR-0022.", "version: 3",
      "resources:", "  desktop:", "    display: true"]
    guard lines.count >= 9, Array(lines.prefix(5)) == header, lines.last == "" else { return nil }
    var index = 5
    var apps = Set<Data>()
    if lines[index] == "  apps: []" {
      index += 1
    } else {
      guard lines[index] == "  apps:" else { return nil }
      index += 1
      let prefix = "    - bundle_id: "
      while index < lines.count, lines[index].hasPrefix(prefix) {
        guard let value = Self.scalar(String(lines[index].dropFirst(prefix.count))) else { return nil }
        apps.insert(Data(value.utf8))
        index += 1
      }
      guard !apps.isEmpty else { return nil }
    }
    guard index + 2 < lines.count, lines[index] == "allow:", lines[index + 1] == "  tools:" else {
      return nil
    }
    index += 2
    var tools = Set<Data>()
    while index < lines.count - 1 {
      guard lines[index].hasPrefix("    - "),
        let value = Self.scalar(String(lines[index].dropFirst(6)))
      else { return nil }
      tools.insert(Data(value.utf8))
      index += 1
    }
    self.apps = apps
    self.tools = tools
  }

  func permits(bundleID: String, tool: String = "get_window_state") -> Bool {
    apps.contains(Data(bundleID.utf8)) && tools.contains(Data(tool.utf8))
  }

  private static func scalar(_ text: String) -> String? {
    guard text.first == "\"", text.last == "\"",
      let value = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
    else { return nil }
    return value as? String
  }
}

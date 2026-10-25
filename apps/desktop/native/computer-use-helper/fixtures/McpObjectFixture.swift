import Foundation

@main
enum McpObjectFixture {
  static func main() throws {
    while let line = readLine() {
      guard let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        let encoded = command["frame"] as? String, let frame = Data(base64Encoded: encoded),
        let keys = command["keys"] as? [String]
      else { throw FixtureError.command }
      try validateMcpObjectSyntax(frame)
      let prefix = command["prefix"] as? Int ?? 0
      var backing = Data(repeating: 0x20, count: prefix)
      backing.append(frame)
      let borrowed = backing.dropFirst(prefix)
      guard var object = McpObject(borrowed) else { throw FixtureError.object }
      for key in command["path"] as? [String] ?? [] {
        guard let child = object.object(key) else { throw FixtureError.object }
        object = child
      }
      var spans: [String: [Int]] = [:]
      var counts: [String: Int] = [:]
      var raw: [String: String] = [:]
      var strings: [String: String] = [:]
      for key in keys {
        if let span = object.span(key) { spans[key] = [span.lowerBound, span.upperBound] }
        counts[key] = object.count(key)
        raw[key] = object.raw(key)?.base64EncodedString()
        strings[key] = object.string(key)
      }
      var output: [String: Any] = [
        "spans": spans, "counts": counts, "raw": raw, "strings": strings,
        "data": object.data.base64EncodedString(), "start": object.data.startIndex,
      ]
      if let key = command["replaceKey"] as? String,
        let text = command["replacement"] as? String,
        let value = Data(base64Encoded: text)
      {
        let replaced = object.replacing(key, with: value)
        try validateMcpObjectSyntax(replaced)
        output["replaced"] = replaced.base64EncodedString()
      }
      let result = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
      print(String(decoding: result, as: UTF8.self))
    }
  }

  private enum FixtureError: Error { case command, object }
}

import Foundation

/// A selective view over an already syntax-validated frame. Spans retain the backing
/// Data's indices, including when the caller supplies a borrowed slice or nested object.
struct McpObject {
  let data: Data
  private let members: [String: Member]

  private struct Member {
    var span: Range<Int>
    var count: Int
  }

  private static let keys: Set<String> = [
    "jsonrpc", "id", "method", "params", "name", "arguments", "result", "error", "tools",
    "requestId", "code", "message", "structuredContent", "content", "pid", "window_id",
    "since", "invalidated_snapshot_ids", "session", "timeout_ms",
  ]
  private static let keyLength = keys.map(\.utf8.count).max() ?? 0

  init?(_ data: Data) {
    self.init(data, range: data.startIndex..<data.endIndex)
  }

  init?(_ data: Data, range: Range<Int>) {
    guard range.lowerBound >= data.startIndex, range.upperBound <= data.endIndex else { return nil }
    let selected = data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> [String: Member]? in
      var scanner = Scanner(
        bytes: bytes, cursor: range.lowerBound - data.startIndex,
        end: range.upperBound - data.startIndex)
      scanner.whitespace()
      guard scanner.take(0x7b) else { return nil }
      var found: [String: Member] = [:]
      scanner.whitespace()
      if !scanner.take(0x7d) {
        while true {
          guard let keySpan = scanner.stringSpan() else { return nil }
          let key = scanner.routingKey(keySpan)
          scanner.whitespace()
          guard scanner.take(0x3a) else { return nil }
          scanner.whitespace()
          guard let value = scanner.valueSpan() else { return nil }
          if let key {
            let span = (value.lowerBound + data.startIndex)..<(value.upperBound + data.startIndex)
            found[key] = Member(span: span, count: (found[key]?.count ?? 0) + 1)
          }
          scanner.whitespace()
          if scanner.take(0x7d) { break }
          guard scanner.take(0x2c) else { return nil }
          scanner.whitespace()
        }
      }
      scanner.whitespace()
      return scanner.cursor == scanner.end ? found : nil
    }
    guard let selected else { return nil }
    self.data = data
    members = selected
  }

  func span(_ key: String) -> Range<Int>? { members[key]?.span }

  func count(_ key: String) -> Int { members[key]?.count ?? 0 }

  func raw(_ key: String) -> Data? {
    guard let span = span(key) else { return nil }
    return Data(data[span])
  }

  func string(_ key: String) -> String? {
    guard let span = span(key), data[span.lowerBound] == 0x22 else { return nil }
    // Only explicitly requested routing strings are decoded; opaque values remain lexical.
    return (try? JSONSerialization.jsonObject(with: Data(data[span]), options: [.fragmentsAllowed]))
      as? String
  }

  func object(_ key: String) -> McpObject? {
    guard let span = span(key), data[span.lowerBound] == 0x7b else { return nil }
    return McpObject(data, range: span)
  }

  func replacing(_ key: String, with value: Data) -> Data {
    guard let span = span(key) else { return data }
    var result = Data(data[..<span.lowerBound])
    result.append(value)
    result.append(contentsOf: data[span.upperBound...])
    return result
  }

  private struct Scanner {
    let bytes: UnsafeRawBufferPointer
    var cursor: Int
    let end: Int

    mutating func take(_ byte: UInt8) -> Bool {
      guard cursor < end, bytes[cursor] == byte else { return false }
      cursor += 1
      return true
    }

    mutating func whitespace() {
      while cursor < end {
        switch bytes[cursor] {
        case 0x20, 0x09, 0x0a, 0x0d: cursor += 1
        default: return
        }
      }
    }

    mutating func stringSpan() -> Range<Int>? {
      let start = cursor
      guard take(0x22) else { return nil }
      while cursor < end {
        let byte = bytes[cursor]
        cursor += 1
        if byte == 0x22 { return start..<cursor }
        if byte == 0x5c {
          guard cursor < end else { return nil }
          cursor += 1
        }
      }
      return nil
    }

    func routingKey(_ span: Range<Int>) -> String? {
      // A recognized ASCII character occupies at most six bytes (\uXXXX). Unknown
      // keys never allocate storage proportional to their length or enter the member map.
      guard span.count <= McpObject.keyLength * 6 + 2 else { return nil }
      var decoded: [UInt8] = []
      var index = span.lowerBound + 1
      let stop = span.upperBound - 1
      while index < stop {
        var byte = bytes[index]
        index += 1
        if byte == 0x5c {
          guard stop - index >= 5, bytes[index] == 0x75,
            bytes[index + 1] == 0x30, bytes[index + 2] == 0x30,
            let high = hex(bytes[index + 3]), let low = hex(bytes[index + 4])
          else { return nil }
          byte = high * 16 + low
          index += 5
        }
        guard byte < 0x80, decoded.count < McpObject.keyLength else { return nil }
        decoded.append(byte)
      }
      let key = String(decoding: decoded, as: UTF8.self)
      return McpObject.keys.contains(key) ? key : nil
    }

    private func hex(_ byte: UInt8) -> UInt8? {
      switch byte {
      case 0x30...0x39: return byte - 0x30
      case 0x41...0x46: return byte - 0x41 + 10
      case 0x61...0x66: return byte - 0x61 + 10
      default: return nil
      }
    }

    mutating func valueSpan() -> Range<Int>? {
      guard cursor < end else { return nil }
      let start = cursor
      if bytes[cursor] == 0x22 { return stringSpan() }
      if bytes[cursor] == 0x7b || bytes[cursor] == 0x5b {
        // Admission already checked matching delimiters. A counter skips arbitrarily
        // deep opaque containers without recursion or building another syntax tree.
        var depth = 0
        while cursor < end {
          switch bytes[cursor] {
          case 0x22:
            guard stringSpan() != nil else { return nil }
          case 0x7b, 0x5b: depth += 1; cursor += 1
          case 0x7d, 0x5d:
            depth -= 1
            cursor += 1
            if depth == 0 { return start..<cursor }
          default: cursor += 1
          }
        }
        return nil
      }
      while cursor < end {
        switch bytes[cursor] {
        case 0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x7d, 0x5d:
          return cursor > start ? start..<cursor : nil
        default: cursor += 1
        }
      }
      return nil
    }
  }
}

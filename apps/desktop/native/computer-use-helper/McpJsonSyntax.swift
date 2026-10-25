import Foundation

/// Transport admission checks syntax without constructing scalar values: opaque JSON can
/// contain surrogate escapes or exponents a platform object decoder cannot represent.
func validateMcpObjectSyntax(_ frame: Data) throws {
  try frame.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
    var parser = McpJsonSyntax(bytes)
    try parser.validate()
  }
}

private struct McpJsonSyntax {
  private enum State: UInt8 {
    case objectFirst, objectKey, objectColon, objectValue, objectNext
    case arrayFirst, arrayValue, arrayNext
  }

  let bytes: UnsafeRawBufferPointer
  let maxDepth: Int
  var cursor = 0
  var stack: [UInt8] = []

  init(_ bytes: UnsafeRawBufferPointer) {
    self.bytes = bytes
    maxDepth = bytes.count / 2
  }

  var next: UInt8? { cursor < bytes.count ? bytes[cursor] : nil }

  mutating func validate() throws {
    whitespace()
    try expect(0x7b)
    try push(.objectFirst)
    while let state = stack.last {
      whitespace()
      switch state {
      case State.objectFirst.rawValue:
        if take(0x7d) { stack.removeLast() }
        else { try string(); set(.objectColon) }
      case State.objectKey.rawValue:
        try string()
        set(.objectColon)
      case State.objectColon.rawValue:
        try expect(0x3a)
        set(.objectValue)
      case State.objectValue.rawValue:
        set(.objectNext)
        try value()
      case State.objectNext.rawValue:
        if take(0x2c) { set(.objectKey) }
        else { try expect(0x7d); stack.removeLast() }
      case State.arrayFirst.rawValue:
        if take(0x5d) { stack.removeLast() }
        else { set(.arrayNext); try value() }
      case State.arrayValue.rawValue:
        set(.arrayNext)
        try value()
      case State.arrayNext.rawValue:
        if take(0x2c) { set(.arrayValue) }
        else { try expect(0x5d); stack.removeLast() }
      default:
        throw McpFrameError.invalidObject
      }
    }
    whitespace()
    guard cursor == bytes.count else { throw McpFrameError.invalidObject }
  }

  private mutating func push(_ state: State) throws {
    // Every valid container needs two bytes. Enforce that bound on malformed openers too.
    guard stack.count < maxDepth else { throw McpFrameError.invalidObject }
    stack.append(state.rawValue)
    assert(stack.count <= maxDepth)
  }

  private mutating func set(_ state: State) { stack[stack.count - 1] = state.rawValue }

  mutating func take(_ byte: UInt8) -> Bool {
    guard next == byte else { return false }
    cursor += 1
    return true
  }

  mutating func expect(_ byte: UInt8) throws {
    guard take(byte) else { throw McpFrameError.invalidObject }
  }

  mutating func whitespace() {
    while let byte = next, byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d {
      cursor += 1
    }
  }

  mutating func value() throws {
    guard let byte = next else { throw McpFrameError.invalidObject }
    switch byte {
    case 0x7b: cursor += 1; try push(.objectFirst)
    case 0x5b: cursor += 1; try push(.arrayFirst)
    case 0x22: try string()
    case 0x74: try word([0x74, 0x72, 0x75, 0x65])
    case 0x66: try word([0x66, 0x61, 0x6c, 0x73, 0x65])
    case 0x6e: try word([0x6e, 0x75, 0x6c, 0x6c])
    case 0x2d, 0x30...0x39: try number()
    default: throw McpFrameError.invalidObject
    }
  }

  mutating func word(_ expected: [UInt8]) throws {
    for byte in expected { try expect(byte) }
  }

  mutating func number() throws {
    _ = take(0x2d)
    if !take(0x30) {
      guard let byte = next, byte >= 0x31 && byte <= 0x39 else {
        throw McpFrameError.invalidObject
      }
      try digits()
    }
    if take(0x2e) { try digits() }
    if take(0x65) || take(0x45) {
      if next == 0x2b || next == 0x2d { cursor += 1 }
      try digits()
    }
  }

  mutating func digits() throws {
    let start = cursor
    while let byte = next, byte >= 0x30 && byte <= 0x39 { cursor += 1 }
    guard cursor > start else { throw McpFrameError.invalidObject }
  }

  mutating func string() throws {
    try expect(0x22)
    while let byte = next {
      if take(0x22) { return }
      if take(0x5c) {
        guard let escape = next else { throw McpFrameError.invalidObject }
        cursor += 1
        switch escape {
        case 0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74: break
        case 0x75:
          for _ in 0..<4 {
            guard let hex = next,
              (hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46)
                || (hex >= 0x61 && hex <= 0x66)
            else { throw McpFrameError.invalidObject }
            cursor += 1
          }
        default: throw McpFrameError.invalidObject
        }
      } else if byte < 0x20 {
        throw McpFrameError.invalidObject
      } else if byte < 0x80 {
        cursor += 1
      } else {
        try utf8()
      }
    }
    throw McpFrameError.invalidObject
  }

  mutating func utf8() throws {
    guard let lead = next else { throw McpFrameError.invalidObject }
    let length: Int
    let second: ClosedRange<UInt8>
    switch lead {
    case 0xc2...0xdf: length = 2; second = 0x80...0xbf
    case 0xe0: length = 3; second = 0xa0...0xbf
    case 0xe1...0xec, 0xee...0xef: length = 3; second = 0x80...0xbf
    case 0xed: length = 3; second = 0x80...0x9f
    case 0xf0: length = 4; second = 0x90...0xbf
    case 0xf1...0xf3: length = 4; second = 0x80...0xbf
    case 0xf4: length = 4; second = 0x80...0x8f
    default: throw McpFrameError.invalidObject
    }
    guard bytes.count - cursor >= length, second.contains(bytes[cursor + 1]) else {
      throw McpFrameError.invalidObject
    }
    for offset in 2..<length {
      let continuation = bytes[cursor + offset]
      guard continuation >= 0x80 && continuation <= 0xbf else {
        throw McpFrameError.invalidObject
      }
    }
    cursor += length
  }
}

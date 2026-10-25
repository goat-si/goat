import Darwin
import Foundation

// MCP screenshots can contain 25 MiB of image bytes, expanded to base64 on the wire. The
// ceiling bounds each raw frame, excluding LF; it does not claim to bound decoder memory.
let mcpFrameLimit = 64 * 1024 * 1024

enum McpFrameError: Error {
  case tooLarge
  case invalidObject
}

/// Validate before forwarding any part of a frame. Keeping its bytes preserves unknown fields,
/// numeric id spellings and schemas; application text remains data, including escaped newlines.
func pumpMcpFrames(
  from source: FileHandle, to destination: FileHandle, acceptTail: Bool,
  limit: Int = mcpFrameLimit, handle: ((Data) throws -> Void)? = nil
) throws {
  var frame = Data()
  func append(_ part: Data.SubSequence) throws {
    guard part.count <= limit - frame.count else { throw McpFrameError.tooLarge }
    frame.append(part)
  }
  func forward() throws {
    if frame.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0d }) {
      frame.removeAll(keepingCapacity: false)
      return
    }
    try validateMcpObjectSyntax(frame)
    if let handle {
      try handle(frame)
    } else {
      frame.append(0x0a)
      try destination.write(contentsOf: frame)
    }
    frame.removeAll(keepingCapacity: false)
  }
  // A pipe read must return the currently available bytes; Foundation can fill its requested
  // length before returning, which would stall the first short MCP handshake indefinitely.
  var bytes = [UInt8](repeating: 0, count: 64 * 1024)
  while true {
    let count = bytes.withUnsafeMutableBytes { Darwin.read(source.fileDescriptor, $0.baseAddress, $0.count) }
    if count < 0 {
      if errno == EINTR { continue }
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    if count == 0 { break }
    let chunk = Data(bytes.prefix(count))
    var start = chunk.startIndex
    for end in chunk.indices where chunk[end] == 0x0a {
      try append(chunk[start..<end])
      try forward()
      start = chunk.index(after: end)
    }
    try append(chunk[start..<chunk.endIndex])
  }
  // Closing the agent's input cannot dispatch a partial request. A driver may exit without
  // a final delimiter; its complete validated reply must still drain on normal completion.
  if acceptTail && !frame.isEmpty { try forward() }
}

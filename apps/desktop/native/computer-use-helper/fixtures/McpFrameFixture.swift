import Darwin
import Foundation

@main
enum McpFrameFixture {
  static func main() {
    if CommandLine.arguments.contains("--syntax-lines") {
      while let line = readLine() {
        do {
          guard let frame = Data(base64Encoded: line) else { exit(64) }
          try validateMcpObjectSyntax(frame)
          print("valid")
        } catch {
          print("invalid")
        }
      }
      return
    }
    do {
      try pumpMcpFrames(
        from: .standardInput, to: .standardOutput,
        acceptTail: CommandLine.arguments.contains("--tail"), limit: 64)
    } catch {
      exit(65)
    }
  }
}

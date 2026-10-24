import Darwin
import Foundation

@main
enum McpFrameFixture {
  static func main() {
    do {
      try pumpMcpFrames(
        from: .standardInput, to: .standardOutput,
        acceptTail: CommandLine.arguments.contains("--tail"), limit: 64)
    } catch {
      exit(65)
    }
  }
}

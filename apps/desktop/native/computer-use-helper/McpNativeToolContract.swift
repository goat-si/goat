import CoreFoundation
import Foundation

let windowSettleToolName = "wait_for_window_settle"

func readNativeManifest(_ path: String) -> NativeManifest? {
  guard let file = FileHandle(forReadingAtPath: path) else { return nil }
  defer { try? file.close() }
  guard let bytes = try? file.read(upToCount: 1_048_577), bytes.count <= 1_048_576,
    let text = String(data: bytes, encoding: .utf8) else { return nil }
  return NativeManifest(text: text)
}

func mcpJSON(_ value: Any) throws -> Data {
  // Only GOAT-owned envelopes and typed driver results reach this encoder. Opaque frames
  // stay as raw bytes in McpObject, including scalars Foundation cannot materialize.
  try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
}

let windowSettleTool: [String: Any] = [
  "name": windowSettleToolName,
  "description": "Wait for notifications from one window to become quiet, then take a fresh observation. Quiet does not prove a task is complete. A deadline or unavailable target is reported explicitly; never replay an action based on quiet alone.",
  "inputSchema": [
    "type": "object", "additionalProperties": false, "required": ["pid", "window_id"],
    "properties": [
      "pid": ["type": "integer", "minimum": 1, "maximum": Int(Int32.max)],
      "window_id": ["type": "integer", "minimum": 1, "maximum": Int(UInt32.max)],
      "session": ["type": "string", "minLength": 1, "maxLength": 128],
      "quiet_ms": ["type": "integer", "minimum": 50, "maximum": 2000, "default": 200],
      "timeout_ms": ["type": "integer", "minimum": 100, "maximum": 30000, "default": 5000],
    ],
  ],
  "outputSchema": [
    "type": "object", "additionalProperties": true,
    "required": ["pid", "window_id", "settle", "sample"],
    "properties": [
      "pid": ["type": "integer"], "window_id": ["type": "integer"],
      "settle": [
        "type": "object", "additionalProperties": false,
        "required": ["outcome", "reason", "quiet_ms", "observed_quiet_ms", "coverage"],
        "properties": [
          "outcome": ["type": "string", "enum": ["settled", "pending", "unsupported", "destroyed"]],
          "reason": ["type": "string"], "quiet_ms": ["type": "integer"],
          "observed_quiet_ms": ["type": "integer"],
          "coverage": ["type": "array", "items": ["type": "string"]],
        ],
      ],
      "sample": [
        "type": "object", "additionalProperties": false, "required": ["unavailable"],
        "properties": [
          "unavailable": ["type": "boolean"], "reason": ["type": "string"],
          "started_after_ms": ["type": "integer", "minimum": 0],
          "completed_after_ms": ["type": "integer", "minimum": 0],
        ],
      ],
    ],
  ],
  "annotations": [
    "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false,
  ],
]

func settleArguments(_ data: Data) -> SettleRequest? {
  guard data.count <= 8192,
    let args = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(args.keys).isSubset(of: ["pid", "window_id", "session", "quiet_ms", "timeout_ms"])
  else { return nil }
  func integer(_ name: String, fallback: Int64? = nil) -> Int64? {
    guard let value = args[name] else { return fallback }
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
      number.doubleValue.rounded() == number.doubleValue,
      number.doubleValue >= 0, number.doubleValue <= Double(UInt32.max)
    else { return nil }
    return number.int64Value
  }
  guard let pid = integer("pid"), pid > 0, pid <= Int64(Int32.max),
    let window = integer("window_id"), window > 0,
    let quiet = integer("quiet_ms", fallback: 200), (50...2000).contains(quiet),
    let timeout = integer("timeout_ms", fallback: 5000), (100...30000).contains(timeout), quiet <= timeout
  else { return nil }
  var session: String?
  if let value = args["session"] {
    guard let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.unicodeScalars.count <= 128
    else { return nil }
    session = text
  }
  return SettleRequest(pid: Int32(pid), windowID: UInt32(window), quietMs: quiet, timeoutMs: timeout, session: session)
}

func nativeToolFailure(_ code: String, _ message: String, extra: [String: Any] = [:]) -> [String: Any] {
  var detail = extra
  detail["code"] = code
  detail["message"] = message
  return ["isError": true, "content": [["type": "text", "text": message]], "structuredContent": detail]
}

func settleToolResult(
  _ completion: SettleCompletion, request: SettleRequest, startedAt: Int64,
  driverCode: Any? = nil
) -> [String: Any] {
  if completion.outcome == "sample_failed" {
    return nativeToolFailure("sample_failed", completion.message ?? "The final observation failed.", extra: [
      "driver_code": driverCode ?? NSNull(), "pid": Int(request.pid), "window_id": Int(request.windowID),
      "invalidated_snapshot_ids": completion.invalidated,
    ])
  }
  var result: [String: Any] = [:]
  if let sample = completion.sample,
    let decoded = try? JSONSerialization.jsonObject(with: sample.result) as? [String: Any]
  { result = decoded }
  var structured = result["structuredContent"] as? [String: Any] ?? [:]
  structured["pid"] = Int(request.pid)
  structured["window_id"] = Int(request.windowID)
  if let session = request.session { structured["session"] = session }
  structured["settle"] = [
    "outcome": completion.outcome, "reason": completion.reason, "quiet_ms": request.quietMs,
    "observed_quiet_ms": completion.observedQuietMs, "coverage": completion.coverage,
  ]
  if completion.sample != nil, let began = completion.sampleStartedAt, let ended = completion.sampleCompletedAt {
    structured["sample"] = [
      "unavailable": false, "started_after_ms": max(0, began - startedAt),
      "completed_after_ms": max(0, ended - startedAt),
    ]
  } else {
    structured["sample"] = ["unavailable": true, "reason": completion.reason]
  }
  if !completion.invalidated.isEmpty { structured["invalidated_snapshot_ids"] = completion.invalidated }
  result["structuredContent"] = structured
  // First, beside any sample content: providers that drop or fold structuredContent keep only
  // this line to tell pending or unsupported from settled.
  let summary: [String: Any] = ["type": "text", "text": "Notification settle: \(completion.outcome) (\(completion.reason)). Quiet does not establish task completion."]
  result["content"] = [summary] + (result["content"] as? [Any] ?? [])
  return result
}

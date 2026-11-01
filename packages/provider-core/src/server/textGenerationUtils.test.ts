import { describe, expect, it } from "vite-plus/test";

import { classifyTextGenerationFailure, sanitizeCommitSubject } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("classifyTextGenerationFailure", () => {
  it.each([
    [
      "schema_rejected",
      `Codex CLI command failed: ERROR: {"type":"error","error":{"message":"Invalid schema for response_format 'codex_output_schema': schema must be a JSON Schema of 'type: \\"object\\"', got 'type: \\"None\\"'.","type":"invalid_request_error","param":"text.format.schema","code":"invalid_json_schema"},"status":400}`,
    ],
    ["auth", 'Codex CLI command failed: ERROR: {"type":"error","status":401}'],
    ["auth", "Claude CLI command failed: Not logged in · Please run /login"],
    ["auth", "Sign in with Cursor or add CURSOR_API_KEY in provider settings."],
    [
      "rate_limited",
      'Codex CLI command failed: {"error":{"code":"usage_limit_reached"},"status":429}',
    ],
    ["timeout", "Codex CLI request timed out."],
    ["timeout", "Antigravity text generation timed out."],
    ["unavailable", "Codex is disabled in GOAT settings."],
    ["unavailable", "This provider does not support channel reception."],
    ["unavailable", "No provider instance registered for id 'codex_personal'."],
    ["unavailable", "Codex CLI (`codex`) is required but not available on PATH."],
    ["invalid_output", "Codex returned invalid structured output."],
    ["invalid_output", "The model chose an action without the fields it needs."],
    ["failed", "Codex CLI command failed with code 1."],
    // Words in configuration keys or echoed text are not causes.
    ["failed", "Codex CLI command failed: error assigning model route"],
    ["failed", "Codex CLI command failed: invalid value for request_timeout_ms"],
    ["failed", "Codex CLI command failed: the prompt mentioned a 401 and a timeout and a sign in"],
  ] as const)("classifies %s: %s", (kind, detail) => {
    expect(classifyTextGenerationFailure({ detail })).toBe(kind);
  });
});

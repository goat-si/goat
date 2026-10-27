// @effect-diagnostics preferSchemaOverJson:off -- The cases are MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";

import { resolveKeyCall } from "./ComputerUseKeyNames.ts";

const call = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
const window = { pid: 4, window_id: 9 };
const sent = (line: string) => {
  const result = resolveKeyCall(line);
  assert.isTrue("line" in result, JSON.stringify(result));
  return (JSON.parse((result as { line: string }).line) as { params: { arguments: unknown } })
    .params.arguments;
};

describe("key names before a call reaches the driver", () => {
  it("sends a symbol typed with shift as its key plus shift", () => {
    assert.deepEqual(sent(call("press_key", { ...window, key: "*" })), {
      ...window,
      key: "8",
      modifiers: ["shift"],
    });
    assert.deepEqual(sent(call("press_key", { ...window, key: "asterisk", modifiers: ["cmd"] })), {
      ...window,
      key: "8",
      modifiers: ["cmd", "shift"],
    });
    assert.deepEqual(sent(call("hotkey", { ...window, keys: ["cmd", "shift", "?"] })), {
      ...window,
      keys: ["cmd", "shift", "/"],
    });
  });

  it("splits an xdotool combination and maps keypad keys to the main-row key", () => {
    assert.deepEqual(sent(call("press_key", { ...window, key: "super+c" })), {
      ...window,
      key: "c",
      modifiers: ["cmd"],
    });
    assert.deepEqual(sent(call("press_key", { ...window, key: "KP_0" })), { ...window, key: "0" });
    assert.deepEqual(sent(call("press_key", { ...window, key: "Prior" })), {
      ...window,
      key: "pageup",
    });
  });

  it("leaves keys the driver already presses unchanged", () => {
    for (const line of [
      call("press_key", { ...window, key: "Return" }),
      call("press_key", { ...window, key: "a", modifiers: ["cmd"] }),
      call("hotkey", { ...window, keys: ["cmd", "c"] }),
      call("click", { ...window, x: 1, y: 2 }),
    ])
      assert.deepEqual(resolveKeyCall(line), { line });
  });

  it("refuses a key no driver can press as invalid_arguments with nothing sent", () => {
    for (const line of [
      call("press_key", { ...window, key: "notakey" }),
      call("press_key", { ...window, key: "c", modifiers: ["hyper"] }),
      call("hotkey", { ...window, keys: ["cmd", "€"] }),
    ]) {
      const result = resolveKeyCall(line);
      assert.isTrue("answer" in result, line);
      const answer = JSON.parse((result as { answer: string }).answer) as {
        id: number;
        result: { isError: boolean; structuredContent: Record<string, unknown> };
      };
      assert.equal(answer.id, 7);
      assert.isTrue(answer.result.isError);
      assert.deepInclude(answer.result.structuredContent, {
        code: "invalid_arguments",
        effect: "refused",
        dispatched: false,
      });
    }
  });
});

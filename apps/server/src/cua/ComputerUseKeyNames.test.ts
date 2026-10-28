// @effect-diagnostics preferSchemaOverJson:off -- The cases are MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";

import { driverPressesKeypad, resolveKeyCall } from "./ComputerUseKeyNames.ts";

const call = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
const window = { pid: 4, window_id: 9 };
const sent = (line: string, options?: { readonly keypad?: boolean }) => {
  const result = resolveKeyCall(line, options);
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

  it("splits an xdotool combination and, for a driver without keypad codes, maps keypad keys to the main row", () => {
    assert.deepEqual(sent(call("press_key", { ...window, key: "super+c" })), {
      ...window,
      key: "c",
      modifiers: ["cmd"],
    });
    assert.deepEqual(sent(call("press_key", { ...window, key: "KP_0" }), { keypad: false }), {
      ...window,
      key: "0",
    });
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

  it("resolving a resolved call again changes nothing, so the driver's own pass agrees", () => {
    const names = [
      "*",
      "asterisk",
      "?",
      "+",
      "super+c",
      "ctrl+shift+Tab",
      "Prior",
      "Next",
      "KP_0",
      "KP_Add",
      "KP_Enter",
      "PgDn",
      "ArrowLeft",
      "Return",
      "a",
    ];
    for (const keypad of [false, true])
      for (const key of names) {
        const once = resolveKeyCall(call("press_key", { ...window, key }), { keypad });
        assert.isTrue("line" in once, key);
        const line = (once as { line: string }).line;
        assert.deepEqual(resolveKeyCall(line, { keypad }), { line }, key);
      }
  });

  it("passes keypad keys through to a driver that presses them", () => {
    assert.isFalse(driverPressesKeypad("0.38.0-goat.3"));
    assert.isTrue(driverPressesKeypad("0.38.0-goat.4"));
    for (const key of ["KP_0", "KP_9", "KP_Add", "kp_decimal"]) {
      const line = call("press_key", { ...window, key });
      assert.deepEqual(resolveKeyCall(line, { keypad: true }), { line }, key);
    }
  });

  it("refuses a hotkey with an unknown modifier or more than one plain key", () => {
    for (const keys of [
      ["ctl", "w"],
      ["cmd", "k", "c"],
      ["CommandOrControl", "q"],
    ]) {
      const result = resolveKeyCall(call("hotkey", { ...window, keys }));
      assert.isTrue("answer" in result, keys.join("+"));
    }
  });

  it("sends a spelled-out key name as the key the driver knows", () => {
    for (const [key, sentKey] of [
      ["ArrowLeft", "left"],
      ["KP_Enter", "enter"],
      ["Bksp", "backspace"],
      ["fwd_delete", "forward_delete"],
    ])
      for (const keypad of [false, true]) {
        const result = resolveKeyCall(call("press_key", { ...window, key }), { keypad });
        assert.isTrue("line" in result, key);
        assert.include((result as { line: string }).line, '"key":"' + sentKey + '"', key);
      }
  });
});

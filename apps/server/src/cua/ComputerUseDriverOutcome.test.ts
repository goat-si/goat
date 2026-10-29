import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { driverExitReason } from "./ComputerUseDriverExit.ts";
import { captureStalled, driverOutcomeSafety, markUnverified } from "./ComputerUseDriverOutcome.ts";

const reply = (structuredContent: unknown, isError = true) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: {
      isError,
      content: [
        {
          type: "text",
          text: "AX action failed: AXUIElementPerformAction(AXOpen) returned -25205",
        },
      ],
      structuredContent,
    },
  });
const parsed = (line: string) =>
  JSON.parse(line) as {
    result: { structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
  };

describe("macOS input tool errors after dispatch reach the agent as may-have-acted", () => {
  it("a forwarded write with effect unknown or a tool_call cancellation error exposes possibleCommit true and retryClass never", () => {
    for (const code of [
      undefined,
      "tool_call_cancelled",
      "tool_call_abandoned",
      "tool_call_timeout",
    ]) {
      for (const envelope of ["result", "error"]) {
        const data = code ? { code } : { effect: "unknown" };
        const line =
          envelope === "result"
            ? reply(data)
            : JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                error: { code: -32000, message: "Stopped", data },
              });
        const out = JSON.parse(markUnverified("click", line));
        const emitted = envelope === "result" ? out.result.structuredContent : out.error.data;
        assert.deepInclude(emitted, data);
        assert.deepInclude(emitted.safety, {
          possibleCommit: true,
          retryClass: "never",
          writeStatus: "may_have_applied",
        });
      }
    }
  });

  it("a click whose AX action errored after it was sent is unverifiable, never a plain failure", () => {
    const out = parsed(markUnverified("click", reply({ code: "tool_invocation_failed" })));
    assert.equal(out.result.structuredContent.effect, "unverifiable");
    assert.equal(out.result.structuredContent.code, "tool_invocation_failed");
    assert.include(out.result.content.at(-1)?.text ?? "", "may have acted");
  });

  it("an error the driver raises before any input leaves stays a plain refusal", () => {
    const line = reply({ code: "stale_element_token" });
    assert.deepInclude(parsed(markUnverified("click", line)).result.structuredContent, {
      code: "stale_element_token",
      safety: {
        possibleCommit: false,
        retryClass: "new_key",
        writeStatus: "not_started",
        code: "write_refused_reobserve",
      },
    });
  });

  it("a refusal that says nothing went out is not marked may-have-acted", () => {
    for (const structured of [
      { code: "px_capture_unavailable", window_id: 9 },
      { code: "bring_to_front_window_not_found", activated: false, request_accepted: false },
      { code: "paste_target_is_browser_chrome", delivered: false },
    ]) {
      const out = parsed(markUnverified("click", reply(structured)));
      assert.notProperty(out.result.structuredContent, "effect", structured.code);
      assert.notInclude(out.result.content.at(-1)?.text ?? "", "may have acted");
      assert.isFalse(
        (out.result.structuredContent.safety as { possibleCommit: boolean }).possibleCommit,
      );
    }
  });

  it("an explicit effect from the driver is kept as it said", () => {
    const line = reply({ code: "tool_invocation_failed", effect: "refused" });
    assert.deepInclude(parsed(markUnverified("type_text", line)).result.structuredContent, {
      effect: "refused",
      code: "tool_invocation_failed",
    });
  });

  it("read-only tools and successful replies preserve their effect and expose safety", () => {
    const failedRead = reply({ code: "tool_invocation_failed" });
    assert.deepInclude(
      parsed(markUnverified("get_window_state", failedRead)).result.structuredContent.safety,
      { possibleCommit: false, writeStatus: "not_applicable" },
    );
    const ok = reply({ effect: "confirmed" }, false);
    assert.deepInclude(parsed(markUnverified("click", ok)).result.structuredContent, {
      effect: "confirmed",
      safety: {
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "committed",
        code: "write_committed",
      },
    });
  });

  it("an input error with no structured content at all is also unverifiable", () => {
    const out = parsed(markUnverified("press_key", reply(undefined)));
    assert.equal(out.result.structuredContent.effect, "unverifiable");
  });

  it("GOAT's not-started gate overrides unknown driver metadata for reads and writes", () => {
    for (const tool of ["click", "get_window_state"]) {
      const safety = driverOutcomeSafety(tool, {
        status: "not_started",
        result: { structuredContent: { effect: "unknown" } },
      });
      assert.isFalse(safety.possibleCommit);
      assert.equal(safety.writeStatus, tool === "click" ? "not_started" : "not_applicable");
    }
  });
});

describe("every driver answer maps onto the shared outcome contract", () => {
  const rpcError = (code: number, data?: unknown) => ({
    jsonrpc: "2.0",
    id: 7,
    error: { code, message: "x", ...(data === undefined ? {} : { data }) },
  });

  it("only JSON-RPC protocol rejections ran nothing; a request timeout or internal error may have acted", () => {
    for (const code of [-32700, -32600, -32601, -32602])
      assert.deepInclude(driverOutcomeSafety("click", rpcError(code)), {
        possibleCommit: false,
        retryClass: "fix_input",
      });
    for (const code of [-32800, -32603, -32000])
      assert.deepInclude(driverOutcomeSafety("click", rpcError(code)), {
        possibleCommit: true,
        retryClass: "never",
      });
    // Data that is not an object is kept inside an envelope that also carries the safety.
    for (const data of ["boom", ["a"], null]) {
      const failed = JSON.parse(markUnverified("click", JSON.stringify(rpcError(-32603, data))));
      assert.deepEqual(failed.error.data.driverData, data);
      assert.deepInclude(failed.error.data.safety, { possibleCommit: true, retryClass: "never" });
      assert.include(failed.error.message, "may have acted");
    }
    const refused = JSON.parse(markUnverified("click", JSON.stringify(rpcError(-32602, "bad"))));
    assert.equal(refused.error.data.driverData, "bad");
    assert.isFalse(refused.error.data.safety.possibleCommit);
    assert.equal(refused.error.message, "x");
  });

  it("a write success without structuredContent keeps its text and gets safety as a text block", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "Typed 4 characters." }] },
    });
    const out = JSON.parse(markUnverified("type_text", line));
    assert.notProperty(out.result, "structuredContent");
    assert.equal(out.result.content[0].text, "Typed 4 characters.");
    assert.include(out.result.content[1].text, '"possibleCommit":true');
    // A read's success is left as the driver sent it.
    const read = line.replace("Typed 4 characters.", "2 windows");
    assert.equal(markUnverified("list_windows", read), read);
  });

  it("GOAT's own refusal relayed back is classified by its detail, never as may-have-acted", () => {
    const goat = (detail: string) =>
      driverOutcomeSafety("click", {
        result: { isError: true, structuredContent: { refused: "targetRefused", detail } },
      });
    assert.deepInclude(goat("target_busy"), { possibleCommit: false, retryClass: "new_key" });
    assert.deepInclude(goat("token_first"), { possibleCommit: false, retryClass: "fix_input" });
    assert.deepInclude(goat("capture_hide_unconfirmed"), {
      possibleCommit: false,
      retryClass: "same_key",
    });
    assert.deepInclude(goat("stopped"), { possibleCommit: false, retryClass: "never" });
    // The proxy answers a call it refused before the driver as not_started.
    const notStarted = driverOutcomeSafety("click", {
      status: "not_started",
      result: {
        isError: true,
        structuredContent: { refused: "targetRefused", detail: "app_busy" },
      },
    });
    assert.deepInclude(notStarted, { possibleCommit: false, retryClass: "new_key" });
  });

  it("an explicit effect outranks a refused status, and a code that can follow mouse-down is no refusal", () => {
    const answer = (structuredContent: unknown) =>
      driverOutcomeSafety("click", { result: { isError: true, structuredContent } });
    assert.isTrue(answer({ effect: "unverifiable", status: "refused" }).possibleCommit);
    assert.isTrue(answer({ code: "foreground_unavailable" }).possibleCommit);
    assert.isFalse(
      answer({ status: "refused", refusal: { code: "stale_element_token" } }).possibleCommit,
    );
    // Each of these follows sent input, so it may have landed until an observation says otherwise.
    for (const effect of ["suspected_noop", "no_drop", "not_applied"])
      assert.deepInclude(answer({ effect }), { possibleCommit: true, retryClass: "never" });
  });

  it("the driver's word that nothing went out and GOAT's tree-diff verification classify as said", () => {
    const answer = (structuredContent: unknown, isError = true) =>
      driverOutcomeSafety("click", { result: { isError, structuredContent } });
    assert.isFalse(answer({ code: "stale_geometry" }).possibleCommit);
    for (const said of [
      { dispatched: false },
      { delivered: false },
      { activated: false, request_accepted: false },
    ])
      assert.deepInclude(answer({ code: "delivery_failed", ...said }), {
        possibleCommit: false,
        writeStatus: "not_started",
      });
    assert.isFalse(answer({ dispatched: false }, false).possibleCommit);
    // activated false alone does not say the request was refused.
    assert.isTrue(answer({ code: "delivery_failed", activated: false }).possibleCommit);
    const verified = { effect: "confirmed", verified_by: "goat_ax_diff", ax_changed: true };
    assert.equal(answer(verified, false).writeStatus, "committed");
    assert.equal(
      answer({ effect: "unverifiable", ax_changed: false }, false).writeStatus,
      "may_have_applied",
    );
  });
});

describe("a script is marked may-have-acted only when its call log shows input", () => {
  const read = (tool: string) => ({
    tool,
    ok: true,
    effect: null,
    code: null,
    driver_calls: [{ tool, ok: true, effect: null }],
  });
  const script = (calls: ReadonlyArray<unknown>, isError = false) =>
    reply({ ok: !isError, driver_calls: calls.length, calls }, isError);
  const safety = (line: string) =>
    parsed(markUnverified("run_script", line)).result.structuredContent.safety;

  it("a logged menu_bar_extras call names no operation, so it may have acted", () => {
    const extras = { ...read("menu_bar_extras") };
    assert.deepInclude(safety(script([extras])), { possibleCommit: true });
  });

  it("a script that made no driver call, or only reads, sent nothing", () => {
    for (const calls of [[], [read("list_windows"), read("get_window_state")]]) {
      assert.deepInclude(safety(script(calls)), { possibleCommit: false });
      assert.deepInclude(safety(script(calls, true)), { possibleCommit: false });
    }
  });

  it("an input call, a cut-off call or a log with omitted driver calls may have acted", () => {
    const click = {
      tool: "click",
      ok: true,
      effect: "unverifiable",
      driver_calls: [{ tool: "get_window_state" }, { tool: "click", effect: "unverifiable" }],
    };
    const timedOut = { op: "click", ok: false, code: "timeout", driver_calls: [] };
    const omitted = { ...read("get_window_state"), driver_calls_omitted: 3 };
    for (const calls of [[read("list_windows"), click], [timedOut], [omitted]])
      assert.deepInclude(safety(script(calls)), {
        possibleCommit: true,
        writeStatus: "may_have_applied",
      });
    // Without a call log GOAT cannot tell what ran.
    assert.deepInclude(safety(reply({ ok: true }, false)), { possibleCommit: true });
  });
});

describe("a stalled native capture is read from the driver's error, never from window text", () => {
  const stall =
    "capture_backend_stalled: 2 earlier native captures never completed, so native capture is off for this driver process; restart the driver";
  const line = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });
  it("a window that only shows the word is no stall", () => {
    const shown = { type: "text", text: '- [4] AXStaticText "capture_backend_stalled"' };
    assert.isFalse(
      captureStalled(line({ content: [shown], structuredContent: { tree_markdown: shown.text } })),
    );
    // An error that quotes window text is not the driver's stall message either.
    assert.isFalse(
      captureStalled(
        line({
          isError: true,
          content: [{ type: "text", text: "AX error near capture_backend_stalled" }],
        }),
      ),
    );
  });
  it("the driver's stall message or code is a stall", () => {
    assert.isTrue(
      captureStalled(line({ isError: true, content: [{ type: "text", text: stall }] })),
    );
    assert.isTrue(
      captureStalled(
        line({
          isError: true,
          content: [],
          structuredContent: { code: "px_capture_unavailable", reason: stall },
        }),
      ),
    );
    assert.isTrue(
      captureStalled(
        JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: stall } }),
      ),
    );
  });
});

describe("a helper that ends on its own is named by its exit code", () => {
  const exiting = (code: number | undefined) =>
    driverExitReason({
      send: () => Effect.void,
      lines: undefined as never,
      kill: Effect.void,
      exitCode: Effect.succeed(code),
    });
  it.effect("parent refusal (77) and the helper's other typed refusals do not say restart", () =>
    Effect.gen(function* () {
      assert.equal(yield* exiting(77), "helper_refused");
      for (const code of [64, 78, 79]) assert.equal(yield* exiting(code), "helper_unsupported");
      assert.equal(yield* exiting(0), "helper_restarted");
      assert.equal(yield* exiting(137), "helper_restarted");
      assert.equal(yield* exiting(undefined), "helper_restarted");
    }),
  );
});

describe("menu_bar_extras reads only when it finds SystemUIServer or lists status items", () => {
  const failed = reply({ code: "tool_call_failed" });
  it("system and list failures are reads; open, click and close may have acted", () => {
    for (const operation of ["system", "list"]) {
      const safety = driverOutcomeSafety("menu_bar_extras", parsed(failed), { operation });
      assert.deepInclude(safety, { possibleCommit: false, writeStatus: "not_applicable" });
      const marked = parsed(markUnverified("menu_bar_extras", failed, { operation }));
      assert.isUndefined(marked.result.structuredContent.effect);
      assert.deepInclude(marked.result.structuredContent.safety, { possibleCommit: false });
    }
    for (const args of [
      { operation: "open" },
      { operation: "click" },
      { operation: "close" },
      {},
    ]) {
      assert.isTrue(driverOutcomeSafety("menu_bar_extras", parsed(failed), args).possibleCommit);
      const marked = parsed(markUnverified("menu_bar_extras", failed, args));
      assert.equal(marked.result.structuredContent.effect, "unverifiable");
    }
  });
});

describe("a reply already marked as possibly committed keeps that mark", () => {
  it("a write's earlier possibleCommit survives a code that reads as a refusal; a read's does not", () => {
    const line = reply({ code: "unknown_tool", safety: { possibleCommit: true } });
    const write = parsed(markUnverified("select_text", line)).result.structuredContent.safety;
    assert.deepInclude(write, { possibleCommit: true, writeStatus: "may_have_applied" });
    const read = parsed(markUnverified("menu_bar_extras", line, { operation: "list" })).result
      .structuredContent.safety;
    assert.deepInclude(read, { possibleCommit: false });
    // Without an earlier mark, an unknown tool was refused before anything ran.
    const fresh = parsed(markUnverified("select_text", reply({ code: "unknown_tool" }))).result
      .structuredContent.safety;
    assert.deepInclude(fresh, { possibleCommit: false });
  });
});

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { computerUseRefusalReason } from "@goat/contracts";
import { markUnverified } from "../cua/ComputerUseDriverOutcome.ts";
import { context, DriverError, fixture, UnknownOutcome } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const field = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s1",
  elements_complete: true,
  tree_markdown: '- [0] AXWindow "Notes"\n  - [1] AXTextField "Name" = "hello world"',
  elements: [
    { role: "AXWindow", depth: 0, element_index: 0, element_token: "s1:0", label: "Notes" },
    {
      role: "AXTextField",
      depth: 1,
      element_index: 1,
      element_token: "s1:1",
      label: "Name",
      value: "hello world",
    },
  ],
};

const run = (selectText: unknown, call: string) => {
  const base = fixture({ get_window_state: field, select_text: selectText });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({ bundle_id: 'org.example.Editor', window_id: 7 });
        await app.observe();
        screen.debug = true;
        try { return { done: await ${call} }; }
        catch (e) { return { caught: { code: e.code, nothingSent: e.nothingSent, message: e.message, detail: e.detail, possibleCommit: e.safety?.possibleCommit } }; }`,
    });
    return { result, sent: base.sent.filter((each) => each.tool === "select_text") };
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: base.host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
};

it.live(
  "app.selectText sends the bound window, the element's token, the text and its selection options",
  () =>
    Effect.gen(function* () {
      const { result, sent } = yield* run(
        {
          effect: "confirmed",
          selected_text: "world",
          selected_text_range: { location: 6, length: 5, units: "utf16" },
        },
        "app.selectText(1, 'world', { occurrence: 0, selection: 'text' })",
      );
      expect(sent.map((each) => each.args)).toEqual([
        {
          pid: 42,
          window_id: 7,
          element_token: "s1:1",
          text: "world",
          occurrence: 0,
          selection: "text",
        },
      ]);
      expect(result.value).toMatchObject({
        done: {
          ok: true,
          verdict: "confirmed",
          result: { debug: { value: { selected_text: "world" } } },
        },
      });
    }),
);

it.live("app.selectText with no text sends nothing", () =>
  Effect.gen(function* () {
    const { result, sent } = yield* run({ effect: "confirmed" }, "app.selectText(1, '')");
    expect(result.value).toMatchObject({ caught: { code: "invalid_argument", nothingSent: true } });
    expect(sent).toEqual([]);
  }),
);

it.live.each([
  ["a misspelled option", "{ selecton: 'cursor_after' }"],
  ["a window override", "{ pid: 999 }"],
])("app.selectText refuses %s and sends nothing", ([, options]) =>
  Effect.gen(function* () {
    const { result, sent } = yield* run(
      { effect: "confirmed" },
      `app.selectText(1, 'world', ${options})`,
    );
    expect(result.value).toMatchObject({ caught: { code: "invalid_argument", nothingSent: true } });
    expect(sent).toEqual([]);
  }),
);

it.live("app.selectText called with one object refuses a misspelled option and sends nothing", () =>
  Effect.gen(function* () {
    const { result, sent } = yield* run(
      { effect: "confirmed" },
      "app.selectText({ elementRef: {}, text: 'world', selecton: 'cursor_after' })",
    );
    expect(result.value).toMatchObject({ caught: { code: "invalid_argument", nothingSent: true } });
    expect((result.value as { caught: { message: string } }).caught.message).toContain("selecton");
    expect(sent).toEqual([]);
  }),
);

const unavailable = {
  "goat.10 (no reviewed risk class)": new DriverError(
    { code: "permission_denied", safety: { possibleCommit: false } },
    "tool 'select_text' has no reviewed risk classification",
  ),
  "manifest without the tool": new DriverError(
    {
      code: "permission_denied",
      refused: computerUseRefusalReason("outside_manifest"),
      detail: "outside_manifest",
      safety: { possibleCommit: false },
    },
    "tool 'select_text' is outside the capability manifest",
  ),
  "registry without the tool": new DriverError(
    { code: "unknown_tool" },
    "Unknown tool: select_text",
  ),
};

it.live.each(Object.entries(unavailable))(
  "app.selectText on a %s answers unsupported with nothing sent",
  ([, answer]) =>
    Effect.gen(function* () {
      const { result } = yield* run(answer, "app.selectText(1, 'world')");
      expect(result.value).toMatchObject({ caught: { code: "unsupported", nothingSent: true } });
      expect((result.value as { caught: { message: string } }).caught.message).toContain(
        "setValue",
      );
    }),
);

it.live("a missing macOS grant stays permission_denied with the driver's words", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      new DriverError({ code: "permission_denied" }, "Accessibility access is not granted."),
      "app.selectText(1, 'world')",
    );
    expect(result.value).toMatchObject({
      caught: {
        code: "permission_denied",
        nothingSent: true,
        message: "Accessibility access is not granted.",
      },
    });
  }),
);

it.live("an answer that may have changed the selection is never called unsupported", () =>
  Effect.gen(function* () {
    for (const structured of [
      { code: "selection_readback_failed", effect: "unverifiable" },
      { code: "tool_call_timeout", status: "refused", safety: { possibleCommit: true } },
      { code: "unknown_tool", safety: { possibleCommit: true } },
    ]) {
      const { result } = yield* run(
        new DriverError(structured, "Unknown tool: select_text"),
        "app.selectText(1, 'world')",
      );
      expect(result.value).toMatchObject({
        caught: { code: "unknown_outcome", nothingSent: false, possibleCommit: true },
      });
    }
    // Cut off after it reached the driver, whatever the reply's own code says.
    const { result } = yield* run(
      new UnknownOutcome({ code: "unknown_tool" }, "Unknown tool: select_text"),
      "app.selectText(1, 'world')",
    );
    expect(result.value).toMatchObject({
      caught: { code: "unknown_outcome", nothingSent: false, possibleCommit: true },
    });
    // The same reply as the lease proxy forwards it, after its own outcome marking.
    const proxied = JSON.parse(
      markUnverified(
        "select_text",
        JSON.stringify({
          result: {
            isError: true,
            content: [{ type: "text", text: "Unknown tool: select_text" }],
            structuredContent: { code: "unknown_tool", safety: { possibleCommit: true } },
          },
        }),
      ),
    ).result.structuredContent;
    const marked = yield* run(
      new DriverError(proxied, "Unknown tool: select_text"),
      "app.selectText(1, 'world')",
    );
    expect(marked.result.value).toMatchObject({
      caught: { code: "unknown_outcome", nothingSent: false, possibleCommit: true },
    });
  }),
);

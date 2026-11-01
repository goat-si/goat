import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { computerUseRefusalReason } from "@goat/contracts";
import { context, DriverError, fixture, NotStarted } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const run = (overrides: Record<string, unknown>, source: string) => {
  const base = fixture(overrides);
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source,
    });
    return { result, sent: base.sent };
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

const caught = (call: string) => `let caught;
  try { return { value: await ${call} }; }
  catch (e) { caught = { code: e.code, nothingSent: e.nothingSent, detail: e.detail, message: e.message, possibleCommit: e.safety?.possibleCommit }; }
  return { caught };`;

// What a driver without the tool, or a manifest that leaves it out, answers before running it.
const unavailable = {
  "goat.10 (no reviewed risk class)": new DriverError(
    { code: "permission_denied", safety: { possibleCommit: false } },
    "tool 'menu_bar_extras' has no reviewed risk classification",
  ),
  "manifest without the tool": new DriverError(
    {
      code: "permission_denied",
      refused: computerUseRefusalReason("outside_manifest"),
      detail: "outside_manifest",
      safety: { possibleCommit: false },
    },
    "tool 'menu_bar_extras' is outside the capability manifest",
  ),
  "registry without the tool": new DriverError(
    { code: "unknown_tool" },
    "Unknown tool: menu_bar_extras",
  ),
};

it.live.each(Object.entries(unavailable))(
  "screen.menuBarExtras() on a %s answers unsupported with nothing sent",
  ([, answer]) =>
    Effect.gen(function* () {
      const { result, sent } = yield* run(
        { menu_bar_extras: answer },
        caught("screen.menuBarExtras()"),
      );
      expect(result.value).toMatchObject({ caught: { code: "unsupported", nothingSent: true } });
      expect((result.value as { caught: { message: string } }).caught.message).toContain(
        "screen.app()",
      );
      expect(sent.map((each) => each.args)).toEqual([{ operation: "system" }]);
    }),
);

it.live("screen.menuBarExtras() finds SystemUIServer and lists its status items", () =>
  Effect.gen(function* () {
    const { result, sent } = yield* run(
      {
        menu_bar_extras: (args: { operation: string }) =>
          args.operation === "system"
            ? { system_ui_server_pid: 333 }
            : { items: [{ title: "Wi-Fi", owner_pid: 333 }] },
      },
      "return await screen.menuBarExtras();",
    );
    expect(result.value).toEqual({ host_pid: 333, items: [{ title: "Wi-Fi", owner_pid: 333 }] });
    expect(sent.map((each) => [each.tool, each.args])).toEqual([
      ["menu_bar_extras", { operation: "system" }],
      ["menu_bar_extras", { operation: "list", pid: 333 }],
    ]);
  }),
);

it.live("an approved pid lists that app's status items without asking for SystemUIServer", () =>
  Effect.gen(function* () {
    const { result, sent } = yield* run(
      { menu_bar_extras: { items: [] } },
      "return await screen.menuBarExtras({ pid: 42, owner_pid: 42, operation: 'click', item: 'Quit' });",
    );
    expect(result.value).toEqual({ host_pid: 42, items: [] });
    expect(sent.map((each) => each.args)).toEqual([{ operation: "list", pid: 42, owner_pid: 42 }]);
  }),
);

it.live(
  "GOAT's own refusal at either step stays a refusal with its reason, never unsupported",
  () =>
    Effect.gen(function* () {
      const refused = (detail: "desktop_not_approved" | "app_not_approved") =>
        new NotStarted(
          { effect: "refused", refused: computerUseRefusalReason(detail), detail },
          "This thread may control only its approved apps.",
        );
      const atSystem = yield* run(
        { menu_bar_extras: refused("desktop_not_approved") },
        caught("screen.menuBarExtras()"),
      );
      expect(atSystem.result.value).toMatchObject({
        caught: { code: "unavailable", detail: "desktop_not_approved", nothingSent: true },
      });
      const atList = yield* run(
        { menu_bar_extras: refused("app_not_approved") },
        caught("screen.menuBarExtras({ pid: 900 })"),
      );
      expect(atList.result.value).toMatchObject({
        caught: { code: "unavailable", detail: "app_not_approved", nothingSent: true },
      });
    }),
);

it.live("a list cut off by a timeout is a read: it changed nothing", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        menu_bar_extras: new DriverError(
          { code: "tool_call_timeout", effect: "unverifiable" },
          "Unknown tool: menu_bar_extras",
        ),
      },
      caught("screen.menuBarExtras({ pid: 42 })"),
    );
    const failure = (result.value as { caught: { code: string; possibleCommit?: boolean } }).caught;
    expect(failure.code).not.toBe("unsupported");
    expect(failure.possibleCommit).toBe(false);
  }),
);

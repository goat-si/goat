import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenHostCall, ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import {
  NotStarted,
  call,
  context,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

it.live("verifyState advances the baseline and cannot imply a no-op for earlier input", () => {
  let reads = 0;
  const { host } = fixture({
    click: { effect: "unverifiable" },
    get_window_state: (args: Record<string, unknown>) => {
      const snapshot = `s${++reads}`;
      const old = goat2WindowState(args);
      const full = {
        ...old,
        snapshot_id: snapshot,
        elements:
          "elements" in old
            ? old.elements?.map((item) => ({
                ...item,
                element_token: `${snapshot}:${item.element_index}`,
              }))
            : undefined,
      };
      if (args.since === undefined) return full;
      const { tree_markdown: _tree, ...diff } = full;
      return { ...diff, since_status: "no_change", tree_diff: `no change since ${args.since}` };
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7}); await app.observe(); await app.click(1); const verified = await app.verifyState(); return await app.observe({mode:'diff', baseObservationId:verified.observationId});`,
    });
    expect(result.value).toMatchObject({ mode: "diff" });
    expect(result.value).not.toHaveProperty("effect");
    expect(
      result.journal.find((entry) => entry.receipt.method === "click")?.receipt.observedEffect,
    ).toBeUndefined();
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live.each(["batch", "refused"] as const)(
  "%s input keeps accurate observation receipts",
  (scenario) => {
    let reads = 0;
    const { host, sent } = fixture({
      click:
        scenario === "refused"
          ? new NotStarted({ refused: "targetRefused", detail: "target_busy" })
          : { effect: "unverifiable" },
      get_window_state: (args: Record<string, unknown>) => {
        const snapshot = `s${++reads}`;
        const old = goat2WindowState(args);
        const full = {
          ...old,
          snapshot_id: snapshot,
          tree_markdown:
            '- [0] AXWindow "Document"\n- [1] AXButton "Apply"\n- [2] AXButton "Other"',
          elements:
            "elements" in old
              ? [
                  ...(old.elements ?? []).map((item) => ({
                    ...item,
                    element_token: `${snapshot}:${item.element_index}`,
                  })),
                  {
                    element_index: 2,
                    element_token: `${snapshot}:2`,
                    role: "AXButton",
                    label: "Other",
                  },
                ]
              : undefined,
        };
        if (args.since === undefined) return full;
        const { tree_markdown: _tree, ...diff } = full;
        return { ...diff, since_status: "diff", tree_diff: '~ AXStaticText = "8"' };
      },
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7}); await app.observe(); ${scenario === "batch" ? "await Promise.all([app.click(1), app.click(2)]);" : "try { await app.click(1); } catch (e) { if (!e.nothingSent) throw e; }"} return await app.observe();`,
      });
      const clicks = result.journal.filter((entry) => entry.receipt.method === "click");
      if (scenario === "batch") {
        expect(clicks).toHaveLength(2);
        expect(clicks.map((entry) => entry.receipt.observedEffect)).toEqual(
          Array.from({ length: 2 }, () => ({
            state: "change_seen",
            rows: ['~ AXStaticText = "8"'],
          })),
        );
        expect(result.value).toMatchObject({
          effect: 'after 2 inputs: changed (~ AXStaticText = "8")',
        });
        expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
      } else {
        expect(clicks).toHaveLength(1);
        expect(clicks[0]?.receipt).toMatchObject({ category: "refused", dispatched: false });
        expect(clicks[0]?.receipt.observedEffect).toBeUndefined();
        expect(result.value).not.toHaveProperty("effect");
      }
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

type Host = ReturnType<typeof fixture>["host"];

/** A KakaoTalk-like window: a sidebar, the open screen's heading and its list rows. */
const sidebarRead = (snapshot: string, heading: string, rows: readonly string[]) => {
  const labels = ["KakaoTalk", "friends", "chatrooms", heading, ...rows];
  const roles = ["AXWindow", "AXButton", "AXButton", "AXStaticText", ...rows.map(() => "AXRow")];
  return {
    pid: 42,
    window_id: 7,
    snapshot_id: snapshot,
    elements_complete: true,
    tree_markdown: labels
      .map((label, index) => `${index === 0 ? "" : "  "}- [${index}] ${roles[index]} "${label}"`)
      .join("\n"),
    elements: labels.map((label, index) => ({
      role: roles[index],
      element_index: index,
      element_token: `${snapshot}:${index}`,
      label,
      ...(roles[index] === "AXButton" ? { actions: ["AXPress"] } : {}),
    })),
  };
};

/** One input with the test clock moved past the settle its evidence read waits for. */
const settled = (host: Host, input: ScreenHostCall) =>
  Effect.gen(function* () {
    const fiber = yield* host.invoke(input, context).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    return yield* Fiber.join(fiber);
  });

const sidebarClick = (after: ReturnType<typeof sidebarRead>, observeFirst = true) =>
  Effect.gen(function* () {
    let reads = 0;
    const { host, sent } = fixture({
      click: { effect: "suspected_noop" },
      get_window_state: () =>
        reads++ === 0 ? sidebarRead("s1", "Friends", ["Kim", "Lee"]) : after,
    });
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const seen = observeFirst
      ? ((yield* host.observe(call("get_window_state", {}, ref), context))
          .value as ScreenObservation)
      : undefined;
    const chats = seen?.elements.find((element) => element.name === "chatrooms");
    const out = yield* settled(host, {
      ...call("click", chats ? { elementRef: chats.ref } : { x: 10, y: 10 }, ref),
      deadlineMillis: 10_000,
    });
    return { out, reads: sent.filter((each) => each.tool === "get_window_state").length };
  });

it.effect(
  "a sidebar switch the driver calls suspected_noop is confirmed by the bound window's tree diff",
  () =>
    Effect.gen(function* () {
      const { out, reads } = yield* sidebarClick(
        sidebarRead("s2", "Chats", ["Team room", "Family"]),
      );
      expect(out.category).toBe("confirmed");
      expect(out.evidence?.some((line) => line.startsWith("observed:tree_changed:"))).toBe(true);
      expect(out.safety?.writeStatus).not.toBe("not_applied");
      expect(reads).toBe(2);
    }),
);

it.effect(
  "a suspected_noop stays one when the tree did not change or no read came before the input",
  () =>
    Effect.gen(function* () {
      const unchanged = yield* sidebarClick(sidebarRead("s2", "Friends", ["Kim", "Lee"]));
      expect(unchanged.out.category).toBe("suspected_noop");
      expect(unchanged.reads).toBe(2);
      // Without a read before the input there is nothing to compare, so nothing is read after it.
      const unread = yield* sidebarClick(sidebarRead("s2", "Chats", ["Team room"]), false);
      expect(unread.out.category).toBe("suspected_noop");
      expect(unread.reads).toBe(0);
    }),
);

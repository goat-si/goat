import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import type { StrictInputGuards } from "./ScreenStrictGuards.ts";
import { context, fixture } from "./DesktopTargetHost.testkit.ts";

const cellService = (
  host: ReturnType<typeof fixture>["host"],
  strictInputGuards: StrictInputGuards,
) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    desktopHost: host,
    strictInputGuards,
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer));

const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
const runCell = (source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({ ...turn, invocation: context.invocation, source });
  });

const BIND =
  "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe();";
const settledOf = (expression: string) =>
  `${BIND} const settled = await Promise.allSettled(${expression}); return settled.map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code);`;

/** The first click is delivered but its effect is not seen; the second is an ordinary click. */
const noopThenClick = (strict: boolean) => {
  let clicked = 0;
  const holder = { value: strict };
  const made = fixture(
    {
      click: () =>
        ++clicked === 1
          ? { effect: "suspected_noop", evidence: ["driver:no_change"] }
          : { effect: "confirmed", evidence: ["driver:acted"] },
    },
    undefined,
    undefined,
    undefined,
    "darwin",
    undefined,
    () => holder.value,
  );
  return { ...made, holder };
};

it.live(
  "without strict guards a suspected_noop click does not stop the next click in its group",
  () => {
    const { host, sent, holder } = noopThenClick(false);
    return Effect.gen(function* () {
      const result = yield* runCell(settledOf("[app.click('Apply'), app.click('Apply')]"));
      expect(result.value).toEqual(["suspected_noop", "confirmed"]);
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
    }).pipe(Effect.provide(cellService(host, holder)));
  },
);

it.live("strict guards still stop a group after a suspected_noop click", () => {
  const { host, sent, holder } = noopThenClick(true);
  return Effect.gen(function* () {
    const result = yield* runCell(settledOf("[app.click('Apply'), app.click('Apply')]"));
    expect(result.value).toEqual(["suspected_noop", "not_run"]);
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
  }).pipe(Effect.provide(cellService(host, holder)));
});

/** A partial click may have landed; the next click comes as a separate call. */
const partialThenClick = (strict: boolean) => {
  let clicked = 0;
  const holder = { value: strict };
  const made = fixture(
    {
      click: () =>
        ++clicked === 1
          ? { effect: "partial", evidence: ["driver:partial"] }
          : { effect: "confirmed", evidence: ["driver:acted"] },
    },
    undefined,
    undefined,
    undefined,
    "darwin",
    undefined,
    () => holder.value,
  );
  return { ...made, holder };
};
const SEQUENTIAL = `${BIND} const first = await app.click('Apply').then((r) => r.verdict, (e) => e.code); const second = await app.click('Apply').then((r) => r.verdict, (e) => e.code); return [first, second];`;

it.live(
  "without strict guards a click that may have landed does not stop the cell's next input",
  () => {
    const { host, sent, holder } = partialThenClick(false);
    return Effect.gen(function* () {
      const result = yield* runCell(SEQUENTIAL);
      expect(result.value).toEqual(["unknown_outcome", "confirmed"]);
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
    }).pipe(Effect.provide(cellService(host, holder)));
  },
);

it.live("strict guards stop the cell's next input after a click that may have landed", () => {
  const { host, sent, holder } = partialThenClick(true);
  return Effect.gen(function* () {
    const result = yield* runCell(SEQUENTIAL);
    expect(result.value).toEqual(["unknown_outcome", "not_run"]);
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
  }).pipe(Effect.provide(cellService(host, holder)));
});

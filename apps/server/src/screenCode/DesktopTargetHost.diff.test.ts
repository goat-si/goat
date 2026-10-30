import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

type Observed = {
  observationId: string;
  mode: string;
  indexedText: string;
  snapshot?: string;
  elements: Array<{ name: string; ref: ScreenElementRef }>;
};
const refAt = (observed: Observed, index: number) => {
  const ref = observed.elements[index]?.ref;
  if (!ref) throw new Error(`The observation must have element ${index}`);
  return ref;
};

it.effect("desktop observations use driver diffs and refresh unchanged row tokens", () =>
  Effect.gen(function* () {
    let status = "diff";
    let reads = 0;
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => {
        reads++;
        const snapshot = `s${reads}`;
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
        if (status === "unknown_snapshot") return { ...full, since_status: status };
        const { tree_markdown: _tree, ...diff } = full;
        return {
          ...diff,
          since_status: status,
          tree_diff: status === "diff" ? '~ [1] AXButton "Apply"' : `no change since ${args.since}`,
        };
      },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observe = (args: Record<string, string>) =>
      host
        .observe(call("get_accessibility_tree", args, ref), context)
        .pipe(Effect.map((result) => result.value as Observed));
    const full = yield* observe({});
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    expect(full.snapshot).toBe("s1");
    const diff = yield* observe({ mode: "diff", baseObservationId: full.observationId });
    expect(sent.at(-1)?.args).toMatchObject({ since: "s1", tree_format: "both" });
    expect(diff).toMatchObject({ mode: "diff", indexedText: '~ [1] AXButton "Apply"' });
    yield* host.invoke(call("click", { elementRef: refAt(diff, 1) }, ref), context);
    expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s2:1" } });
    status = "no_change";
    const unchanged = yield* observe({ mode: "diff", baseObservationId: diff.observationId });
    expect(unchanged).toMatchObject({ mode: "diff", indexedText: "no change since s2" });
    status = "unknown_snapshot";
    const before = reads;
    const fallback = yield* observe({ mode: "diff", baseObservationId: unchanged.observationId });
    expect(reads).toBe(before + 1);
    expect(fallback).toMatchObject({ mode: "full", resetReason: "full read: snapshot expired" });
    const nextCell = { ...context, cellId: "next" };
    yield* host.observe({ ...call("get_accessibility_tree", {}, ref), cellId: "next" }, nextCell);
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    const retired = yield* host
      .invoke(call("click", { elementRef: refAt(full, 1) }, ref), context)
      .pipe(Effect.result);
    expect(retired._tag === "Failure" && retired.failure.code).toBe("stale_reference");
  }),
);

it.effect("a diff after a filtered observation reads the whole window", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => goat2WindowState(args),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const filtered = (yield* host.observe(
      call("get_accessibility_tree", { mode: "query", query: { name: "Apply" } }, ref),
      context,
    )).value as Observed;
    const next = (yield* host.observe(
      call(
        "get_accessibility_tree",
        { mode: "diff", baseObservationId: filtered.observationId },
        ref,
      ),
      context,
    )).value as Observed;
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    expect(next).toMatchObject({ mode: "full", resetReason: "full read: scope changed" });
  }),
);

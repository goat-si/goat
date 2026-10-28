import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BATCH_SCOPE_UNSUPPORTED } from "./ComputerUseLeaseProxyBatch.ts";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const window = { pid: 42, window_id: 1 };
const steps = [{ tool: "click", args: { ...window, element_token: "s1:3" } }];
const scope = (apps: ReadonlyArray<string>, delivery?: string) => ({
  apps,
  ...(delivery === undefined ? {} : { delivery }),
});
/** A tools/list answer whose run_steps and run_script do or do not take an app_scope. */
const toolList = (appScope: boolean) => ({
  tools: ["run_steps", "run_script"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: appScope ? { steps: {}, app_scope: { type: "object" } } : { steps: {} },
    },
  })),
});

const listedTools = Effect.fn(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  appScope: boolean,
) {
  const probe = yield* h.nextToDriver;
  assert.equal(probe.method, "tools/list");
  yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: probe.id, result: toolList(appScope) }));
});

const refusalOf = (answer: Record<string, unknown>) =>
  (answer.result as { structuredContent: Record<string, unknown> }).structuredContent;

it.effect(
  "admits a background batch kept to approved apps while another thread holds the screen, and scopes one that names none",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      // No foreground approval, and another thread holds apps on this screen.
      yield* h.push({ ...active(undefined, ["com.apple.calculator"]), shared: true });
      yield* h.send(
        call(1, "run_steps", { ...window, steps, app_scope: scope(["com.apple.calculator"]) }),
      );
      // The proxy asks the child whether its run_steps keeps an app_scope before sending one.
      yield* listedTools(h, true);
      const sent = yield* h.nextToDriver;
      assert.equal(sent.id, 1);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 1);

      // Without a scope, the batch gets the grant's apps, kept to the background.
      yield* h.send(call(2, "run_script", { script: "click()" }));
      const scoped = yield* h.nextToDriver;
      assert.equal(scoped.id, 2);
      assert.deepEqual((scoped.params as { arguments: unknown }).arguments, {
        script: "click()",
        app_scope: scope(["com.apple.calculator"], "background"),
      });
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 2);

      // A scope naming another app, or allowing the foreground on a shared screen, does not run.
      yield* h.send(
        call(3, "run_steps", { ...window, steps, app_scope: scope(["com.apple.Terminal"]) }),
      );
      assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "desktop_not_approved" });
      yield* h.send(
        call(4, "run_steps", {
          ...window,
          steps,
          app_scope: scope(["com.apple.calculator"], "foreground"),
        }),
      );
      assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "screen_shared" });
      assert.equal(yield* h.driverQueued, 0);
    }),
);

it.effect(
  "refuses an app_scope a driver's run_steps does not take, and keeps unscoped batches refused under a list",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active(undefined, ["com.apple.calculator"]));
      yield* h.send(
        call(1, "run_steps", { ...window, steps, app_scope: scope(["com.apple.calculator"]) }),
      );
      yield* listedTools(h, false);
      const refused = yield* h.nextToProvider;
      assert.equal(refused.id, 1);
      assert.deepInclude(refusalOf(refused), { detail: "outside_manifest" });
      assert.include(
        (refused.result as { content: ReadonlyArray<{ text: string }> }).content[0]?.text,
        BATCH_SCOPE_UNSUPPORTED,
      );
      // That driver could run a scope it does not know unscoped, so nothing is added either.
      yield* h.send(call(2, "run_script", { script: "click()" }));
      assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "desktop_not_approved" });
      assert.equal(yield* h.driverQueued, 0);
    }),
);

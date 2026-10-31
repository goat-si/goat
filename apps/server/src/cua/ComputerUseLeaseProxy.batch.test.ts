import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { narrowBatch } from "./ComputerUseBatchIdentity.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";
import { BATCH_SCOPE_UNSUPPORTED } from "./ComputerUseLeaseProxyBatch.ts";
import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

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

const listedApps = Effect.fn(function* (h: Effect.Success<ReturnType<typeof harness>>) {
  const probe = yield* h.nextToDriver;
  assert.deepEqual(probe.params, { name: "list_apps", arguments: {} });
  yield* h.reply(
    JSON.stringify({
      jsonrpc: "2.0",
      id: probe.id,
      result: {
        structuredContent: {
          apps: [{ pid: 42, bundle_id: "com.apple.calculator", name: "Calculator" }],
        },
      },
    }),
  );
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
      yield* listedApps(h);
      const sent = yield* h.nextToDriver;
      assert.equal(sent.id, 1);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 1);

      // Without a scope, the batch gets the grant's apps, kept to the background.
      yield* h.send(call(2, "run_steps", { ...window, steps }));
      const scoped = yield* h.nextToDriver;
      assert.equal(scoped.id, 2);
      assert.deepEqual((scoped.params as { arguments: unknown }).arguments, {
        ...window,
        steps,
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
      // A script can launch a scoped app, which takes the screen, whatever its scope says.
      yield* h.send(
        call(5, "run_script", { script: "click()", app_scope: scope(["com.apple.calculator"]) }),
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
      assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "app_not_allowed" });
      assert.equal(yield* h.driverQueued, 0);
    }),
);

it.effect("asks a replacement driver child again before it gets a scoped batch", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const apps = active(undefined, ["com.apple.calculator"]);
    yield* h.push(apps);
    const scoped = (id: number) =>
      call(id, "run_steps", { ...window, steps, app_scope: scope(["com.apple.calculator"]) });
    yield* h.send(scoped(1));
    yield* listedTools(h, true);
    yield* listedApps(h);
    assert.equal((yield* h.nextToDriver).id, 1);
    yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    assert.equal((yield* h.nextToProvider).id, 1);

    yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
    yield* h.killed;
    yield* h.push(apps);
    yield* h.restarted;
    // The new child may be another install: its own tool list decides, here without app_scope.
    yield* h.send(scoped(2));
    yield* listedTools(h, false);
    const refused = yield* h.nextToProvider;
    assert.equal(refused.id, 2);
    assert.deepInclude(refusalOf(refused), { detail: "outside_manifest" });
    assert.equal(yield* h.driverQueued, 0);
  }),
);

it.effect("scopes an unscoped batch from the tool list the provider asked the same child for", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active(undefined, ["com.apple.calculator"]));
    yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    assert.equal((yield* h.nextToDriver).method, "tools/list");
    yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolList(true) }));
    assert.equal((yield* h.nextToProvider).id, 1);
    // No probe: that child already said its run_steps keeps an app_scope.
    yield* h.send(call(2, "run_steps", { ...window, steps }));
    yield* listedApps(h);
    const scoped = yield* h.nextToDriver;
    assert.equal(scoped.id, 2);
    assert.deepEqual((scoped.params as { arguments: unknown }).arguments, {
      ...window,
      steps,
      app_scope: scope(["com.apple.calculator"], "background"),
    });
  }),
);

it.effect("refreshes a cached executable alias when a denied app starts before a batch", () =>
  Effect.gen(function* () {
    const executable = "C:\\Shared\\host.exe";
    const h = yield* harness({
      reservation: (request) =>
        Effect.sync(() => {
          if (request.action !== "reserve") return { status: "released" } as const;
          const app = deniedCallApp(request, ["com.example.Blocked"]);
          return app === undefined
            ? ({ status: "admitted", reservationId: null } as const)
            : ({ status: "refused", detail: "app_not_allowed", app } as const);
        }),
    });
    yield* h.push(active());
    yield* h.send(call(10, "list_apps", {}));
    assert.equal((yield* h.nextToDriver).id, 10);
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        result: {
          structuredContent: {
            apps: [{ pid: 42, bundle_id: "com.example.Allowed", name: "Allowed", executable }],
          },
        },
      }),
    );
    yield* h.nextToProvider;
    yield* h.send(
      call(11, "run_steps", {
        app_scope: scope([executable]),
        steps: [{ tool: "click", args: { pid: 99, window_id: 7, x: 1, y: 1 } }],
      }),
    );
    yield* listedTools(h, true);
    const lookup = yield* h.nextToDriver;
    assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lookup.id,
        result: {
          structuredContent: {
            apps: [
              { pid: 42, bundle_id: "com.example.Allowed", name: "Allowed", executable },
              { pid: 99, bundle_id: "com.example.Blocked", name: "Blocked", executable },
            ],
          },
        },
      }),
    );
    assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "app_not_allowed" });
    assert.equal(yield* h.driverQueued, 0);
  }),
);

it.effect("narrows an executable alias to verified bundle identities before forwarding", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active());
    const executable = "/opt/shared/host";
    yield* h.send(call(1, "run_steps", { app_scope: scope([executable]), steps: [] }));
    yield* listedTools(h, true);
    const lookup = yield* h.nextToDriver;
    assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lookup.id,
        result: {
          structuredContent: {
            apps: [{ pid: 42, bundle_id: "com.example.Allowed", name: "Allowed", executable }],
          },
        },
      }),
    );
    const sent = yield* h.nextToDriver;
    assert.equal(sent.id, 1);
    assert.deepEqual(sent.params, {
      name: "run_steps",
      arguments: {
        app_scope: scope(["com.example.Allowed"], "background"),
        steps: [],
      },
    });
  }),
);

it("refuses alias scopes when the host cannot express bundle identities", () => {
  const executable = "C:\\Shared\\host.exe";
  const line = call(1, "run_steps", { app_scope: scope([executable]), steps: [] });
  const result = narrowBatch(
    1,
    line,
    parse(line) ?? {},
    new Map([[42, { id: executable, name: "Editor", executable }]]),
    false,
  );
  assert.include("refused" in result ? result.refused : "", "app_not_allowed");
});

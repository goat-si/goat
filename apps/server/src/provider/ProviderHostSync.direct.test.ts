import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Gate from "./ProviderCliGate.ts";
import * as HostSync from "./ProviderHostSync.ts";
import { harness, threadScope } from "./ProviderHostSync.testkit.ts";

const finished = {
  kind: "started",
  sync: {
    syncId: "remote-sync",
    driver: "opencode",
    version: null,
    login: false,
    startedAt: "2026-11-12T00:00:00.000Z",
    done: true,
    hosts: [{ host: null, phase: "installed", version: "1.2.3" }],
  },
};

const direct = (check: Effect.Effect<void, EnvironmentAuthorizationError>) =>
  ({ kind: "mcp", scope: threadScope, directInstall: check }) as const;

it.effect("a thread allowed to install directly starts the sync without an approval card", () =>
  Effect.gen(function* () {
    const { state, layer } = harness({ answer: () => Effect.succeed(finished) });
    const result = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(Effect.void),
      );
      if (started.kind === "started") yield* sync.awaitDone(started.sync.syncId);
      return started;
    }).pipe(Effect.provide(layer));
    expect(result.kind).toBe("started");
    expect(state.handoffs).toEqual([]);
    expect(state.calls[0]?.call).toMatchObject({
      host: "box",
      tool: "goat_provider_sync",
      providersManage: true,
      arguments: { driver: "opencode", login: false },
    });
  }),
);

it.effect("a direct install whose check fails before the send sends nothing", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const check = Ref.updateAndGet(checks, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 1
          ? Effect.void
          : Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "providers:manage",
                message: "The thread dropped to approvals.",
              }),
            ),
      ),
    );
    const { state, layer } = harness({ answer: () => Effect.succeed(finished) });
    const done = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(check),
      );
      return started.kind === "started" ? yield* sync.awaitDone(started.sync.syncId) : undefined;
    }).pipe(Effect.provide(layer));
    expect(state.calls).toEqual([]);
    expect(done?.hosts[0]).toMatchObject({
      phase: "failed",
      message: "The thread dropped to approvals.",
    });
  }),
);

const opencode = ProviderInstanceId.make("opencode");
const pending = {
  instanceId: opencode,
  driver: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

/** Each probe answers the next entry; a fresh probe is recorded. */
const gate = (answers: ReadonlyArray<Gate.CliAnswer>, fresh: Array<boolean>) =>
  Effect.map(Ref.make<ReadonlyArray<Gate.CliAnswer>>(answers), (queue) =>
    Layer.succeed(
      Gate.ProviderCliGate,
      Gate.ProviderCliGate.of({
        require: () => Effect.void,
        missing: () => Effect.void.pipe(Effect.as(undefined)),
        probe: (_instanceId, options) =>
          Effect.sync(() => fresh.push(options?.fresh === true)).pipe(
            Effect.andThen(
              Ref.modify(queue, (all): readonly [Gate.CliAnswer, ReadonlyArray<Gate.CliAnswer>] => [
                all[0] ?? { kind: "unknown" },
                all.slice(1),
              ]),
            ),
          ),
      }),
    ),
  );

const installLocally = (cliGate: Layer.Layer<Gate.ProviderCliGate>) =>
  Effect.gen(function* () {
    const { state, layer } = harness({
      providers: [pending],
      instances: [{ instanceId: opencode, driverKind: "opencode" }],
      cliGate,
    });
    const done = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", version: "1.2.3", login: false },
        { kind: "client", sessionId: "person" as never },
      );
      return started.kind === "started" ? yield* sync.awaitDone(started.sync.syncId) : undefined;
    }).pipe(Effect.provide(layer));
    return { state, host: done?.hosts[0] };
  });

it.effect("a CLI its probe finds missing is installed even when the snapshot says installed", () =>
  Effect.gen(function* () {
    const fresh: Array<boolean> = [];
    const missing = { kind: "missing", provider: { ...pending, cli: "missing" } } as const;
    const present = {
      kind: "present",
      provider: { ...pending, cli: "present", version: "1.2.3" },
    } as const;
    const { state, host } = yield* installLocally(yield* gate([missing, present], fresh));
    expect(state.spawned.map((child) => child.args.join(" "))).toEqual([
      "install -g opencode-ai@1.2.3",
    ]);
    // The answer after installing comes from a probe that started after the installer.
    expect(fresh).toEqual([false, true]);
    expect(host).toMatchObject({
      phase: "installed",
      version: "1.2.3",
      ran: "npm install -g opencode-ai@1.2.3",
      login: { type: "terminal", command: "opencode auth login" },
    });
  }),
);

it.effect(
  "an install GOAT cannot confirm afterwards is reported as unconfirmed, not installed",
  () =>
    Effect.gen(function* () {
      const missing = { kind: "missing", provider: { ...pending, cli: "missing" } } as const;
      const { host } = yield* installLocally(yield* gate([missing, { kind: "unknown" }], []));
      expect(host).toMatchObject({
        phase: "failed",
        message: "Installed, but GOAT could not confirm opencode runs here.",
      });
    }),
);

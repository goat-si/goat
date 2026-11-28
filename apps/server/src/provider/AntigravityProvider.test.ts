import { expect, it } from "@effect/vitest";
import {
  isProviderWorkspaceSnapshotPending,
  ProviderInstanceId,
  ProviderSetupError,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { buildAntigravityModelsFromSession } from "./AntigravityProvider.ts";
import {
  commands,
  expectedCommands,
  initializeResult,
  layerTest,
  makeHarness,
  makeLayerTest,
  modelConfig,
  modelOptions,
  sessionSetupResult,
  started,
} from "./AntigravityProvider.testkit.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("antigravity-test");

it.layer(makeLayerTest(true))("Antigravity periodic checks", (it) => {
  it.effect("keeps a ready snapshot during a transient failed check and accepts sign-out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, "/workspace");
        const checked = yield* Deferred.make<void>();
        yield* Ref.set(
          harness.probe,
          Deferred.succeed(checked, undefined).pipe(
            Effect.andThen(
              Effect.fail(EffectAcpErrors.AcpRequestError.internalError("probe failed")),
            ),
          ),
        );
        yield* TestClock.adjust("5 minutes");
        yield* Deferred.await(checked);
        expect((yield* harness.provider.snapshot.getSnapshot).status).toBe("ready");
        yield* harness.provider.onSignedOut();
        yield* TestClock.adjust("30 seconds");
        expect((yield* harness.provider.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
      }),
    ),
  );
});

it.layer(layerTest)("Antigravity provider snapshots", (it) => {
  it.effect("does not probe or run helper safety checks while disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ enabled: false });
        const snapshot = yield* harness.provider.snapshot.refresh;
        expect(snapshot).toMatchObject({
          enabled: false,
          installed: false,
          status: "disabled",
          auth: { status: "unknown" },
          models: [],
          setup: { canAuthenticate: true, canInstall: true },
          showInteractionModeToggle: false,
          supportsConversationRollback: true,
          supportsTextGeneration: false,
        });
        expect(yield* Ref.get(harness.probeCalls)).toBe(0);
        expect(yield* Ref.get(harness.safetyCalls)).toBe(0);
      }),
    ),
  );
  it.effect("treats initialize as installation proof, not account or model discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const auth of [
          undefined,
          { type: "oauth-personal", label: "Google account" },
          { type: "oauth-business", label: "Gemini Enterprise" },
          { type: "gemini-api-key", label: "Gemini API key" },
          { type: "agent-platform", label: "Agent Platform" },
        ]) {
          const harness = yield* makeHarness(auth ? { auth } : {});
          expect(yield* harness.provider.snapshot.getSnapshot).toMatchObject({
            installed: false,
            status: "warning",
            auth: { status: "unknown" },
            models: [],
          });
          yield* harness.initialize;
          const snapshot = yield* harness.provider.snapshot.getSnapshot;
          expect(snapshot).toMatchObject({
            installed: true,
            status: "warning",
            version: "agy_acp_server_20260818_01_RC01",
            auth: { status: "unknown", ...(auth ? { type: auth.type } : {}) },
            message:
              auth?.type === "gemini-api-key" || auth?.type === "agent-platform"
                ? `Antigravity is installed. Connect with ${auth.label} to load models.`
                : "Antigravity is installed. Google account access is not checked yet.",
            models: [],
          });
          expect(yield* Ref.get(harness.probeCalls)).toBe(1);
        }
      }),
    ),
  );

  it.effect("offers Auto only while the session advertises it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const modes = harness.provider.snapshot.getSnapshot.pipe(
          Effect.map((snapshot) => snapshot.supportedRuntimeModes),
        );
        const withoutAuto = ["approval-required", "auto-accept-edits", "full-access"];
        const startedWithAuto = {
          ...started,
          sessionSetupResult: {
            ...sessionSetupResult,
            modes: {
              currentModeId: "default",
              availableModes: [
                { id: "default", name: "Default" },
                { id: "auto", name: "Auto" },
              ],
            },
          },
        };
        expect(yield* modes).toEqual(withoutAuto);
        yield* harness.provider.onSessionStarted(startedWithAuto);
        expect(yield* modes).toEqual([
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ]);
        yield* harness.provider.onSessionStarted(started);
        expect(yield* modes).toEqual(withoutAuto);
        yield* harness.provider.onSessionStarted(startedWithAuto);
        yield* harness.provider.onSignedOut();
        expect(yield* modes).toEqual(withoutAuto);
        const withAuto: ReadonlyArray<RuntimeMode> = [
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ];
        expect(yield* Ref.get(harness.savedRuntimeModes)).toEqual([
          withAuto,
          withoutAuto,
          withAuto,
          withoutAuto,
        ]);

        // A restart offers what the last session advertised before any session starts.
        const restarted = yield* makeHarness({ rememberedRuntimeModes: withAuto });
        yield* restarted.initialize;
        expect(yield* restarted.provider.snapshot.getSnapshot).toMatchObject({
          supportedRuntimeModes: withAuto,
        });
      }),
    ),
  );
  it.effect("publishes session metadata and native commands without another health probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const nextReady = yield* Stream.toPull(
          harness.provider.snapshot.streamChanges.pipe(
            Stream.filter(
              (snapshot) =>
                snapshot.auth.status === "authenticated" && snapshot.slashCommands.length > 0,
            ),
          ),
        );
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        const [snapshot] = yield* nextReady;
        expect(snapshot).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", type: "oauth-personal" },
          supportsTextGeneration: true,
        });
        expect(snapshot.models).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
        expect(snapshot.slashCommands).toEqual(expectedCommands);
        expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual(
          expectedCommands,
        );
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      }),
    ),
  );
  it.effect(
    "a sign-out from another home clears the current profile, since every home shares the credentials",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ currentProfile: Effect.succeed("/home/b") });
          yield* harness.initialize;
          yield* harness.provider.onSessionStarted(started, undefined, "/home/b");
          expect((yield* harness.provider.snapshot.getSnapshot).auth.status).toBe("authenticated");
          // A logout that began under the previous home finishes after this home was confirmed.
          yield* harness.provider.onSignedOut("/home/a");
          expect((yield* harness.provider.snapshot.getSnapshot).auth.status).toBe(
            "unauthenticated",
          );
          // A sign-in failure from that old session still leaves the current profile alone.
          yield* harness.provider.onSessionStarted(started, undefined, "/home/b");
          yield* harness.provider.onAuthRequired("/home/a");
          expect((yield* harness.provider.snapshot.getSnapshot).auth.status).toBe("authenticated");
        }),
      ),
  );
  it.effect("old session events cannot replace the current profile catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Ref.make("/home/a");
        const release = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ currentProfile: Ref.get(home) });
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, undefined, "/home/a");
        const oldEvents = yield* Effect.gen(function* () {
          yield* Deferred.succeed(waiting, undefined);
          yield* Deferred.await(release);
          yield* harness.provider.onConfigOptionsUpdated([], "/home/a");
          yield* harness.provider.onAvailableCommands(
            [{ name: "old", description: "Old command" }],
            undefined,
            "/home/a",
          );
        }).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Ref.set(home, "/home/b");
        yield* harness.provider.onSessionStarted(started, undefined, "/home/b");
        yield* harness.provider.onAvailableCommands(commands, undefined, "/home/b");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(oldEvents);
        const snapshot = yield* harness.provider.snapshot.getSnapshot;
        expect({ models: snapshot.models, commands: snapshot.slashCommands }).toEqual({
          models: buildAntigravityModelsFromSession(sessionSetupResult),
          commands: expectedCommands,
        });
      }),
    ),
  );
  it.effect("a sign-out is not lost when the home changes while it is applied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Ref.make("/home/b");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          currentProfile: Ref.get(home),
          clearUsage: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        });
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, undefined, "/home/b");
        const signOut = yield* harness.provider.onSignedOut("/home/b").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Ref.set(home, "/home/c");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(signOut);
        yield* Ref.set(home, "/home/b");
        expect((yield* harness.provider.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
      }),
    ),
  );
  it.effect("shows a thread session's native commands in that workspace's snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.snapshotForCwd("/workspace", []);
      // The thread adapter reports the cwd on session start; command updates arrive without one.
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands);
      expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual(
        expectedCommands,
      );
    }),
  );
  it.effect("clears all account metadata on sign-out and authentication failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = { type: "gemini-api-key", label: "Gemini API key" };
        const harness = yield* makeHarness({ auth });
        yield* harness.initialize;
        for (const clear of [harness.provider.onSignedOut(), harness.provider.onAuthRequired()]) {
          yield* harness.provider.onSessionStarted(started, "/workspace");
          yield* harness.provider.onAvailableCommands(commands, "/workspace");
          yield* clear;
          expect(yield* harness.provider.snapshot.getSnapshot).toMatchObject({
            installed: true,
            status: "warning",
            auth: { status: "unauthenticated", type: auth.type, label: auth.label },
            message: "Connect with Gemini API key to use Antigravity and load models.",
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
            supportsTextGeneration: false,
          });
          yield* harness.provider.onAvailableCommands(commands, "/workspace");
          yield* harness.provider.onConfigOptionsUpdated([modelConfig]);
          expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual([]);
          expect((yield* harness.provider.snapshot.getSnapshot).models).toEqual([]);
        }
        const refreshed = yield* harness.provider.snapshot.refresh;
        expect(refreshed.auth).toEqual({
          status: "unauthenticated",
          type: auth.type,
          label: auth.label,
        });
        expect(refreshed.message).toBe(
          "Connect with Gemini API key to use Antigravity and load models.",
        );
        expect(refreshed.supportsTextGeneration).toBe(false);
      }),
    ),
  );
  it.effect("replaces live model choices and accepts an empty catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        const before = yield* harness.provider.snapshot.getSnapshot;
        const configOptions = [
          {
            ...modelConfig,
            currentValue: "gemini-3.8-flash-high",
            options: modelOptions.slice(0, 3),
          },
        ];
        const nextSnapshot = yield* Stream.toPull(
          harness.provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.models.length === 3),
          ),
        );
        yield* harness.provider.onConfigOptionsUpdated(configOptions);
        expect((yield* nextSnapshot)[0]).toMatchObject({
          models: buildAntigravityModelsFromSession({ configOptions }),
          auth: before.auth,
          workspaceSnapshots: before.workspaceSnapshots,
          slashCommands: expectedCommands,
        });
        yield* harness.provider.onConfigOptionsUpdated([]);
        expect((yield* harness.provider.snapshot.getSnapshot).models).toEqual([]);
      }),
    ),
  );

  it.effect("does not guess a version before a custom launcher's first handshake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Deferred.succeed(harness.initialProbe, {
          ...initializeResult,
          agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
        });
        yield* harness.initialUpdate;
        expect((yield* harness.provider.snapshot.getSnapshot).version).toBeNull();
      }),
    ),
  );

  it.effect("does not replace a handshake version with an unknown custom-launcher probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted({
          ...started,
          initializeResult: {
            ...initializeResult,
            agentInfo: { ...initializeResult.agentInfo, version: "1.4.0" },
          },
        });
        yield* Ref.set(
          harness.probe,
          Effect.succeed({
            ...initializeResult,
            agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
          }),
        );
        expect((yield* harness.provider.snapshot.refresh).version).toBe("1.4.0");
      }),
    ),
  );

  it.effect("replaces one account's catalog instead of combining accounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        yield* harness.provider.onSignedOut();
        yield* harness.provider.onSessionStarted({
          ...started,
          sessionSetupResult: {
            sessionId: "new-account-session",
            configOptions: [
              { ...modelConfig, currentValue: "gemini-pro-agent", options: [modelOptions[9]!] },
            ],
          },
        });
        expect(
          (yield* harness.provider.snapshot.getSnapshot).models.map((model) => model.slug),
        ).toEqual(["gemini-pro-agent"]);
      }),
    ),
  );

  it.effect("retains known account metadata when a local health check fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        yield* Ref.set(
          harness.probe,
          Effect.fail(EffectAcpErrors.AcpRequestError.internalError("probe failed")),
        );
        const snapshot = yield* harness.provider.snapshot.refresh;
        expect(snapshot).toMatchObject({
          installed: true,
          status: "error",
          auth: { status: "authenticated" },
        });
        expect(snapshot.models).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
        expect(snapshot.slashCommands).toEqual(expectedCommands);
        expect(snapshot.workspaceSnapshots?.[0]?.cwd).toBe("/workspace");
      }),
    ),
  );

  it.effect("a probe timeout override set after construction applies at the next check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* Ref.make<NodeJS.ProcessEnv>({});
        const harness = yield* makeHarness({ environment: Ref.get(environment) });
        yield* harness.initialize;
        yield* Ref.set(environment, { GOAT_ANTIGRAVITY_PROBE_TIMEOUT_MS: "120000" });
        yield* Ref.set(harness.probe, Effect.never);
        const check = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* TestClock.adjust("120 seconds");
        const snapshot = yield* Fiber.join(check);
        expect(snapshot.message).toBe(
          "Antigravity did not respond to its local health check within 120 seconds.",
        );
      }),
    ),
  );

  it.effect("distinguishes missing executables from a failed installed executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const failures = [
          {
            error: new EffectAcpErrors.AcpSpawnError({ cause: { code: "ENOENT" } }),
            installed: false,
          },
          {
            error: new EffectAcpErrors.AcpSpawnError({ cause: { code: "EACCES" } }),
            installed: true,
          },
          {
            error: new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: "Antigravity is not installed.",
            }),
            installed: false,
          },
        ];
        for (const { error, installed } of failures) {
          yield* harness.provider.onSessionStarted(started, "/workspace");
          yield* harness.provider.onAvailableCommands(commands, "/workspace");
          yield* Ref.set(harness.probe, Effect.fail(error));
          const snapshot = yield* harness.provider.snapshot.refresh;
          expect(snapshot).toMatchObject({
            installed,
            status: "error",
            auth: { status: "authenticated" },
          });
          expect(snapshot.models).toHaveLength(installed ? 11 : 0);
          expect(snapshot.slashCommands).toHaveLength(installed ? 2 : 0);
          expect(snapshot.workspaceSnapshots).toHaveLength(installed ? 1 : 0);
          expect(snapshot.supportsTextGeneration).toBe(installed);
        }
      }),
    ),
  );

  it.effect("does not let an old health result restore a signed-out account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        const releaseProbe = yield* Deferred.make<EffectAcpSchema.InitializeResponse>();
        const probeEntered = yield* Deferred.make<void>();
        yield* Ref.set(
          harness.probe,
          Deferred.succeed(probeEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProbe)),
          ),
        );
        const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(probeEntered);
        yield* harness.provider.onSignedOut();
        yield* Deferred.succeed(releaseProbe, initializeResult);
        const snapshot = yield* Fiber.join(refresh);
        expect(snapshot).toMatchObject({
          auth: { status: "unauthenticated" },
          models: [],
          supportsTextGeneration: false,
        });
      }),
    ),
  );

  it.effect("exposes helper support only when the supplied safety check allows it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ safe: false });
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(false);
        yield* Ref.set(harness.safety, Effect.succeed(true));
        yield* harness.provider.snapshot.refresh;
        expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(true);
      }),
    ),
  );

  it.effect("keeps discovered workspace skills through session and command updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const skills = [
          {
            name: "deploy",
            description: "Ship it",
            path: "/workspace/.agent/skills/deploy",
            enabled: true,
          },
        ];
        const discovered = yield* harness.provider.snapshotForCwd("/workspace", skills);
        expect(discovered.skills).toEqual(skills);
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        const after = yield* harness.provider.snapshot.getSnapshot;
        expect(
          after.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace")?.skills,
        ).toEqual(skills);
        expect((yield* harness.provider.snapshotForCwd("/workspace")).skills).toEqual(skills);

        const rescanned = [
          ...skills,
          { name: "review", path: "/workspace/.agent/skills/review", enabled: true },
        ];
        yield* harness.provider.snapshotForCwd("/workspace", rescanned);
        yield* harness.provider.onSessionStarted(started, "/workspace");
        expect(
          (yield* harness.provider.snapshot.getSnapshot).workspaceSnapshots?.find(
            (entry) => entry.cwd === "/workspace",
          )?.skills,
        ).toEqual(rescanned);
      }),
    ),
  );

  it.effect("a session in an unscanned folder does not publish its skills as scanned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const unscanned = () =>
          Effect.map(harness.provider.snapshot.getSnapshot, (snapshot) => {
            const entry = snapshot.workspaceSnapshots?.find((item) => item.cwd === "/workspace");
            // ProviderRegistry skips the skill scan for a current entry that is not pending.
            return entry === undefined || isProviderWorkspaceSnapshotPending(entry);
          });

        yield* harness.provider.onSessionStarted(started, "/workspace");
        expect(yield* unscanned()).toBe(true);
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        expect(yield* unscanned()).toBe(true);
      }),
    ),
  );

  it.effect("a skill scan leaves the folder entry it scanned from unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started, "/workspace");
        const published = yield* harness.provider.snapshot.getSnapshot;
        const entryOf = (provider: ServerProvider) =>
          provider.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace");
        const skills = [{ name: "deploy", path: "/workspace/.agent/skills/deploy", enabled: true }];

        yield* harness.provider.snapshotForCwd("/workspace", skills);
        // ProviderRegistry saves the scan only if the entry it scanned from is still published.
        const republished = mergeProviderSnapshot(
          published,
          yield* harness.provider.snapshot.getSnapshot,
        );
        expect(entryOf(republished)).toEqual(entryOf(published));
      }),
    ),
  );

  it.effect(
    "keeps a scanned folder's own commands when another folder reports different ones",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* harness.initialize;
          yield* harness.provider.onAvailableCommands(commands, "/a");
          yield* harness.provider.snapshotForCwd("/a", []);
          yield* harness.provider.onAvailableCommands(commands.slice(1), "/b");
          expect((yield* harness.provider.snapshotForCwd("/a", [])).slashCommands).toEqual(
            expectedCommands,
          );
          yield* harness.provider.onSessionStarted(started, "/a");
          expect(
            (yield* harness.provider.snapshot.getSnapshot).workspaceSnapshots?.find(
              (entry) => entry.cwd === "/a",
            )?.slashCommands,
          ).toEqual(expectedCommands);
        }),
      ),
  );

  it.effect("bounds workspace metadata without starting sessions for workspace lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        for (let index = 0; index < 35; index++) {
          yield* harness.provider.onAvailableCommands(commands, `/workspace-${index}`);
        }
        const snapshot = yield* harness.provider.snapshotForCwd("/workspace-34");
        expect(snapshot.workspaceSnapshots).toHaveLength(32);
        expect(snapshot.workspaceSnapshots?.[0]?.cwd).toBe("/workspace-3");
        expect(snapshot.slashCommands).toEqual(expectedCommands);
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      }),
    ),
  );

  it.effect(
    "publishes limits, retains a successful read on failure, and clears them on sign-out",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const limits: ServerProviderUsageLimits = {
            checkedAt: "2026-10-09T12:00:00.000Z",
            windows: [
              {
                id: "3p-weekly",
                kind: "weekly",
                label: "Claude & GPT (shared) · Weekly",
                usedPercent: 75,
              },
            ],
          };
          const usage = yield* Ref.make(limits);
          const harness = yield* makeHarness({ probeUsage: Ref.get(usage) });
          const published = yield* harness.nextPublish((snapshot) => !!snapshot.usageLimits);
          yield* harness.initialize;
          expect((yield* published)?.usageLimits).toEqual(limits);
          // The second health check is the one the failed background read triggers.
          const checks = yield* Ref.make(0);
          const failedReadApplied = yield* Deferred.make<void>();
          yield* Ref.set(
            harness.probe,
            Ref.updateAndGet(checks, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 2 ? Deferred.succeed(failedReadApplied, undefined) : Effect.void,
              ),
              Effect.as(initializeResult),
            ),
          );
          yield* Ref.set(usage, {
            checkedAt: "2026-10-09T12:01:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed" },
          });
          yield* harness.provider.snapshot.refresh;
          yield* Deferred.await(failedReadApplied);
          expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toEqual(limits);
          yield* harness.provider.onSignedOut();
          expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toBeUndefined();
          yield* Ref.set(usage, {
            checkedAt: "2026-10-09T12:02:00.000Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          });
          const unsupported = yield* harness.nextPublish(
            (snapshot) => snapshot.usageLimits?.unavailable?.reason === "unsupported",
          );
          yield* harness.provider.snapshot.refresh;
          expect((yield* unsupported)?.usageLimits?.windows).toEqual([]);
        }),
      ),
  );

  it.effect("a quota read finishing after sign-out cannot restore account limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const readResult = yield* Deferred.make<ServerProviderUsageLimits>();
        const usage = yield* Ref.make<Effect.Effect<ServerProviderUsageLimits>>(
          Effect.succeed({ checkedAt: "2026-10-09T12:00:00.000Z", windows: [] }),
        );
        const harness = yield* makeHarness({ probeUsage: Ref.get(usage).pipe(Effect.flatten) });
        yield* harness.initialize;
        yield* Ref.set(harness.probe, Effect.succeed(initializeResult));
        yield* Ref.set(
          usage,
          Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(readResult))),
        );
        const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        yield* harness.provider.onSignedOut();
        yield* Deferred.succeed(readResult, {
          checkedAt: "2026-10-09T12:01:00.000Z",
          windows: [
            { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 10 },
          ],
        });
        yield* Fiber.join(refresh);
        expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toBeUndefined();
      }),
    ),
  );

  it.effect("reports ready and starts sessions while one shared quota read is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads = yield* Ref.make(0);
        const readStarted = yield* Deferred.make<void>();
        const readResult = yield* Deferred.make<ServerProviderUsageLimits>();
        const harness = yield* makeHarness({
          probeUsage: Ref.update(reads, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(readStarted, undefined)),
            Effect.andThen(Deferred.await(readResult)),
          ),
        });
        const published = yield* harness.nextPublish((snapshot) => !!snapshot.usageLimits);
        yield* harness.initialize;
        yield* Deferred.await(readStarted);
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onSessionStarted(started, "/other");
        const ready = yield* harness.provider.snapshot.getSnapshot;
        expect(ready).toMatchObject({ status: "ready", auth: { status: "authenticated" } });
        expect(ready.usageLimits).toBeUndefined();
        expect(yield* Ref.get(reads)).toBe(1);
        const limits = {
          checkedAt: "2026-10-09T12:00:00.000Z",
          windows: [
            { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 10 },
          ],
        } satisfies ServerProviderUsageLimits;
        yield* Deferred.succeed(readResult, limits);
        expect((yield* published)?.usageLimits).toEqual(limits);
      }),
    ),
  );

  it.effect("a quota read for the previous account is dropped after a new sign-in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldReadStarted = yield* Deferred.make<void>();
        const newLimits = {
          checkedAt: "2026-10-09T12:01:00.000Z",
          windows: [{ id: "3p-weekly", kind: "weekly", label: "Weekly", usedPercent: 40 }],
        } satisfies ServerProviderUsageLimits;
        const usage = yield* Ref.make<Effect.Effect<ServerProviderUsageLimits>>(
          Deferred.succeed(oldReadStarted, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const harness = yield* makeHarness({ probeUsage: Ref.get(usage).pipe(Effect.flatten) });
        const published = yield* harness.nextPublish((snapshot) => !!snapshot.usageLimits);
        yield* harness.initialize;
        yield* Deferred.await(oldReadStarted);
        yield* Ref.set(usage, Effect.succeed(newLimits));
        yield* harness.provider.onSignedIn;
        yield* harness.provider.onSessionStarted(started);
        expect((yield* published)?.usageLimits).toEqual(newLimits);
        // Switching again must not republish the previous account's limits, even if the read fails.
        const failed = {
          checkedAt: "2026-10-09T12:02:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        } satisfies ServerProviderUsageLimits;
        yield* Ref.set(usage, Effect.succeed(failed));
        const republished = yield* harness.nextPublish(
          (snapshot) => snapshot.usageLimits?.unavailable?.reason === "probeFailed",
        );
        yield* harness.provider.onSignedIn;
        expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toBeUndefined();
        yield* harness.provider.onSessionStarted(started);
        expect((yield* republished)?.usageLimits).toEqual(failed);
      }),
    ),
  );
});

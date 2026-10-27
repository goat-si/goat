import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId } from "@goat/contracts";
import {
  OPEN_CODEX_PINNED_VERSION,
  WINDOWS_REMOTE_LINK_UNPINNED,
} from "@goat/shared/opencodexRelease";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as AutomationHold from "../automationHold.ts";
import { build, type Machine, MINUTE, PERSON, setup } from "./OpenCodexChildBootstrap.testkit.ts";

/** A test-only pin with Windows Remote Link support; no real GOAT pin has one yet. */
const windowsPins = {
  [OPEN_CODEX_PINNED_VERSION]: {
    "win32-x64": {
      version: OPEN_CODEX_PINNED_VERSION,
      target: "bun-windows-x64",
      url: "https://fixture.invalid/ocx-windows.zip",
      sha256: "0".repeat(64),
      archiveBytes: 1,
      publishedAt: "2026-10-28T00:00:00Z",
      layout: { executable: "ocx.exe", gui: "gui/dist/index.html", keyring: "keyring" },
      remoteLinkWindows: true,
    },
  },
};

it.layer(NodeServices.layer)("OpenCodex Child bootstrap", (it) => {
  it.effect("held: dispatches no child setup; release: the queued machine joins", () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const fs = yield* FileSystem.FileSystem;
      const home = yield* setup().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeDirectory: () => Effect.void,
          writeFileString: () => Effect.void,
          rename: () => Effect.void,
        }),
        Effect.provideService(AutomationHold.AutomationHold, hold),
      );
      yield* home.ready("boat-builder");
      const ensured = yield* Effect.forkChild(home.bootstrap.ensure("boat-builder"));
      yield* TestClock.adjust("0 millis");
      expect(home.calls).toEqual([]);
      yield* hold.release;
      expect((yield* Fiber.join(ensured))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
    }),
  );

  it.effect("held: sends no pending link release; release: revokes the removed machine", () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const home = yield* setup({
        pending: new Set(["boat-builder"]),
        removed: new Set(["boat-builder"]),
      }).pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
      yield* TestClock.adjust("0 millis");
      expect(yield* Queue.size(home.machine.hubEvents)).toBe(0);
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));
      yield* hold.release;
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect("a readied cloud machine gets this Home's OpenCodex and joins as its Child, once", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ready("boat-builder");
      // A second readying while the first job runs joins it.
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
      expect(yield* home.bootstrap.status("boat-builder")).toMatchObject({
        state: "child",
        version: "2.91.0",
      });
      // Readied again later, as every use does: a Child is left alone.
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
      // A GOAT restart reads the same outcome back.
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      yield* restarted.ready("boat-builder");
      expect((yield* restarted.bootstrap.status("boat-builder"))?.state).toBe("child");
      expect(home.calls).toHaveLength(2);
    }),
  );

  it.effect(
    "compiled installer failure is blocked with install_failed and retried after ten minutes",
    () =>
      Effect.gen(function* () {
        const home = yield* setup({ prepareFailure: "installation_failed" });
        expect(yield* home.bootstrap.ensure("boat-builder")).toMatchObject({
          state: "blocked",
          reason: "install_failed",
        });
        expect(home.calls).toEqual(["prepare boat-builder 2.91.0"]);
        yield* home.ready("boat-builder");
        expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("blocked");
        home.machine.prepareFailure = undefined;
        yield* TestClock.adjust(10 * MINUTE);
        yield* home.ready("boat-builder");
        expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("running");
        expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
      }),
  );

  it.effect("ensures GOAT before preparing a fresh Child", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      home.machine.duringEnsure = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const job = yield* home.bootstrap.ensure("boat-builder").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(home.calls).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(job))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
    }),
  );

  it.effect("blocks with goat_runtime_missing when runtime provisioning remains pending", () =>
    Effect.gen(function* () {
      const home = yield* setup({ runtime: false });
      expect(yield* home.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "goat_runtime_missing",
        message: "GOAT's runtime is not available there. Finish SSH setup and retry.",
      });
      expect(home.calls).toEqual([]);
      // The new reason and a legacy npm one both read back after a restart.
      const fs = yield* FileSystem.FileSystem;
      const file = `${home.stateDir}/opencodex-child-bootstrap.json`;
      const saved = JSON.parse(yield* fs.readFileString(file));
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          ...saved,
          "boat-legacy": { state: "blocked", checkedAt: 1, reason: "npm_missing" },
        }),
      );
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      expect((yield* restarted.bootstrap.status("boat-builder"))?.reason).toBe(
        "goat_runtime_missing",
      );
      expect((yield* restarted.bootstrap.status("boat-legacy"))?.reason).toBe("npm_missing");
    }),
  );

  it.effect("withdrawn consent during runtime provisioning prevents OpenCodex preparation", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringEnsure = home.bootstrap
        .setSshOptIn("lidge-ts", false, PERSON)
        .pipe(Effect.orDie);
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.status("lidge-ts")).toBeUndefined();
    }),
  );

  it.effect("leaves an SSH host this server did not create untouched", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ready("boat-someone-else");
      expect(yield* home.bootstrap.ensure("boat-someone-else")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.status("boat-someone-else")).toBeUndefined();
    }),
  );

  it.effect("leaves the machine untouched when this server is not a hub", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.ready("boat-builder");
      expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
    }),
  );

  it.effect("reports why it stopped instead of installing where a Child cannot run", () =>
    Effect.gen(function* () {
      const windows = yield* setup({ platform: "windows" });
      expect(yield* windows.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "platform_unsupported",
        message: WINDOWS_REMOTE_LINK_UNPINNED,
      });
      const oldHome = yield* setup({ homeVersion: "2.60.0" });
      expect(yield* oldHome.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "home_unavailable",
      });
      const refused = yield* setup({ joined: "failed" });
      expect(yield* refused.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "link_failed",
      });
      expect([...windows.calls, ...oldHome.calls]).toEqual([]);
    }),
  );

  it.effect(
    "a consented Windows Child reaches preparation and Remote Link once GOAT pins Windows support",
    () =>
      Effect.gen(function* () {
        const windows = yield* setup({ platform: "windows", releases: windowsPins });
        expect(yield* windows.bootstrap.ensure("boat-builder")).toMatchObject({ state: "child" });
        expect(windows.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
      }),
  );

  it.effect(
    "a native Windows Child named only by its typed status stops before linking without a pin",
    () =>
      Effect.gen(function* () {
        const windows = yield* setup({ nativeWindows: true });
        expect(yield* windows.bootstrap.ensure("boat-builder")).toMatchObject({
          state: "blocked",
          reason: "platform_unsupported",
          message: WINDOWS_REMOTE_LINK_UNPINNED,
        });
        expect(windows.calls).toEqual(["prepare boat-builder 2.91.0"]);
      }),
  );

  it.effect("a stopped machine keeps its setup and link; a removed one releases its link", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.ensure("boat-builder");
      yield* home.invalidated("boat-builder", "lifecycle");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
      expect(home.machine.pending).toEqual(new Set());
      // The release is on record before the catalog lets go of the machine.
      yield* home.removing("boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));
      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect("a failed release is retried after a restart, once the catalog says it is gone", () =>
    Effect.gen(function* () {
      const home = yield* setup({ revokes: false });
      // GOAT stopped before the catalog let go of the machine: the release waits for it.
      yield* home.removing("boat-builder");
      yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));

      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));

      home.machine.revokes = true;
      yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect("an unreadable catalog holds the release until a start that can read it", () =>
    Effect.gen(function* () {
      const home = yield* setup({ catalogReadable: false });
      yield* home.removing("boat-builder");
      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      home.machine.catalogReadable = true;
      yield* build(home.baseDir, home.machine, home.calls);
      // The next event is the restart's own check, so the first start released nothing.
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect(
    "keeps joining cloud machines by default; with the cloud switch off GOAT leaves new ones alone",
    () =>
      Effect.gen(function* () {
        const home = yield* setup({ autoJoin: false });
        yield* home.ready("boat-builder");
        expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
        expect(home.calls).toEqual([]);
        expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
      }),
  );

  it.effect("turning the cloud switch off while a machine is prepared stops before the join", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = Effect.sync(() => void (home.machine.autoJoin = false));
      expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0"]);
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
    }),
  );

  it.effect(
    "the cloud switch stops only new joins: a Child stays and a removed one still releases",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
        home.machine.autoJoin = false;
        yield* home.ready("boat-builder");
        expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
        yield* home.removing("boat-builder");
        home.machine.removed.add("boat-builder");
        yield* home.invalidated("boat-builder", "removed");
        expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
        expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
        expect(home.machine.pending).toEqual(new Set());
      }),
  );

  it.effect("an SSH host GOAT set up stays standalone until a person opts it in", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ssh("lidge-ts", "ready");
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      // Cloud machines follow the hub's switch, and hosts GOAT did not set up have no switch.
      expect(yield* home.bootstrap.sshOptIn("boat-builder")).toBeUndefined();
      expect(yield* home.bootstrap.sshOptIn("from-ssh-config")).toBeUndefined();
    }),
  );

  it.effect("an opted-in SSH host joins on the person's consent now and after setups, once", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as person"]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
      // Every later setup readies the host again: a Child is left alone.
      yield* home.ssh("lidge-ts", "ready");
      expect((yield* home.bootstrap.status("lidge-ts"))?.state).toBe("child");
      // The consent outlives a GOAT restart.
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(true);
      expect(home.calls).toHaveLength(2);
    }),
  );

  it.effect("only a live client session with settings:write can opt a host in", () =>
    Effect.gen(function* () {
      const home = yield* setup({ sessions: new Map([["reader", ["orchestration:read"]]]) });
      const agent = {
        kind: "mcp" as const,
        scope: {
          environmentId: EnvironmentId.make("home"),
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          requestNamespace: "agent",
          thread: undefined,
          client: { sessionId: "agent", label: "Agent", access: "full-access" as const },
          grantedScopes: ["settings:write" as const],
        },
      };
      const reader = { kind: "client" as const, sessionId: AuthSessionId.make("reader") };
      for (const caller of [agent, reader, PERSON]) {
        const refused = yield* home.bootstrap
          .setSshOptIn("lidge-ts", true, caller)
          .pipe(Effect.flip);
        expect(refused._tag).toBe("EnvironmentAuthorizationError");
      }
      home.machine.sessions.set("person", ["settings:write"]);
      for (const alias of ["boat-builder", "from-ssh-config", "../lidge-ts"]) {
        const refused = yield* home.bootstrap.setSshOptIn(alias, true, PERSON).pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "invalid_request" });
      }
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      expect(home.calls).toEqual([]);
    }),
  );

  it.effect("opting out while the host is prepared stops the join; opting out never unlinks", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = home.bootstrap
        .setSshOptIn("lidge-ts", false, PERSON)
        .pipe(Effect.orDie);
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
      expect(yield* home.bootstrap.status("lidge-ts")).toBeUndefined();

      home.machine.duringPrepare = Effect.void;
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      yield* home.bootstrap.setSshOptIn("lidge-ts", false, PERSON);
      // Nothing ran to remove the link: membership is a person's to end with Leave.
      expect(home.calls.slice(1)).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as person"]);
      expect((yield* home.bootstrap.status("lidge-ts"))?.state).toBe("child");
    }),
  );

  it.effect("a session that loses its access ends the consent, and the host says why", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = Effect.sync(() => void home.machine.sessions.delete("person"));
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
        state: "blocked",
        reason: "consent_revoked",
      });
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect(
    "SSH settings GOAT cannot read block one attempt and keep the consent for the next",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        home.machine.duringPrepare = Effect.sync(
          () => void (home.machine.revisionReadable = false),
        );
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "link_failed",
        });
        home.machine.revisionReadable = true;
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
        home.machine.duringPrepare = Effect.void;
        expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      }),
  );

  it.effect(
    "a Forget ends the consent at once and for good, even while the host's files stay",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        // SshHostSetup bumps the alias generation, then tells listeners, before any teardown.
        home.machine.duringPrepare = Effect.sync(
          () => void home.machine.generations.set("lidge-ts", 1),
        ).pipe(Effect.andThen(home.ssh("lidge-ts", "forgotten")), Effect.orDie);
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
        expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        // The files and their revision are unchanged, yet a restart finds no consent.
        const restarted = yield* build(home.baseDir, home.machine, home.calls);
        yield* restarted.ssh("lidge-ts", "ready");
        expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        expect(home.calls).toHaveLength(1);
      }),
  );

  it.effect("a Forget whose consent cannot be cleared on disk stops that Forget", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      yield* home.bootstrap.ensure("lidge-ts");
      const fs = yield* FileSystem.FileSystem;
      // A directory where the next write goes makes that write fail.
      yield* fs.makeDirectory(`${home.stateDir}/opencodex-child-ssh-consent.json.tmp`);
      const refused = yield* home.ssh("lidge-ts", "forgotten").pipe(Effect.flip);
      expect(refused.code).toBe("orchestration_error");
      // This process stopped using it all the same.
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      const refusedGrant = yield* home.bootstrap
        .setSshOptIn("lidge-ts", true, PERSON)
        .pipe(Effect.flip);
      expect(refusedGrant).toMatchObject({ code: "orchestration_error" });
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect("an alias added again does not inherit consent given for the old one", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      // Not a hub: the consent waits, and nothing runs.
      yield* home.ssh("lidge-ts", "ready");
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBeUndefined();
      home.machine.hub = true;
      home.machine.revisions.set("lidge-ts", "rev-2");
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      yield* home.ssh("lidge-ts", "ready");
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual([]);
    }),
  );

  it.effect(
    "consent given again during a setup stops that setup; one under the new consent joins",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        home.machine.duringPrepare = Effect.sync(
          () => void (home.machine.duringPrepare = Effect.void),
        ).pipe(Effect.andThen(home.bootstrap.setSshOptIn("lidge-ts", true, PERSON)), Effect.orDie);
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
        expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
        expect(home.calls).toEqual([
          "prepare lidge-ts 2.91.0",
          "prepare lidge-ts 2.91.0",
          "join lidge-ts as person",
        ]);
      }),
  );

  it.effect("a withdrawal or Forget during the last consent read before linking wins", () =>
    Effect.gen(function* () {
      // Authority is read when consent is given, before the setup, around ensuring GOAT's
      // runtime, when identifying the Child, when binding its setup purpose, after preparing,
      // and by the join itself under the hub permit; the change lands inside the last read
      // before the join.
      const opted = yield* setup();
      opted.machine.duringSessionRead = {
        at: 12,
        run: opted.bootstrap.setSshOptIn("lidge-ts", false, PERSON).pipe(Effect.orDie),
      };
      yield* opted.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* opted.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(opted.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);

      const forgotten = yield* setup();
      forgotten.machine.duringSessionRead = {
        at: 12,
        run: Effect.sync(() => void forgotten.machine.generations.set("lidge-ts", 1)).pipe(
          Effect.andThen(forgotten.ssh("lidge-ts", "forgotten")),
          Effect.orDie,
        ),
      };
      yield* forgotten.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* forgotten.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(forgotten.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);
    }),
  );

  it.effect("turning a host off after a failed write succeeds only once it is on disk", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      const fs = yield* FileSystem.FileSystem;
      const blocker = `${home.stateDir}/opencodex-child-ssh-consent.json.tmp`;
      yield* fs.makeDirectory(blocker);
      for (const _attempt of [1, 2]) {
        const refused = yield* home.bootstrap
          .setSshOptIn("lidge-ts", false, PERSON)
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "orchestration_error" });
      }
      yield* fs.remove(blocker, { recursive: true });
      yield* home.bootstrap.setSshOptIn("lidge-ts", false, PERSON);
      home.machine.hub = true;
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect("an expired session neither gives consent nor keeps it", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.expired.add("person");
      const refused = yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON).pipe(Effect.flip);
      expect(refused._tag).toBe("EnvironmentAuthorizationError");
      home.machine.expired.delete("person");
      home.machine.duringPrepare = Effect.sync(() => void home.machine.expired.add("person"));
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
        state: "blocked",
        reason: "consent_revoked",
      });
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
    }),
  );

  it.effect(
    "a signed-out session turns the switch off when the host is next read, and says why",
    () =>
      Effect.gen(function* () {
        const home = yield* setup({ hub: false });
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        home.machine.hub = true;
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
        home.machine.sessions.delete("person");
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        expect(yield* home.bootstrap.status("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "consent_revoked",
        });
        expect(home.calls).toEqual([]);
      }),
  );

  it.effect("a session that ends while the last settings read waits still stops the join", () =>
    Effect.gen(function* () {
      const endings: ReadonlyArray<(machine: Machine) => void> = [
        (machine) => void machine.sessions.delete("person"),
        (machine) => void machine.expired.add("person"),
        (machine) => void machine.sessions.set("person", ["orchestration:operate"]),
      ];
      for (const end of endings) {
        const home = yield* setup();
        // Hub state is read before the setup, around ensuring GOAT's runtime, when identifying
        // the Child, when binding its setup purpose, after preparing, and last by the join.
        home.machine.duringSettingsRead = { at: 7, run: Effect.sync(() => end(home.machine)) };
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "consent_revoked",
        });
        expect(home.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);
      }
    }),
  );

  it.effect("a hub turned off while the alias's files are read last still stops the join", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      // Read when consent is given, before the setup, around ensuring GOAT's runtime, when
      // identifying the Child, when binding its setup purpose, after preparing, and last by the
      // join.
      home.machine.duringRevisionRead = {
        at: 8,
        run: Effect.sync(() => void (home.machine.hub = false)),
      };
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);
    }),
  );

  it.effect("joins follow the committed hub settings, not a read captured before a change", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.capturedHub = { enabled: true, autoJoin: true };
      home.machine.duringPrepare = Effect.sync(() => void (home.machine.autoJoin = false));
      expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0"]);
    }),
  );
});

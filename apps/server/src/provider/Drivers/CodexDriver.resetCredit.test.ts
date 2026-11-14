import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderInstanceEnvironment } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The OS's realpath follows a link before "..".
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ChildProcess } from "effect/process";

import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** A fresh coordinator whose redemptions follow `script`: "uncertain" keeps the key pending. */
const scriptedCoordinator = (script: Array<"uncertain" | "settled">) =>
  Effect.gen(function* () {
    const real = yield* Effect.service(ResetCreditCoordinator.ResetCreditCoordinator).pipe(
      Effect.provide(ResetCreditCoordinator.layerTest),
    );
    const keys: Array<string> = [];
    const service = ResetCreditCoordinator.ResetCreditCoordinator.of({
      redeem: (accountKey, _consume, isSettled) =>
        real.redeem(
          accountKey,
          (idempotencyKey) =>
            Effect.suspend(() => {
              keys.push(idempotencyKey);
              return script.shift() === "uncertain"
                ? Effect.die("timed out")
                : Effect.succeed("nothingToReset" as const);
            }),
          isSettled,
        ),
    });
    return { service, keys };
  });

const createInstance = (input: {
  readonly id: string;
  readonly root: string;
  readonly host: NodeJS.ProcessEnv;
  readonly coordinator?: ResetCreditCoordinator.ResetCreditCoordinator["Service"];
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly environment?: ProviderInstanceEnvironment;
  readonly enabled?: boolean;
}) =>
  CodexDriver.create({
    instanceId: ProviderInstanceId.make(input.id),
    displayName: "Codex reset credit test",
    enabled: input.enabled ?? true,
    environment: input.environment ?? [],
    config: {
      ...CodexDriver.defaultConfig(),
      homePath: input.homePath ?? "",
      shadowHomePath: input.shadowHomePath ?? "",
    },
  }).pipe(
    Effect.provideService(HostProcess.Environment, input.host),
    Effect.provideService(HostProcess.HomeDirectory, input.root),
    (effect) =>
      input.coordinator === undefined
        ? effect
        : Effect.provideService(
            effect,
            ResetCreditCoordinator.ResetCreditCoordinator,
            input.coordinator,
          ),
    (effect) =>
      input.spawner === undefined
        ? effect
        : Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, input.spawner),
  );

/** Two signed-in homes, and `alias` -> vault/team, so `alias/../acct` is vault/acct to the OS. */
const aliasedHomes = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const home of [`${root}/vault/acct`, `${root}/acct`]) {
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(`${home}/auth.json`, "{}");
    }
    yield* fs.makeDirectory(`${root}/vault/team`);
    yield* fs.symlink(`${root}/vault/team`, `${root}/alias`);
    yield* fs.symlink(`${root}/vault/acct`, `${root}/current`);
    return `${root}/alias/../acct`;
  });

/** Records the redemption's spawn and fails it; the instance is disabled so nothing else spawns. */
const redemptionSpawn = (input: {
  readonly host: NodeJS.ProcessEnv;
  readonly root: string;
  readonly beforeRedeem?: () => void;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = `${input.root}/bin`;
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(`${bin}/codex`, "#!/bin/sh\n");
    yield* fs.chmod(`${bin}/codex`, 0o755);
    const spawns: Array<{
      readonly env: NodeJS.ProcessEnv | undefined;
      readonly extendEnv: unknown;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command))
        spawns.push({ env: command.options.env, extendEnv: command.options.extendEnv });
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "test",
          method: "spawn",
          description: "recorded",
        }),
      );
    });
    const real = yield* Effect.service(ResetCreditCoordinator.ResetCreditCoordinator).pipe(
      Effect.provide(ResetCreditCoordinator.layerTest),
    );
    const coordinator = ResetCreditCoordinator.ResetCreditCoordinator.of({
      redeem: (accountKey, consume, isSettled) =>
        Effect.suspend(() => {
          input.beforeRedeem?.();
          return real.redeem(accountKey, consume, isSettled);
        }),
    });
    const instance = yield* createInstance({
      id: "reset-credit-spawn",
      root: input.root,
      host: { ...input.host, PATH: bin },
      coordinator,
      spawner,
      enabled: false,
    });
    yield* instance.consumeResetCredit!().pipe(Effect.exit);
    return spawns;
  });

it.layer(layerTest)("CodexDriver reset credits", (it) => {
  // The fixture codex is a POSIX shell script and the homes use symlinks.
  it.effect.skipIf(windowsHost)(
    "the redemption gets CODEX_HOME as written, so a link followed by .. reaches the home Codex uses",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const home = yield* aliasedHomes(root);
        const spawns = yield* redemptionSpawn({ root, host: { HOME: root, CODEX_HOME: home } });
        expect(spawns).toHaveLength(1);
        expect(spawns[0]?.env?.CODEX_HOME).toBe(home);
        expect(spawns[0]?.extendEnv).toBe(false);
        expect(NodeFS.realpathSync.native(home)).toBe(`${root}/vault/acct`);
      }).pipe(Effect.scoped),
  );

  // The fixture codex is a POSIX shell script, which Windows cannot resolve as an executable.
  it.effect.skipIf(windowsHost)(
    "a host CODEX_HOME that appears after the environment was captured does not reach the redemption",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const host: NodeJS.ProcessEnv = { HOME: `${root}/b` };
        const spawns = yield* redemptionSpawn({
          root,
          host,
          beforeRedeem: () => {
            host.CODEX_HOME = `${root}/late`;
          },
        });
        expect(spawns).toHaveLength(1);
        expect(spawns[0]?.env?.CODEX_HOME).toBeUndefined();
        expect(spawns[0]?.extendEnv).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("two homes that differ only by a trailing space are separate accounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled", "settled"]);
      const host: NodeJS.ProcessEnv = { PATH: "", CODEX_HOME: `${root}/a` };
      const instance = yield* createInstance({ id: "spaced", root, host, coordinator: service });
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a `;
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a`;
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      expect(keys).toHaveLength(3);
      const [first, other, retry] = keys;
      expect(other).not.toBe(first);
      expect(retry).toBe(first);
    }).pipe(Effect.scoped),
  );

  // The homes use symlinks.
  it.effect.skipIf(windowsHost)(
    "a link followed by .. is a different account from the lexical path it collapses to",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const home = yield* aliasedHomes(root);
        const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled"]);
        const following = yield* createInstance({
          id: "dotdot",
          root,
          host: { PATH: "", CODEX_HOME: home },
          coordinator: service,
        });
        const lexical = yield* createInstance({
          id: "lexical",
          root,
          host: { PATH: "" },
          homePath: `${root}/acct`,
          coordinator: service,
        });
        yield* following.consumeResetCredit!().pipe(Effect.exit);
        yield* lexical.consumeResetCredit!().pipe(Effect.exit);
        expect(keys).toHaveLength(2);
        expect(keys[1]).not.toBe(keys[0]);
      }).pipe(Effect.scoped),
  );

  // Codex resolves CODEX_HOME as written from its working directory, the server's: no trim, no ~;
  // without one it uses .codex under the HOME it receives. Symlink cases are POSIX fixtures.
  const spaced = (root: string) => `${root}/user `;
  it.effect.each([
    {
      name: "a host home ending in a space",
      follow: (root: string) => ({ host: { CODEX_HOME: spaced(root) } }),
      at: (root: string) => spaced(root),
    },
    {
      name: "a whitespace-only host home",
      follow: () => ({ host: { CODEX_HOME: " " } }),
      at: () => " ",
    },
    {
      name: "a host home starting with ~/",
      follow: () => ({ host: { CODEX_HOME: "~/account" } }),
      at: () => "~/account",
    },
    {
      name: "a HOME override without CODEX_HOME",
      follow: (root: string) => ({
        host: { HOME: `${root}/b`, USERPROFILE: `${root}/b` },
      }),
      at: (root: string) => `${root}/b/.codex`,
    },
    {
      name: "the default home with no override",
      follow: (root: string) => ({ host: { HOME: root, USERPROFILE: root } }),
      at: (root: string) => `${root}/.codex`,
    },
    {
      name: "an instance's own CODEX_HOME",
      follow: (root: string) => ({
        host: {},
        environment: [{ name: "CODEX_HOME", value: `${root}/own`, sensitive: false }],
      }),
      at: (root: string) => `${root}/own`,
    },
    {
      name: "a shadow home",
      follow: (root: string) => ({
        host: {},
        homePath: `${root}/shared`,
        shadowHomePath: `${root}/shadow`,
      }),
      at: (root: string) => `${root}/shadow`,
    },
    {
      name: "a link to the same directory",
      posixOnly: true,
      follow: (root: string) => ({ host: { CODEX_HOME: `${root}/current` } }),
      at: (root: string) => `${root}/vault/acct`,
    },
    {
      name: "a link followed by ..",
      posixOnly: true,
      follow: (root: string) => ({ host: { CODEX_HOME: `${root}/alias/../acct` } }),
      at: (root: string) => `${root}/vault/acct`,
    },
  ])("$name shares a lock with an instance pinned to the same directory", (testCase) =>
    Effect.gen(function* () {
      if (testCase.posixOnly === true && windowsHost) return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* aliasedHomes(root);
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled"]);
      const follow: {
        readonly host: NodeJS.ProcessEnv;
        readonly environment?: ProviderInstanceEnvironment;
        readonly homePath?: string;
        readonly shadowHomePath?: string;
      } = testCase.follow(root);
      const following = yield* createInstance({
        id: "following",
        root,
        coordinator: service,
        ...follow,
        host: { PATH: "", ...follow.host },
      });
      const pinned = yield* createInstance({
        id: "pinned",
        root,
        host: { PATH: "" },
        homePath: path.resolve(testCase.at(root)),
        coordinator: service,
      });
      yield* following.consumeResetCredit!().pipe(Effect.exit);
      yield* pinned.consumeResetCredit!().pipe(Effect.exit);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    }).pipe(Effect.scoped),
  );

  it.effect("a redemption refused at the account limit tells the person why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      for (let index = 0; index < ResetCreditCoordinator.MAX_TRACKED_ACCOUNTS; index += 1) {
        yield* coordinator
          .redeem(`${root}/uncertain-${index}`, () => Effect.fail("timed out" as const))
          .pipe(Effect.result);
      }
      const instance = yield* createInstance({
        id: "limit",
        root,
        host: { PATH: "" },
        homePath: `${root}/home`,
      });
      const error = yield* instance.consumeResetCredit!().pipe(Effect.flip);
      expect(error.detail).toBe(new ResetCreditCoordinator.ResetCreditAccountLimitError().message);
    }).pipe(Effect.scoped),
  );
});

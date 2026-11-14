import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderInstanceEnvironment } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ChildProcess } from "effect/process";

import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** A fresh coordinator whose redemptions follow `script`: "uncertain" keeps the key pending. */
const scriptedCoordinator = (script: Array<"uncertain" | "settled">) =>
  Effect.gen(function* () {
    const real = yield* freshCoordinator;
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

const freshCoordinator = Effect.service(ResetCreditCoordinator.ResetCreditCoordinator).pipe(
  Effect.provide(ResetCreditCoordinator.layerTest),
);

interface InstanceForm {
  readonly host: NodeJS.ProcessEnv;
  readonly environment?: ProviderInstanceEnvironment;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
}

const createInstance = (
  input: InstanceForm & {
    readonly id: string;
    readonly root: string;
    readonly coordinator: ResetCreditCoordinator.ResetCreditCoordinator["Service"];
    readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly enabled?: boolean;
  },
) =>
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
    Effect.provideService(ResetCreditCoordinator.ResetCreditCoordinator, input.coordinator),
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
  });

/** A codex on PATH that exits at once, so checks and redemptions launch it and fail fast. */
const fixtureCodex = (root: string, body = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${root}/bin`);
    yield* fs.writeFileString(`${root}/bin/codex`, `#!/bin/sh\n${body}`);
    yield* fs.chmod(`${root}/bin/codex`, 0o755);
    return `${root}/bin`;
  });

/** The CODEX_HOME each status-check launch got, and the one the redemption got. */
const launchedHomes = (root: string, form: InstanceForm) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bin = yield* fixtureCodex(root);
    const homes: Array<string | undefined> = [];
    const observed = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) homes.push(command.options.env?.CODEX_HOME);
      return spawner.spawn(command);
    });
    const instance = yield* createInstance({
      id: "launch-homes",
      root,
      ...form,
      host: { ...form.host, PATH: bin },
      coordinator: yield* freshCoordinator,
      spawner: observed,
    });
    const before = homes.length;
    yield* instance.snapshot.refresh;
    const status = homes.slice(before);
    const atRedeem = homes.length;
    yield* instance.consumeResetCredit!(undefined).pipe(Effect.exit);
    return { status, redemption: homes.slice(atRedeem) };
  }).pipe(Effect.provideService(HostProcess.HomeDirectory, root));

const expectSameHome = (homes: {
  readonly status: ReadonlyArray<string | undefined>;
  readonly redemption: ReadonlyArray<string | undefined>;
}) => {
  expect(homes.status.length).toBeGreaterThan(0);
  expect(new Set(homes.status).size).toBe(1);
  expect(homes.redemption).toEqual([homes.status[0]]);
};

it.layer(layerTest)("CodexDriver reset credits", (it) => {
  for (const { name, form } of [
    { name: "an unset CODEX_HOME", form: () => ({ host: {} }) },
    { name: "an empty CODEX_HOME", form: () => ({ host: { CODEX_HOME: "" } }) },
    { name: "a whitespace-only CODEX_HOME", form: () => ({ host: { CODEX_HOME: " " } }) },
    {
      name: "a CODEX_HOME ending in a space",
      form: (root: string) => ({ host: { CODEX_HOME: `${root}/user ` } }),
    },
    { name: "a CODEX_HOME starting with ~/", form: () => ({ host: { CODEX_HOME: "~/x" } }) },
    { name: "a relative CODEX_HOME", form: () => ({ host: { CODEX_HOME: "rel/home" } }) },
    {
      name: "an absolute CODEX_HOME",
      form: (root: string) => ({ host: { CODEX_HOME: `${root}/abs` } }),
    },
    {
      name: "the instance's own CODEX_HOME",
      form: (root: string) => ({
        host: {},
        environment: [{ name: "CODEX_HOME", value: `${root}/own`, sensitive: false }],
      }),
    },
    {
      name: "a configured home",
      form: (root: string) => ({ host: {}, homePath: `${root}/configured` }),
    },
    {
      name: "a shadow home",
      form: (root: string) => ({
        host: {},
        homePath: `${root}/shared`,
        shadowHomePath: `${root}/shadow`,
      }),
    },
    {
      name: "an instance HOME override",
      form: (root: string) => ({
        host: { HOME: root },
        environment: [{ name: "HOME", value: `${root}/b`, sensitive: false }],
      }),
    },
  ] satisfies ReadonlyArray<{ name: string; form: (root: string) => InstanceForm }>) {
    // The fixture codex is a POSIX shell script, which Windows cannot run.
    it.effect.skipIf(windowsHost)(
      `for ${name} the redemption launches under the home a status check uses`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          expectSameHome(yield* launchedHomes(root, form(root)));
        }).pipe(Effect.scoped),
    );
  }

  for (const { name, home } of [
    { name: "a link followed by ..", home: (root: string) => `${root}/alias/../acct` },
    { name: "a link to the home", home: (root: string) => `${root}/current` },
  ]) {
    // The fixture codex is a POSIX shell script and the homes use symlinks.
    it.effect.skipIf(windowsHost)(
      `for ${name} the redemption launches under the home a status check uses`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          yield* aliasedHomes(root);
          expectSameHome(yield* launchedHomes(root, { host: { CODEX_HOME: home(root) } }));
        }).pipe(Effect.scoped),
    );
  }

  // The fixture codex is a POSIX shell script that reports what it received.
  it.effect.skipIf(windowsHost)(
    "a variable the server's environment gains after capture does not reach the redemption",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const report = `${root}/received`;
        const bin = yield* fixtureCodex(
          root,
          `printf '%s\\n' "\${GOAT_LATE_PROBE-unset}" "\${CODEX_HOME-unset}" > '${report}'\n`,
        );
        const real = yield* freshCoordinator;
        // Between capture and launch: the point where an inherited environment would pick it up.
        const coordinator = ResetCreditCoordinator.ResetCreditCoordinator.of({
          redeem: (accountKey, consume, isSettled) =>
            Effect.sync(() => {
              process.env.GOAT_LATE_PROBE = "late";
            }).pipe(Effect.andThen(real.redeem(accountKey, consume, isSettled))),
        });
        const instance = yield* createInstance({
          id: "late-variable",
          root,
          host: { PATH: bin, CODEX_HOME: `${root}/home` },
          coordinator,
          enabled: false,
        });
        yield* instance.consumeResetCredit!(undefined).pipe(
          Effect.exit,
          Effect.ensuring(
            Effect.sync(() => {
              delete process.env.GOAT_LATE_PROBE;
            }),
          ),
        );
        const [late, home] = (yield* fs.readFileString(report)).split("\n");
        expect(late).toBe("unset");
        expect(home).toBe(`${root}/home`);
      }).pipe(Effect.scoped),
  );

  it.effect("two homes that differ only by a trailing space are separate accounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled", "settled"]);
      const host: NodeJS.ProcessEnv = { PATH: "", CODEX_HOME: `${root}/a` };
      const instance = yield* createInstance({ id: "spaced", root, host, coordinator: service });
      yield* instance.consumeResetCredit!(undefined).pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a `;
      yield* instance.consumeResetCredit!(undefined).pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a`;
      yield* instance.consumeResetCredit!(undefined).pipe(Effect.exit);
      expect(keys).toHaveLength(3);
      const [first, other, retry] = keys;
      expect(other).not.toBe(first);
      expect(retry).toBe(first);
    }).pipe(Effect.scoped),
  );

  /** The idempotency keys of a redemption under `follow` and one pinned to `pinnedAt`. */
  const sharedKeys = (root: string, follow: InstanceForm, pinnedAt: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled"]);
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
        homePath: path.resolve(pinnedAt),
        coordinator: service,
      });
      yield* following.consumeResetCredit!(undefined).pipe(Effect.exit);
      yield* pinned.consumeResetCredit!(undefined).pipe(Effect.exit);
      expect(keys).toHaveLength(2);
      return keys;
    });

  // Each form keys the directory a status check uses for it.
  it.effect.each([
    {
      name: "a host home ending in a space",
      follow: (root: string) => ({ host: { CODEX_HOME: `${root}/user ` } }),
      at: (root: string) => `${root}/user `,
    },
    {
      name: "a whitespace-only host home",
      follow: () => ({ host: { CODEX_HOME: " " } }),
      at: () => " ",
    },
    {
      name: "a host home starting with ~/",
      follow: () => ({ host: { CODEX_HOME: "~/account" } }),
      at: (root: string) => `${root}/account`,
    },
    {
      name: "a host HOME without CODEX_HOME",
      follow: (root: string) => ({ host: { HOME: `${root}/b` } }),
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
  ])("$name shares a lock with an instance pinned to the same directory", ({ follow, at }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const keys = yield* sharedKeys(root, follow(root), at(root));
      expect(keys[1]).toBe(keys[0]);
    }).pipe(Effect.scoped),
  );

  for (const { name, home, at } of [
    {
      name: "a link to the home",
      home: (root: string) => `${root}/current`,
      at: (root: string) => `${root}/vault/acct`,
    },
    {
      name: "a link followed by .., as status resolves it",
      home: (root: string) => `${root}/alias/../acct`,
      at: (root: string) => `${root}/acct`,
    },
  ]) {
    // The homes use symlinks.
    it.effect.skipIf(windowsHost)(
      `${name} shares a lock with an instance pinned to the same directory`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          yield* aliasedHomes(root);
          const keys = yield* sharedKeys(root, { host: { CODEX_HOME: home(root) } }, at(root));
          expect(keys[1]).toBe(keys[0]);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("a redemption refused at the account limit tells the person why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const coordinator = yield* freshCoordinator;
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
        coordinator,
      });
      const error = yield* instance.consumeResetCredit!(undefined).pipe(Effect.flip);
      expect(error.detail).toBe(new ResetCreditCoordinator.ResetCreditAccountLimitError().message);
    }).pipe(Effect.scoped),
  );
});

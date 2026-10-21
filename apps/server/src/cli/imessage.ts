// @effect-diagnostics nodeBuiltinImport:off -- local CLI manages one versioned file and ID.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { AuthOrchestrationOperateScope, EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as ChannelIdentityService from "../channels/ChannelIdentityService.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import { channelOwnerIdFor } from "../channels/channelOwner.ts";
import {
  IMESSAGE_SETTINGS_FILE,
  ImessageSettingsFile,
  normalizeHandle,
  validateImessageSettings,
} from "../channels/imessage/ImessageChannelSettings.ts";
import { openImessageChatDb, type ImessageDbError } from "../channels/imessage/imessageChatDb.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ImessageSettingsFile));
const encode = Schema.encodeSync(Schema.fromJsonString(ImessageSettingsFile));

export async function readImessageFile(
  stateDir: string,
): Promise<ImessageSettingsFile | undefined> {
  try {
    return decode(await NodeFSP.readFile(NodePath.join(stateDir, IMESSAGE_SETTINGS_FILE), "utf8"));
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw new Error("iMessage settings cannot be read or are invalid", { cause });
  }
}

async function writeImessageFile(stateDir: string, file: ImessageSettingsFile): Promise<void> {
  if (validateImessageSettings(file) === undefined) throw new Error("Invalid iMessage settings");
  await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = NodePath.join(stateDir, IMESSAGE_SETTINGS_FILE);
  const temp = path + "." + NodeCrypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    await NodeFSP.writeFile(temp, encode(file), { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temp, path);
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
}

export async function enableImessage(input: {
  readonly stateDir: string;
  readonly environmentId: EnvironmentId;
  readonly allow: ReadonlyArray<string>;
  readonly own: ReadonlyArray<string>;
  readonly fullAccess: boolean;
}): Promise<ImessageSettingsFile> {
  const old = await readImessageFile(input.stateDir);
  const allowedHandles = input.allow.map(normalizeHandle);
  const ownHandles = input.own.map(normalizeHandle);
  if (
    allowedHandles.some((value) => value === undefined) ||
    ownHandles.some((value) => value === undefined)
  )
    throw new Error("Invalid iMessage handle");
  const file: ImessageSettingsFile = {
    version: 1,
    enabled: true,
    connectionId: old?.connectionId ?? "imessage-" + NodeCrypto.randomBytes(6).toString("hex"),
    allowedHandles: allowedHandles as string[],
    ownHandles: ownHandles as string[],
    owner: {
      ownerId: channelOwnerIdFor(input.environmentId),
      principalId: "local-cli",
      displayName: "Owner",
      grantedScopes: [AuthOrchestrationOperateScope],
      runtimeModeCeiling: input.fullAccess ? "full-access" : "approval-required",
    },
  };
  await writeImessageFile(input.stateDir, file);
  return file;
}

export async function disableImessage(stateDir: string): Promise<void> {
  const old = await readImessageFile(stateDir);
  if (old === undefined) throw new Error("iMessage is not configured");
  await writeImessageFile(stateDir, { ...old, enabled: false });
}

const envHome = Config.String("GOAT_HOME").pipe(Config.option);
const paths = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const home = yield* envHome;
    const configured = Option.orElse(baseDir, () => home);
    const base = yield* resolveBaseDir(Option.getOrUndefined(configured));
    return yield* ServerConfig.deriveServerPaths(base, undefined, {
      baseDirIsExplicit: Option.isSome(configured),
    });
  });

const environmentId = (stateDir: string) =>
  Effect.promise(async () => {
    const path = NodePath.join(stateDir, "environment-id");
    try {
      return EnvironmentId.make((await NodeFSP.readFile(path, "utf8")).trim());
    } catch (cause) {
      if (
        !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
      const generated = NodeCrypto.randomUUID();
      // A fresh GOAT home has no userdata directory until the server first starts.
      await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
      try {
        await NodeFSP.writeFile(path, generated, { mode: 0o600, flag: "wx" });
      } catch (writeCause) {
        if (
          !(
            typeof writeCause === "object" &&
            writeCause !== null &&
            "code" in writeCause &&
            writeCause.code === "EEXIST"
          )
        )
          throw writeCause;
      }
      return EnvironmentId.make((await NodeFSP.readFile(path, "utf8")).trim());
    }
  });

const ledgerLayer = (dbPath: string) =>
  ChannelLedger.layer.pipe(Layer.provide(SqlitePersistence.layerFromPath(dbPath)));
const identityLayer = (dbPath: string) =>
  ChannelIdentityService.layer.pipe(
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provide(SqlitePersistence.layerFromPath(dbPath)),
  );

export const formatImessageStatus = (input: {
  readonly enabled: boolean;
  readonly mac: boolean;
  readonly allowedCount: number;
  readonly cursor: number | undefined;
  readonly database: string;
}) =>
  `enabled=${input.enabled} mac=${input.mac} allowed=${input.allowedCount} cursor=${input.cursor ?? "unset"} database=${input.database}`;

const enableCommand = Command.make("enable", {
  baseDir: baseDirFlag,
  allow: Flag.String("allow").pipe(Flag.atLeast(1)),
  own: Flag.String("own").pipe(Flag.atLeast(0)),
  fullAccess: Flag.Boolean("full-access").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* paths(flags.baseDir);
      const id = yield* environmentId(target.stateDir);
      yield* Effect.promise(() =>
        enableImessage({
          stateDir: target.stateDir,
          environmentId: id,
          allow: flags.allow,
          own: flags.own,
          fullAccess: flags.fullAccess,
        }),
      );
      yield* Console.log("iMessage enabled. Restart the server if it is already running.");
    }),
  ),
);

const disableCommand = Command.make("disable", { baseDir: baseDirFlag }).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* paths(flags.baseDir);
      yield* Effect.promise(() => disableImessage(target.stateDir));
      yield* Console.log("iMessage disabled.");
    }),
  ),
);

const statusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* paths(flags.baseDir);
      const file = yield* Effect.promise(() => readImessageFile(target.stateDir));
      const platform = yield* HostProcess.Platform;
      const configured = file === undefined ? undefined : validateImessageSettings(file);
      const enabled = platform === "darwin" && file?.enabled === true && configured !== undefined;
      const cursor =
        configured === undefined
          ? undefined
          : yield* ChannelLedger.ChannelLedger.pipe(
              Effect.flatMap((ledger) => ledger.getImessageCursor(configured.connectionId)),
              Effect.provide(ledgerLayer(target.dbPath)),
            );
      let database: string =
        file !== undefined && configured === undefined ? "invalid_settings" : "not_checked";
      if (enabled) {
        const probe = yield* Effect.result(
          Effect.try({
            try: () => {
              const db = openImessageChatDb(
                NodePath.join(NodeOS.homedir(), "Library/Messages/chat.db"),
              );
              try {
                db.maxRowId();
              } finally {
                db.close();
              }
            },
            catch: (cause) => cause as ImessageDbError,
          }),
        );
        database =
          probe._tag === "Success"
            ? "available"
            : (probe.failure.category ?? "database_unavailable");
      }
      yield* Console.log(
        formatImessageStatus({
          enabled,
          mac: platform === "darwin",
          allowedCount: configured?.allowedHandles.size ?? 0,
          cursor: cursor?.cursor,
          database,
        }),
      );
    }),
  ),
);

const linkCodeCommand = Command.make("link-code", {
  baseDir: baseDirFlag,
  ttl: Flag.Int("ttl").pipe(Flag.withDefault(600)),
}).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* paths(flags.baseDir);
      const file = yield* Effect.promise(() => readImessageFile(target.stateDir));
      if (file === undefined || !file.enabled || flags.ttl <= 0)
        throw new Error("iMessage is not enabled or TTL is invalid");
      const linked = yield* ChannelIdentityService.ChannelIdentityService.pipe(
        Effect.flatMap((service) =>
          service.createLink(
            {
              connectionId: file.connectionId,
              runtimeModeCeiling: file.owner.runtimeModeCeiling,
              grantedScopes: file.owner.grantedScopes,
              expiresInSeconds: flags.ttl,
            },
            file.owner,
          ),
        ),
        Effect.provide(identityLayer(target.dbPath)),
      );
      yield* Console.log(linked.code);
    }),
  ),
);

const unlinkCommand = Command.make("unlink", {
  baseDir: baseDirFlag,
  handle: Argument.String("handle"),
}).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* paths(flags.baseDir);
      const file = yield* Effect.promise(() => readImessageFile(target.stateDir));
      const handle = normalizeHandle(flags.handle);
      if (file === undefined || handle === undefined)
        throw new Error("iMessage connection or handle invalid");
      yield* ChannelIdentityService.ChannelIdentityService.pipe(
        Effect.flatMap((service) =>
          service.unlink({ connectionId: file.connectionId, externalActorId: handle }),
        ),
        Effect.provide(identityLayer(target.dbPath)),
      );
      yield* Console.log("iMessage identity unlinked.");
    }),
  ),
);

export const imessageCommand = Command.make("imessage").pipe(
  Command.withDescription("Manage a local Mac iMessage channel."),
  Command.withSubcommands([
    enableCommand,
    disableCommand,
    statusCommand,
    linkCodeCommand,
    unlinkCommand,
  ]),
);

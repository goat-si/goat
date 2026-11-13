// @effect-diagnostics-next-line nodeBuiltinImport:off -- a temporary key name per creation.
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../../config.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";

/** The hub's own key for disposable machines: GOAT's private file and the line a machine trusts. */
export interface MachineIdentity {
  readonly privateKeyFile: string;
  /** "ssh-ed25519 <base64> goat-disposable", for the machine user's authorized_keys. */
  readonly publicLine: string;
}

export class MachineKeyError extends Data.TaggedError("MachineKeyError")<{
  readonly message: string;
}> {}

/** One ed25519 key per hub, made once and never rewritten; the person's own ssh keys are never used. */
export class MachineKey extends Context.Service<
  MachineKey,
  {
    /** The key, made on first use. */
    readonly identity: Effect.Effect<MachineIdentity, MachineKeyError>;
    /** The key if it was made; a read never makes one. */
    readonly known: Effect.Effect<MachineIdentity | undefined>;
  }
>()("goat/hub/disposable/machineKey") {}

const COMMENT = "goat-disposable";
const PUBLIC_LINE = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/u;
/** The public line ssh-keygen wrote, with GOAT's comment; undefined for anything else. */
const machinePublicLine = (text: string) => {
  const [type, blob] = text.trim().split(" ");
  const line = type + " " + blob;
  return PUBLIC_LINE.test(line) ? line + " " + COMMENT : undefined;
};

/**
 * Makes the key with ssh-keygen in GOAT's state folder (0700), under a lock so two first uses make
 * one key. An existing private key is kept and checked; its public line is derived from it.
 */
export const make = Effect.fn("MachineKey.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const once = (yield* Semaphore.make(1)).withPermits(1);
  const privateKeyFile = path.join(directory, "machine_ed25519");
  const failed = (message: string) => () => new MachineKeyError({ message });
  const keygen = (args: ReadonlyArray<string>) =>
    runner
      .run({ command: "ssh-keygen", args, timeout: "30 seconds", maxOutputBytes: 64 * 1024 })
      .pipe(
        Effect.filterOrFail((output) => output.code === 0, failed("ssh-keygen failed.")),
        Effect.mapError(failed("ssh-keygen could not make the machine key.")),
      );
  const readPublic = fs.readFileString(privateKeyFile + ".pub").pipe(
    Effect.map(machinePublicLine),
    Effect.orElseSucceed(() => undefined),
  );
  // A key that passed its checks once is the hub's key for the life of this server.
  const verified = yield* Ref.make<string | undefined>(undefined);
  const swept = yield* Ref.make(false);
  /** The private key must be ours alone and an ed25519 key; its public half is rebuilt from it. */
  const verify = Effect.gen(function* () {
    const cached = yield* Ref.get(verified);
    if (cached !== undefined) return cached;
    if ((Number((yield* fs.stat(privateKeyFile)).mode) & 0o077) !== 0)
      return yield* failed("Others can read the machine key, so GOAT does not use it.")();
    const line = machinePublicLine((yield* keygen(["-y", "-f", privateKeyFile])).stdout);
    if (line === undefined) return yield* failed("The machine key is not an ed25519 key.")();
    if ((yield* readPublic) !== line)
      yield* fs.writeFileString(privateKeyFile + ".pub", line + "\n", { mode: 0o644 });
    yield* Ref.set(verified, line);
    return line;
  });
  const create = Effect.gen(function* () {
    // An unanswerable check fails closed: a key GOAT cannot see is never replaced.
    // A key a crash left half made is never used; the first create of each run removes it.
    if (!(yield* Ref.getAndSet(swept, true)) && (yield* fs.exists(directory)))
      for (const name of yield* fs.readDirectory(directory))
        if (name.startsWith("machine_ed25519.new-"))
          yield* Effect.ignore(fs.remove(path.join(directory, name)));
    if (!(yield* fs.exists(privateKeyFile))) {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      // The checked line belonged to the key that is gone.
      yield* Ref.set(verified, undefined);
      const temporary = privateKeyFile + ".new-" + NodeCrypto.randomUUID();
      yield* keygen(["-q", "-t", "ed25519", "-N", "", "-C", COMMENT, "-f", temporary]);
      yield* fs.chmod(temporary, 0o600);
      // link refuses an existing name, so a key made meanwhile is never overwritten.
      yield* fs.link(temporary, privateKeyFile);
      yield* Effect.ignore(fs.remove(temporary));
      yield* Effect.ignore(fs.remove(temporary + ".pub"));
    }
    return yield* verify;
  }).pipe(
    Effect.catchTags({ PlatformError: failed("GOAT could not read or store its machine key.") }),
    once,
  );
  const known = Effect.gen(function* () {
    if (!(yield* fs.exists(privateKeyFile))) return undefined;
    return { privateKeyFile, publicLine: yield* once(verify) };
  }).pipe(Effect.orElseSucceed(() => undefined));
  return MachineKey.of({
    known,
    identity: Effect.map(create, (publicLine) => ({ privateKeyFile, publicLine })).pipe(
      Effect.withSpan("MachineKey.identity"),
    ),
  });
});

export const layer = Layer.effect(
  MachineKey,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, "disposable"));
  }),
);

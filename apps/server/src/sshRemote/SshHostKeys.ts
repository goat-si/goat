import { probeHostKey } from "@goat/ssh/hostKey";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

/**
 * The SSH host key a destination negotiates now, trusted or not, read with a disposable
 * known_hosts. Kept-machine route paths compare it with disposable machines' sshd pins.
 */
export class SshHostKeys extends Context.Service<
  SshHostKeys,
  {
    /** The SHA256 fingerprint; undefined when the destination cannot be probed. */
    readonly negotiatedFingerprint: (target: {
      readonly alias: string;
      readonly username: string | null;
      readonly port: number | null;
    }) => Effect.Effect<string | undefined>;
  }
>()("goat/sshRemote/SshHostKeys") {}

export const layer = Layer.effect(
  SshHostKeys,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    return SshHostKeys.of({
      negotiatedFingerprint: Effect.fn("SshHostKeys.negotiatedFingerprint")(function* (target) {
        const key = yield* probeHostKey({
          target: target.alias,
          ...(target.username === null ? {} : { user: target.username }),
          ...(target.port === null ? {} : { port: target.port }),
        }).pipe(Effect.provide(services), Effect.option);
        return key._tag === "Some" ? key.value.fingerprint : undefined;
      }),
    });
  }),
);

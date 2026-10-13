// @effect-diagnostics nodeBuiltinImport:off -- Node crypto provides timingSafeEqual for the host-control credential.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";

export class RuntimeControlPersistenceError extends Schema.TaggedError<RuntimeControlPersistenceError>()(
  "RuntimeControlPersistenceError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to initialize the runtime control token.";
  }
}

export class RuntimeControl extends Context.Service<
  RuntimeControl,
  { readonly authenticate: (token: string | undefined) => boolean }
>()("goat/runtimeControl") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const tokenPath = path.join(path.dirname(config.serverRuntimeStatePath), "runtime-control.token");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({
        directory: path.dirname(tokenPath),
        prefix: ".runtime-control-",
      });
      // The temporary file is empty until its permissions are private.
      yield* fs.chmod(temporary, 0o600);
      yield* fs.writeFileString(temporary, `${token}\n`);
      yield* fs.rename(temporary, tokenPath);
    }),
  ).pipe(
    Effect.mapError((cause) => new RuntimeControlPersistenceError({ path: tokenPath, cause })),
  );
  const secret = Buffer.from(token);
  return RuntimeControl.of({
    authenticate: (candidate) => {
      if (candidate === undefined) return false;
      const received = Buffer.from(candidate);
      return received.length === secret.length && NodeCrypto.timingSafeEqual(received, secret);
    },
  });
});

export const layer = Layer.effect(RuntimeControl, make);

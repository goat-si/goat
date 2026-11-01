import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@goat/shared/HostProcess";
import { TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";

const Auth = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(Auth));
const encodeAuth = Schema.encodeSync(Schema.fromJsonString(Auth));

/** Config discovery also walks ancestors and reads system/MDM policy outside HOME/XDG.
 * Sources: OpenCode v1.17.5 config/{paths,managed}.ts and v2 core/config/discovery.ts.
 * Refuse those sources before starting a server; copy only the selected API/OAuth credential.
 */
export const prepareMemoryServer = Effect.fn("OpenCode.prepareMemoryServer")(function* (
  operation: MemoryOperationName,
  providerId: string,
  baseEnvironment: NodeJS.ProcessEnv,
  version: 1 | 2,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const failure = new TextGenerationError({
    operation,
    detail: "OpenCode memory configuration, plugins or credentials could not be isolated.",
    cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
  });
  return yield* Effect.gen(function* () {
    // Windows keeps TEMP under the user's home, so the ancestor walk below would find the
    // user's own .claude or .agents there and refuse every time. %SystemRoot%\Temp lets each
    // user create private folders outside any home; when it can't, the walk still guards.
    const outsideHome =
      platform === "win32"
        ? yield* fs
            .makeTempDirectoryScoped({
              prefix: "goat-opencode-memory-",
              directory: path.join(
                baseEnvironment.SystemRoot ||
                  baseEnvironment.SYSTEMROOT ||
                  baseEnvironment.windir ||
                  baseEnvironment.WINDIR ||
                  "C:\\Windows",
                "Temp",
              ),
            })
            .pipe(Effect.option)
        : Option.none();
    // Discovery resolves symlinks before walking ancestors (macOS /var -> /private/var).
    const root = yield* fs.realPath(
      Option.isSome(outsideHome)
        ? outsideHome.value
        : yield* fs.makeTempDirectoryScoped({ prefix: "goat-opencode-memory-" }),
    );
    const directory = path.join(root, "work");
    const system =
      platform === "darwin"
        ? "/Library/Application Support/opencode"
        : platform === "win32"
          ? path.join(baseEnvironment.ProgramData || "C:\\ProgramData", "opencode")
          : "/etc/opencode";
    // An MDM policy cannot be relocated by changing the child's HOME.
    const policies = [system];
    if (platform === "darwin") {
      const managed = "/Library/Managed Preferences";
      if (yield* fs.exists(managed)) {
        policies.push(path.join(managed, "ai.opencode.managed.plist"));
        for (const entry of yield* fs.readDirectory(managed))
          policies.push(path.join(managed, entry, "ai.opencode.managed.plist"));
      }
    }
    for (const source of policies) if (yield* fs.exists(source)) return yield* failure;
    let ancestor = path.dirname(root);
    while (true) {
      for (const name of ["opencode.json", "opencode.jsonc", ".opencode", ".claude", ".agents"])
        if (yield* fs.exists(path.join(ancestor, name))) return yield* failure;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    for (const name of ["work", "home", "config", "data/opencode", "cache", "state", "tmp"])
      yield* fs.makeDirectory(path.join(root, name), { recursive: true });
    const environment: NodeJS.ProcessEnv = {};
    // No inherited config, preload, plugin, well-known auth or shell startup variables.
    const credentialKeys: Record<string, readonly string[]> = {
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      xai: ["XAI_API_KEY"],
      opencode: ["OPENCODE_API_KEY"],
    };
    const selectedKeys = credentialKeys[providerId] ?? [];
    // V2 credentials live in its database. Never copy the database (it also owns config/plugin
    // state); without an API key there is no certified credential-only migration here.
    if (
      version === 2 &&
      providerId !== "opencode" &&
      !selectedKeys.some((key) => baseEnvironment[key])
    )
      return yield* failure;
    for (const key of [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "PATHEXT",
      "LANG",
      "LC_ALL",
      ...selectedKeys,
    ])
      if (baseEnvironment[key] !== undefined) environment[key] = baseEnvironment[key];
    Object.assign(environment, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      OPENCODE_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TEMP: path.join(root, "tmp"),
      OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
      OPENCODE_CONFIG: path.join(root, "config", "opencode", "opencode.json"),
      OPENCODE_CONFIG_CONTENT:
        version === 1
          ? '{"plugin":[],"mcp":{},"permission":{"*":"deny"}}'
          : '{"plugins":[],"mcp":{"servers":{}}}',
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_PURE: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "config", "managed"),
    });
    yield* fs.makeDirectory(environment.OPENCODE_CONFIG_DIR!, { recursive: true });
    yield* fs.writeFileString(
      environment.OPENCODE_CONFIG!,
      version === 1
        ? '{"plugin":[],"mcp":{},"permission":{"*":"deny"}}'
        : '{"plugins":[],"mcp":{"servers":{}}}',
    );
    if (version === 1) {
      const authPath = path.join(
        baseEnvironment.XDG_DATA_HOME || path.join(baseEnvironment.HOME || home, ".local", "share"),
        "opencode",
        "auth.json",
      );
      if (yield* fs.exists(authPath)) {
        const credentials = yield* decodeAuth(yield* fs.readFileString(authPath));
        const credential = credentials[providerId];
        if (credential !== undefined) {
          if (
            !credential ||
            typeof credential !== "object" ||
            !("type" in credential) ||
            (credential.type !== "api" && credential.type !== "oauth")
          )
            return yield* failure;
          const destination = path.join(root, "data", "opencode", "auth.json");
          yield* fs.writeFileString(destination, encodeAuth({ [providerId]: credential }));
          yield* fs.chmod(destination, 0o600);
        }
      }
    }
    return { directory, environment };
  }).pipe(Effect.mapError(() => failure));
});

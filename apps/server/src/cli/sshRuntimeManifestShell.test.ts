import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import * as Schema from "effect/Schema";
import { RuntimeManifest, ownRuntimeManifest } from "@goat/shared/runtimeManifest";
import packageJson from "../../package.json" with { type: "json" };
import { BUILD_COMMIT_TIME } from "../buildCommitTime.ts";
import { protocol, runtimeManifest } from "./sshRuntimeProbes.ts";

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(RuntimeManifest));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(RuntimeManifest));

it.effect("manifest shell preserves executable own protocol tokens", () =>
  Effect.gen(function* () {
    using write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = Command.make("goat").pipe(
      Command.withSubcommands([
        Command.make("__ssh-helper").pipe(Command.withSubcommands([protocol, runtimeManifest])),
      ]),
    );
    const run = (args: string[]) =>
      Command.runWith(root, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer));
    yield* run(["__ssh-helper", "protocol", "--shell"]);
    const own = write.mock.calls
      .map(([value]) => String(value))
      .join("")
      .trim()
      .split(" ");
    write.mockClear();
    yield* run(["__ssh-helper", "runtime-manifest", "--shell"]);
    const manifest = write.mock.calls
      .map(([value]) => String(value))
      .join("")
      .trim()
      .split(" ");
    expect(manifest).toHaveLength(5);
    expect(manifest.slice(0, 3)).toEqual(own.slice(0, 3));
    expect(manifest[3]).toMatch(/^(0|[1-9][0-9]*)$/u);
    expect(manifest[4]).toBe("has");
  }),
);

it.effect("manifest without shell keeps the existing JSON output", () =>
  Effect.gen(function* () {
    using write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = Command.make("goat").pipe(Command.withSubcommands([runtimeManifest]));
    yield* Command.runWith(root, { version: "test" })(["runtime-manifest"]).pipe(
      Effect.provide(NodeServices.layer),
    );
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    const manifest = yield* decodeManifest(output);
    expect(manifest).toMatchObject(
      ownRuntimeManifest({ version: packageJson.version, commitTime: BUILD_COMMIT_TIME }),
    );
    expect(output).toBe(encodeManifest(manifest) + "\n");
  }),
);

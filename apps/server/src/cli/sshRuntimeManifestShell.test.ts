import { expect, it, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { protocol, runtimeManifest } from "./sshRuntimeProbes.ts";

it("manifest shell preserves executable own protocol tokens", async () => {
  using write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = Command.make("goat").pipe(
    Command.withSubcommands([
      Command.make("__ssh-helper").pipe(Command.withSubcommands([protocol, runtimeManifest])),
    ]),
  );
  const run = (args: string[]) =>
    Effect.runPromise(
      Command.runWith(root, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
    );
  await run(["__ssh-helper", "protocol", "--shell"]);
  const own = write.mock.calls
    .map(([value]) => String(value))
    .join("")
    .trim()
    .split(" ");
  write.mockClear();
  await run(["__ssh-helper", "runtime-manifest", "--shell"]);
  const manifest = write.mock.calls
    .map(([value]) => String(value))
    .join("")
    .trim()
    .split(" ");
  expect(manifest).toHaveLength(5);
  expect(manifest.slice(0, 3)).toEqual(own.slice(0, 3));
  expect(manifest[3]).toMatch(/^(0|[1-9][0-9]*)$/u);
  expect(manifest[4]).toBe("has");
});

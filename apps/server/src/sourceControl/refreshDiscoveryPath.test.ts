import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { refreshDiscoveryPath } from "./refreshDiscoveryPath.ts";

if (HostProcess.Platform.defaultValue() !== "win32") {
  it.live("finds a newly installed tool through the login shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-discovery-shell-" });
        const bin = path.join(root, "bin");
        const shell = path.join(root, "loginsh");
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(path.join(bin, "jj"), "#!/bin/sh\necho jj-0.99-test\n", {
          mode: 0o755,
        });
        yield* fs.writeFileString(
          shell,
          `#!/bin/sh\nexport PATH="${bin}:$PATH"\nshift\nexec /bin/sh -c "$1"\n`,
          { mode: 0o755 },
        );
        const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
        const process = yield* VcsProcess.VcsProcess;
        yield* refreshDiscoveryPath(process, root).pipe(
          Effect.provideService(HostProcess.Environment, env),
        );
        const output = yield* process.run({
          operation: "discovery-test",
          command: "jj",
          args: ["--version"],
          cwd: root,
          env,
        });
        expect(output.stdout.trim()).toBe("jj-0.99-test");
      }),
    ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it.live("keeps PATH unchanged when the login shell fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-discovery-shell-" });
        const shell = path.join(root, "loginsh");
        yield* fs.writeFileString(shell, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
        const process = yield* VcsProcess.VcsProcess;
        yield* refreshDiscoveryPath(process, root).pipe(
          Effect.provideService(HostProcess.Environment, env),
        );
        expect(env.PATH).toBe("/usr/bin:/bin");
      }),
    ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

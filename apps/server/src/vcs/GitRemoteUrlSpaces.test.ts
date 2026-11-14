import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { makeSuccessfulHandle } from "./testing/configLockRegression.ts";
import { git, layerServerConfig, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-remote-url-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({ operation: "test", cwd, args });
  });

it.effect.each([
  {
    fetchUrl: "https://example.test/repo.git",
    pushUrl: "git@example.test:repo.git",
    lineEnding: "\n",
  },
  { fetchUrl: "../team repos/shared.git", pushUrl: "../team repos/push.git", lineEnding: "\n" },
  {
    fetchUrl: " ../team repos/shared (fetch) [blob:none].git ",
    pushUrl: "../team repos/push (push).git\t",
    lineEnding: "\r\n",
  },
])(
  "lists the fetch and push URLs of a partial clone remote (%j)",
  ({ fetchUrl, pushUrl, lineEnding }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-partial-clone-remotes-",
      });
      const process = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            process.run(input).pipe(
              Effect.map((result) => ({
                ...result,
                stdout: result.stdout.replace(/\r?\n/g, lineEnding),
              })),
            ),
        }),
      );
      yield* runGit(cwd, ["init"]);
      yield* runGit(cwd, ["remote", "add", "origin", fetchUrl]);
      yield* runGit(cwd, ["remote", "set-url", "--push", "origin", pushUrl]);
      yield* runGit(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* runGit(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const result = yield* driver.listRemotes(cwd);
      assert.deepEqual(result.remotes, [
        {
          name: "origin",
          url: fetchUrl,
          pushUrl: Option.some(pushUrl),
          isPrimary: true,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.layer(layerTest)("remote URL spaces", (it) => {
  it.effect.each(["\n", "\r\n"])(
    "ensureRemote preserves spaces in fetch URLs and reserves their names (%j)",
    (lineEnding) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fetchUrl = " ../team repos/shared (fetch) [blob:none].git ";
        const pushUrl = "../team repos/push (push).git";
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", fetchUrl]);
        yield* git(cwd, ["remote", "set-url", "--push", "origin", pushUrl]);
        yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
        yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
        const liveDriver = yield* GitVcsDriver.GitVcsDriver;
        const listing = yield* liveDriver.execute({
          cwd,
          args: ["remote", "-v"],
          operation: "test",
        });
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) &&
          command.args[0] === "remote" &&
          command.args[1] === "-v"
            ? Effect.succeed(makeSuccessfulHandle(listing.stdout.replace(/\r?\n/g, lineEnding)))
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        assert.equal(
          yield* driver.ensureRemote({ cwd, preferredName: "origin", url: fetchUrl }),
          "origin",
        );
        assert.equal(
          yield* driver.ensureRemote({ cwd, preferredName: "origin", url: pushUrl }),
          "origin-1",
        );
        const fetch = yield* liveDriver.execute({
          cwd,
          args: ["config", "--get", "remote.origin.url"],
          operation: "test",
        });
        const push = yield* liveDriver.execute({
          cwd,
          args: ["config", "--get", "remote.origin.pushurl"],
          operation: "test",
        });
        assert.equal(fetch.stdout, `${fetchUrl}\n`);
        assert.equal(push.stdout, `${pushUrl}\n`);
        assert.equal(yield* git(cwd, ["config", "--get", "remote.origin-1.url"]), pushUrl);
      }),
  );
});

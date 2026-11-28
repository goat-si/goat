import { SourceControlProviderKind } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

it.effect("gives Forgejo identities the browser URL of the login that serves them", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const refine = provider.refineRepositoryIdentity;
    assert.isDefined(refine);
    const identity = (remoteUrl: string, provider?: string) => ({
      canonicalKey: "forge.test/team/repo",
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
      rootPath: "/repo",
      ...(provider === undefined ? {} : { provider: SourceControlProviderKind.make(provider) }),
    });
    const served = (baseUrl: string) => () =>
      Effect.succeed({
        provider: {
          kind: SourceControlProviderKind.make("forgejo"),
          name: "Forgejo / Gitea",
          baseUrl,
        },
        remoteName: "origin",
        remoteUrl: "",
      });

    assert.deepStrictEqual(
      yield* refine!({
        identity: identity("http://forge.test:3000/git/team/repo.git"),
        resolveContext: served("http://forge.test:3000/git/"),
      }),
      {
        ...identity("http://forge.test:3000/git/team/repo.git"),
        provider: SourceControlProviderKind.make("forgejo"),
        webUrl: "http://forge.test:3000/git/team/repo",
      },
    );
    assert.strictEqual(
      (yield* refine!({
        identity: identity("ssh://git@ssh.forge.test/team/repo.git"),
        resolveContext: served("http://forge.test:3000/git"),
      })).webUrl,
      "http://forge.test:3000/git/team/repo",
    );
    const github = identity("https://github.com/team/repo.git", "github");
    assert.strictEqual(
      yield* refine!({ identity: github, resolveContext: () => Effect.die("not asked") }),
      github,
    );
    const unserved = identity("http://forge.test:3000/team/repo.git");
    const asked: Array<unknown> = [];
    assert.strictEqual(
      yield* refine!({
        identity: unserved,
        resolveContext: ({ context }) => {
          asked.push(context.provider);
          return Effect.succeed(null);
        },
      }),
      unserved,
    );
    // Other callers name the host, so the registry caches one verdict per remote.
    assert.deepStrictEqual(asked, [
      {
        kind: SourceControlProviderKind.make("unknown"),
        name: "forge.test:3000",
        baseUrl: "https://forge.test:3000",
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer(),
        Layer.mock(ForgejoCli.ForgejoCli)({}),
      ),
    ),
  ),
);

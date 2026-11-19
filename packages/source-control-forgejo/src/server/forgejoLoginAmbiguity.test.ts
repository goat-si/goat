import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";

const login = (name: string, url: string, isDefault = false) => ({
  name,
  url,
  ssh_host: "forgejo.test",
  user: "test",
  default: String(isDefault),
});
const entries = (values: ReturnType<typeof login>[]) =>
  ForgejoCli.parseForgejoLogins(JSON.stringify(values));

it.each(["https://forgejo.test/team/owner/repo.git", "git@forgejo.test:owner/repo.git"])(
  "uses the sole default on the same server for %s",
  (url) => {
    const remote = ForgejoCli.parseForgejoRemote(url);
    assert.isNotNull(remote);
    const logins = entries([
      login("alpha", "https://forgejo.test/team"),
      login("beta", "https://forgejo.test/team", true),
    ]);
    assert.equal(ForgejoCli.matchForgejoLogin(logins, remote!)?.name, "beta");
  },
);

it("rejects zero or multiple defaults for identical URLs", () => {
  const remote = ForgejoCli.parseForgejoRemote("https://forgejo.test/team/owner/repo.git");
  assert.isNotNull(remote);
  assert.isUndefined(
    ForgejoCli.matchForgejoLogin(
      entries([
        login("alpha", "https://forgejo.test/team"),
        login("beta", "https://forgejo.test/team"),
      ]),
      remote!,
    ),
  );
  assert.isUndefined(
    ForgejoCli.matchForgejoLogin(
      entries([
        login("alpha", "https://forgejo.test/team", true),
        login("beta", "https://forgejo.test/team", true),
      ]),
      remote!,
    ),
  );
});

it.effect("names ambiguous tea logins and explains how to choose", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .resolveRepository({ cwd: "/repo", repository: "https://forgejo.test/team/owner/repo.git" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.include(result.failure.detail, "alpha");
      assert.include(result.failure.detail, "beta");
      assert.include(result.failure.detail.toLowerCase(), "default");
    }
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected HTTP")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) =>
            Effect.succeed(
              TestSourceControlHost.processOutput(
                input.args[0] === "login"
                  ? JSON.stringify([
                      login("alpha", "https://forgejo.test/team"),
                      login("beta", "http://forgejo.test/team"),
                    ])
                  : "",
              ),
            ),
        },
      }),
    ),
  ),
);

it.effect.each([false, true])(
  "reports identical tea URLs with zero or multiple defaults (%s)",
  (isDefault) =>
    Effect.gen(function* () {
      const cli = yield* ForgejoCli.make;
      const result = yield* cli
        .resolveRepository({ cwd: "/repo", repository: "https://forgejo.test/team/owner/repo.git" })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.detail, "alpha");
        assert.include(result.failure.detail, "beta");
        assert.include(result.failure.detail.toLowerCase(), "default");
      }
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HTTP")),
      ),
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              Effect.succeed(
                TestSourceControlHost.processOutput(
                  input.args[0] === "login"
                    ? JSON.stringify([
                        login("alpha", "https://forgejo.test/team", isDefault),
                        login("beta", "https://forgejo.test/team", isDefault),
                      ])
                    : "",
                ),
              ),
          },
        }),
      ),
    ),
);

it.effect("names ambiguous SSH logins even when one is a default", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .resolveRepository({ cwd: "/repo", repository: "git@forgejo.test:owner/repo.git" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.include(result.failure.detail, "alpha");
      assert.include(result.failure.detail, "beta");
      assert.include(result.failure.detail, "full server URL");
    }
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected HTTP")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) =>
            Effect.succeed(
              TestSourceControlHost.processOutput(
                input.args[0] === "login"
                  ? JSON.stringify([
                      login("alpha", "https://forgejo.test:3000", true),
                      login("beta", "https://forgejo.test:4000"),
                    ])
                  : "",
              ),
            ),
        },
      }),
    ),
  ),
);

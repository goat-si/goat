import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@goat/contracts";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
const processOutput = TestSourceControlHost.processOutput;

it.effect("explains a slow fj instead of advising an install when tea is absent", () =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    assert.strictEqual(spec.type, "managed-cli");
    if (spec.type !== "managed-cli") return;
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.status, "missing");
    assert.strictEqual(result.executable, "fj");
    assert.include(result.installHint, "`fj version` timed out");
    assert.notInclude(result.installHint, "Install");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              const context = {
                operation: input.operation,
                command: input.command,
                cwd: input.cwd,
              };
              if (input.command === "git") return Effect.succeed(processOutput(""));
              if (input.command === "fj")
                return Effect.fail(new VcsProcessTimeoutError({ ...context, timeoutMs: 5_000 }));
              return Effect.fail(
                new VcsProcessSpawnError({
                  ...context,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    pathOrDescriptor: input.command,
                  }),
                }),
              );
            },
          },
        }),
      ),
    ),
  ),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect.each([
  { name: "transport failure", stderr: "error sending request for url", status: "unknown" },
  { name: "rejected token", stderr: "invalid credentials", status: "unauthenticated" },
] as const)("distinguishes $name for an fj login", ({ stderr, status }) =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery.pipe(
      Effect.provide(ForgejoCli.layer),
    );
    assert.strictEqual(spec.type, "managed-cli");
    if (spec.type !== "managed-cli") return;
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.executable, "fj");
    assert.strictEqual(result.auth.status, status);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        // fj stores the host without the scheme the login used.
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "forgejo.local:3000": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        request.url.startsWith("http://")
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(encodeJson({ login: "maria" }), { status: 200 }),
              ),
            )
          : Effect.die(new Error("received corrupt message of type InvalidContentType")),
      ),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            // Settings has no project in scope, so there is no origin remote.
            if (input.command === "git")
              return Effect.succeed(
                processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) }),
              );
            if (input.command !== "fj")
              return Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  cause: new Error("not installed"),
                }),
              );
            if (input.args[0] === "version") return Effect.succeed(processOutput("fj v0.7.0"));
            const host = input.args[input.args.indexOf("--host") + 1] ?? "";
            return Effect.succeed(
              host.startsWith("http://")
                ? processOutput("currently signed into maria@forgejo.local:3000")
                : processOutput("", {
                    exitCode: ChildProcessSpawner.ExitCode(1),
                    stderr,
                  }),
            );
          },
        },
      }),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/home/maria"),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const requestJson = (request: HttpClientRequest.HttpClientRequest) => {
  assert.strictEqual(request.body._tag, "Uint8Array");
  return request.body._tag === "Uint8Array"
    ? decodeJson(new TextDecoder().decode(request.body.body))
    : undefined;
};

it.effect("re-sends an fj write with its method and body to a renamed repository's path", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    yield* cli.api({
      cwd: "/repo",
      repository: "https://forgejo.local/maria/old-name",
      path: "repos/maria/old-name/issues/42/comments",
      method: "POST",
      body: { body: "only once" },
    });
    assert.deepStrictEqual(requests, [
      "https://forgejo.local/api/v1/repos/maria/old-name/issues/42/comments",
      "https://forgejo.local/api/v1/repos/maria/new-name/issues/42/comments",
    ]);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "forgejo.local": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.headers.authorization, "token test-token");
        assert.deepStrictEqual(requestJson(request), { body: "only once" });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            requests.length === 1
              ? new Response(null, {
                  status: 301,
                  headers: { location: "/api/v1/repos/maria/new-name/issues/42/comments" },
                })
              : new Response("{}", { status: 201 }),
          ),
        );
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: { run: () => Effect.succeed(processOutput("")) },
      }),
    ),
  );
});

it.effect("never forwards fj credentials to another origin", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    yield* Effect.flip(
      cli.api({
        cwd: "/repo",
        repository: "https://forgejo.local/maria/old-name",
        path: "repos/maria/old-name/issues/42/comments",
        method: "POST",
        body: { body: "only once" },
      }),
    );
    assert.deepStrictEqual(requests, [
      "https://forgejo.local/api/v1/repos/maria/old-name/issues/42/comments",
    ]);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "forgejo.local": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.headers.authorization, "token test-token");
        assert.deepStrictEqual(requestJson(request), { body: "only once" });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            requests.length === 1
              ? new Response(null, {
                  status: 301,
                  headers: {
                    location:
                      "https://attacker.example/api/v1/repos/maria/new-name/issues/42/comments",
                  },
                })
              : new Response("{}", { status: 201 }),
          ),
        );
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: { run: () => Effect.succeed(processOutput("")) },
      }),
    ),
  );
});

it.effect("keeps Gitea's failure reason when tea reports an HTTP error", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .api({
        cwd: "/repo",
        repository: "http://forgejo.local:3000/maria/project",
        path: "repos/maria/project/pulls/1/merge",
        method: "POST",
        body: { Do: "merge", delete_branch_after_merge: true },
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.include(result.failure.detail, "405");
      assert.include(result.failure.detail, "The head branch is behind the base branch");
    }
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(false),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("tea must handle its own HTTP request");
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) =>
            Effect.succeed(
              input.args[0] === "login"
                ? processOutput(
                    encodeJson([
                      {
                        name: "work",
                        url: "http://forgejo.local:3000",
                        ssh_host: "forgejo.local",
                        user: "maria",
                        default: "true",
                      },
                    ]),
                  )
                : processOutput(
                    '{"message":"The head branch is behind the base branch","url":"http://forgejo.local:3000/api/swagger"}',
                    {
                      stderr:
                        "HTTP/1.1 405 Method Not Allowed\nContent-Type: application/json;charset=utf-8\n",
                    },
                  ),
            ),
        },
      }),
    ),
  ),
);

const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Gitea ignores `head=` on the pull request list, so each page holds every branch's pull requests.
// The second lookup still asks for the front of the list: a pull request may have been opened.
it.effect("reads a Gitea pull request list at most once for branches that have none", () => {
  const listPages: Array<string> = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    for (const headSelector of ["first-without-pr", "second-without-pr"]) {
      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector,
        state: "all",
      });
      assert.deepStrictEqual(found, []);
    }
    assert.isAtMost(listPages.length, 5);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer({ process: {} }),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "work",
              repository: "maria/project",
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            if (!input.path.startsWith("repos/maria/project/pulls?"))
              return Effect.fail(
                new ForgejoCli.ForgejoCliError({
                  command: "tea",
                  cwd: input.cwd,
                  httpStatus: 404,
                  detail: "Forgejo API request failed (HTTP 404): Not Found",
                }),
              );
            listPages.push(input.path);
            const repo = { full_name: "maria/project", owner: { login: "maria" } };
            const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
            const items =
              page > 3
                ? []
                : Array.from({ length: 50 }, (_, index) => {
                    const number = 200 - (page - 1) * 50 - index;
                    return {
                      number,
                      title: `PR ${number}`,
                      html_url: `https://forgejo.test/maria/project/pulls/${number}`,
                      state: "open",
                      merged: false,
                      updated_at: `2026-10-12T00:0${Math.floor(number / 60)}:${String(number % 60).padStart(2, "0")}Z`,
                      base: { ref: "main", label: "main", sha: "base", repo },
                      head: {
                        ref: `feature-${number}`,
                        label: `feature-${number}`,
                        sha: "h",
                        repo,
                      },
                    };
                  });
            return encodeJsonEffect(items).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    ),
  );
});

it.effect("reads only the changed front of a Gitea pull request list it has read before", () => {
  const repo = { full_name: "maria/project", owner: { login: "maria" } };
  const fork = { full_name: "alice/renamed", owner: { login: "alice" } };
  const pull = (number: number, updatedSecond: number, head: string, state = "open") => ({
    number,
    title: `PR ${number}`,
    html_url: `https://forgejo.test/maria/project/pulls/${number}`,
    state,
    merged: false,
    updated_at: `2026-10-12T00:0${Math.floor(updatedSecond / 60)}:${String(updatedSecond % 60).padStart(2, "0")}Z`,
    base: { ref: number === 5 ? "release" : "main", label: "main", sha: "base", repo },
    head: { ref: head, label: head, sha: "h", repo: number === 5 ? fork : repo },
  });
  // Newest update first, as `sort=recentupdate` returns them. PR 5 sits on the last page.
  let pulls = Array.from({ length: 120 }, (_, index) =>
    pull(120 - index, 120 - index, 120 - index === 5 ? "feature" : `other-${120 - index}`),
  );
  // List pages read; a match is also read once by number before it is returned.
  let requests = 0;
  return Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const find = (headSelector: string) =>
      provider
        .listChangeRequests({ cwd: "/repo", headSelector, state: "all" })
        .pipe(Effect.map((found) => found.map((pr) => [pr.number, pr.state])));

    assert.deepStrictEqual(yield* find("alice:feature"), [[5, "open"]]);
    assert.strictEqual(requests, 4);

    pulls = [pull(121, 202, "later"), pull(5, 201, "feature", "closed"), ...pulls].filter(
      (entry, index, all) => all.findIndex((other) => other.number === entry.number) === index,
    );
    assert.deepStrictEqual(yield* find("later"), [[121, "open"]]);
    assert.deepStrictEqual(yield* find("alice:feature"), [[5, "closed"]]);
    assert.strictEqual(requests, 6);

    // Deleting a pull request moves nothing in the list.
    pulls = pulls.filter((entry) => entry.number !== 121);
    assert.deepStrictEqual(yield* find("later"), []);
    assert.strictEqual(requests, 7);

    pulls = pulls.filter((entry) => entry.number !== 120);
    yield* TestClock.adjust("1 hour");
    assert.deepStrictEqual(yield* find("other-120"), []);
    assert.strictEqual(requests, 11);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer({ process: {} }),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "work",
              repository: "maria/project",
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            const single = /\/pulls\/(\d+)$/.exec(input.path)?.[1];
            if (single !== undefined) {
              const found = pulls.find((entry) => entry.number === Number(single));
              return found
                ? encodeJsonEffect(found).pipe(Effect.orDie, Effect.map(processOutput))
                : Effect.fail(
                    new ForgejoCli.ForgejoCliError({
                      command: "tea",
                      cwd: input.cwd,
                      httpStatus: 404,
                      detail: "Forgejo API request failed (HTTP 404): Not Found",
                    }),
                  );
            }
            requests++;
            const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
            return encodeJsonEffect(pulls.slice((page - 1) * 50, page * 50)).pipe(
              Effect.orDie,
              Effect.map(processOutput),
            );
          },
        }),
      ),
    ),
  );
});

it.effect("evicts the oldest Gitea repository list while keeping the newest", () => {
  const filtered: string[] = [];
  const repo = { full_name: "maria/project", owner: { login: "maria" } };
  const pull = {
    number: 1,
    title: "PR",
    html_url: "https://forgejo.test/maria/project/pulls/1",
    state: "open",
    merged: false,
    updated_at: "2026-10-12T00:00:00Z",
    base: { ref: "main", label: "main", sha: "base", repo },
    head: { ref: "other", label: "other", sha: "h", repo },
  };
  return Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const find = (n: number) =>
      provider.listChangeRequests({ cwd: `/repo-${n}`, headSelector: "missing", state: "all" });
    for (let n = 0; n < 65; n++) yield* find(n);
    filtered.length = 0;
    yield* find(64);
    yield* find(0);
    assert.deepStrictEqual(filtered, ["/repo-0"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer({ process: {} }),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: (input) =>
            Effect.succeed({
              login: "work",
              repository: `maria${input.cwd.slice(6)}/project`,
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            const params = new URLSearchParams(input.path.split("?")[1]);
            if (params.has("head")) filtered.push(input.cwd);
            return encodeJsonEffect(params.get("page") === "1" ? [pull] : []).pipe(
              Effect.orDie,
              Effect.map(processOutput),
            );
          },
        }),
      ),
    ),
  );
});

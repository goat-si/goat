import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";

it.effect("caps tea API output at 16 MiB and reports truncation", () => {
  const limits: Array<number | undefined> = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .api({
        cwd: "/repo",
        repository: "maria/project",
        host: "forgejo.test",
        path: "repos/maria/project/pulls",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure.reason, "invalid-response");
      assert.include(result.failure.detail, "output size limit");
    }
    assert.deepStrictEqual(limits, [undefined, 16 * 1024 * 1024]);
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
          run: (input) => {
            if (input.args[0] === "login")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify([
                    { name: "work", url: "https://forgejo.test", user: "maria", default: "true" },
                  ]),
                ),
              );
            limits.push(input.maxOutputBytes);
            return Effect.succeed({
              ...TestSourceControlHost.processOutput("[]"),
              stderr: "HTTP/1.1 200 OK\n",
              stdoutTruncated: true,
            });
          },
        },
      }),
    ),
  );
});

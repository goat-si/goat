import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { threadId, turnItemId, withService } from "./SecretRequests.testkit.ts";

const origin = "https://example.com";
const key = "JBSWY3DP";
const options = { requestKind: "login", siteOrigin: origin } as const;

it.effect("rejects an invalid setup key without storing or recording it", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: {
              type: "save_login",
              username: "user",
              password: "password",
              authenticatorSetupKey: "invalid1",
            },
          })
          .pipe(Effect.flip);
        assert.equal(error.reason, "invalid_authenticator_setup_key");
        assert.equal(stored.size, 1);
        assert.equal(dispatched.length, 0);
      }),
    options,
  ),
);

it.effect("code survives login, enforces its bindings and counts only delivered fills", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "save_login",
            username: "user",
            password: "password",
            authenticatorSetupKey: key,
          },
        });
        assert.notInclude(JSON.stringify(dispatched), key);
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin };
        yield* service.useLogin(input, () => Effect.succeed("complete" as const));
        const use = (i = input, result: "none" | "complete" = "complete") =>
          service.useOneTimeCode(i, () => Effect.succeed(result));
        assert.equal(
          (yield* use({ ...input, threadId: ThreadId.make("other") }).pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        assert.equal(
          (yield* use({ ...input, origin: "https://elsewhere.example" }).pipe(Effect.flip)).reason,
          "origin_mismatch",
        );
        assert.equal(yield* use(input, "none"), "none");
        for (let i = 0; i < 3; i++) assert.equal(yield* use(), "complete");
        assert.equal((yield* use().pipe(Effect.flip)).reason, "ref_unavailable");
      }),
    options,
  ),
);

it.effect("code expires ten minutes after login completion", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "save_login",
            username: "user",
            password: "password",
            authenticatorSetupKey: key,
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin };
        yield* TestClock.adjust("1 hour");
        yield* service.useLogin(input, () => Effect.succeed("complete" as const));
        yield* TestClock.adjust("599 seconds");
        assert.equal(
          yield* service.useOneTimeCode(input, () => Effect.succeed("complete" as const)),
          "complete",
        );
        yield* TestClock.adjust("1 second");
        assert.equal(
          (yield* service
            .useOneTimeCode(input, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_expired",
        );
      }),
    options,
  ),
);

it.effect("an unused code expires after 24 hours", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "save_login",
            username: "user",
            password: "password",
            authenticatorSetupKey: key,
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* TestClock.adjust("24 hours");
        assert.equal(
          (yield* service
            .useOneTimeCode({ ref, threadId, origin }, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_expired",
        );
      }),
    options,
  ),
);

it.effect("reserves code while a fill is in flight and releases it after no delivery", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "save_login",
            username: "user",
            password: "password",
            authenticatorSetupKey: key,
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fiber = yield* service
          .useOneTimeCode(input, () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("none" as const),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        assert.equal(
          (yield* service
            .useOneTimeCode(input, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Fiber.join(fiber), "none");
        assert.equal(
          yield* service.useOneTimeCode(input, () => Effect.succeed("complete" as const)),
          "complete",
        );
      }),
    options,
  ),
);

it.effect("a failed final deletion keeps the code unavailable", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "save_login",
            username: "user",
            password: "password",
            authenticatorSetupKey: key,
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin };
        yield* service.useLogin(input, () => Effect.succeed("complete" as const));
        const use = () => service.useOneTimeCode(input, () => Effect.succeed("complete" as const));
        yield* use();
        yield* use();
        assert.equal((yield* use().pipe(Effect.flip)).reason, "consume_failed");
        assert.equal((yield* use().pipe(Effect.flip)).reason, "ref_unavailable");
      }),
    { ...options, removeFails: true },
  ),
);

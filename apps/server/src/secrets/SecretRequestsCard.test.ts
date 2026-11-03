import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { threadId, turnItemId, projectId, withService } from "./SecretRequests.testkit.ts";

const cardAnswer = {
  type: "save_card" as const,
  number: "1234 5678-9012",
  expiryMonth: "01",
  expiryYear: "29",
  cvc: "003",
  name: "  Test Name  ",
};

it.effect("card answers require the matching request kind", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      assert.equal(
        (yield* service.answer({ threadId, turnItemId, answer: cardAnswer }).pipe(Effect.flip))
          .reason,
        "answer_mismatch",
      );
    }),
  ),
);

it.effect("a login request rejects a card answer", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* service.answer({ threadId, turnItemId, answer: cardAnswer }).pipe(Effect.flip))
            .reason,
          "answer_mismatch",
        );
      }),
    { requestKind: "login", siteOrigin: "https://example.com" },
  ),
);

it.effect("a card request rejects invalid details without saving", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* service
            .answer({ threadId, turnItemId, answer: { ...cardAnswer, cvc: "x" } })
            .pipe(Effect.flip)).reason,
          "invalid_card",
        );
        assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      }),
    { requestKind: "card", siteOrigin: "https://example.com" },
  ),
);

it.effect("card items are private, bound to thread and origin, and refuse other consumers", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        for (const answer of [
          { type: "save" as const, secret: "password" },
          { type: "save_login" as const, username: "name", password: "password" },
        ]) {
          assert.equal(
            (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
            "answer_mismatch",
          );
        }
        yield* service.answer({ threadId, turnItemId, answer: cardAnswer });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin: "https://example.com" };
        assert.equal((yield* service.consumeForOrigin(input).pipe(Effect.flip)).reason, "card_ref");
        assert.equal(
          (yield* service.consume({ ref, projectId }).pipe(Effect.flip)).reason,
          "card_ref",
        );
        assert.equal(
          (yield* service
            .useLogin(input, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        assert.equal(
          (yield* service
            .useCard({ ...input, threadId: ThreadId.make("other") }, () =>
              Effect.succeed("complete" as const),
            )
            .pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        assert.equal(
          (yield* service
            .useCard({ ...input, origin: "https://other.example" }, () =>
              Effect.succeed("complete" as const),
            )
            .pipe(Effect.flip)).reason,
          "origin_mismatch",
        );
        assert.equal(
          yield* service.useCard(input, (card) => {
            assert.deepEqual(card, {
              number: "123456789012",
              expiryMonth: "01",
              expiryYear: "2029",
              cvc: "003",
              name: "  Test Name  ",
            });
            return Effect.succeed("none" as const);
          }),
          "none",
        );
        assert.equal(
          yield* service.useCard(input, () => Effect.succeed("complete" as const)),
          "complete",
        );
        assert.equal(
          (yield* service
            .useCard(input, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        assert.isFalse(JSON.stringify(dispatched).includes("123456789012"));
        assert.isFalse(JSON.stringify(dispatched).includes("003"));
      }),
    { requestKind: "card", siteOrigin: "https://example.com" },
  ),
);

it.effect.each(["partial", "complete", "uncertain"] as const)(
  "a %s card delivery is consumed",
  (delivery) =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({ threadId, turnItemId, answer: cardAnswer });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const input = { ref, threadId, origin: "https://example.com" };
          assert.equal(yield* service.useCard(input, () => Effect.succeed(delivery)), delivery);
          assert.equal(
            (yield* service
              .useCard(input, () => Effect.succeed("complete" as const))
              .pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
        }),
      { requestKind: "card", siteOrigin: "https://example.com" },
    ),
);

it.effect.each([false, true])(
  "card callback failure is unusable when deletion fails: %s",
  (removeFails) =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({ threadId, turnItemId, answer: cardAnswer });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const input = { ref, threadId, origin: "https://example.com" };
          assert.equal(
            yield* service.useCard(input, () => Effect.fail("delivery failed")).pipe(Effect.flip),
            "delivery failed",
          );
          assert.equal(
            (yield* service
              .useCard(input, () => Effect.succeed("complete" as const))
              .pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
        }),
      { requestKind: "card", siteOrigin: "https://example.com", removeFails },
    ),
);

it.effect("card consumption rejects login and single-secret items", () =>
  Effect.all([
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save_login", username: "name", password: "password" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(
            (yield* service
              .useCard({ ref, threadId, origin: "https://example.com" }, () =>
                Effect.succeed("complete" as const),
              )
              .pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
          assert.equal(
            (yield* service.answer({ threadId, turnItemId, answer: cardAnswer }).pipe(Effect.flip))
              .reason,
            "already_answered",
          );
        }),
      { requestKind: "login", siteOrigin: "https://example.com" },
    ),
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "password" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(
            (yield* service
              .useCard({ ref, threadId, origin: "https://example.com" }, () =>
                Effect.succeed("complete" as const),
              )
              .pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
        }),
      { siteOrigin: "https://example.com" },
    ),
  ]).pipe(Effect.asVoid),
);

it.effect.each(["partial", "complete", "uncertain"] as const)(
  "a %s card remains reserved if deletion fails",
  (delivery) =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({ threadId, turnItemId, answer: cardAnswer });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const input = { ref, threadId, origin: "https://example.com" };
          assert.equal(
            (yield* service.useCard(input, () => Effect.succeed(delivery)).pipe(Effect.flip))
              .reason,
            "consume_failed",
          );
          assert.equal(
            (yield* service
              .useCard(input, () => Effect.succeed("complete" as const))
              .pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
        }),
      { requestKind: "card", siteOrigin: "https://example.com", removeFails: true },
    ),
);

it.effect("a reserved card cannot be used concurrently", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({ threadId, turnItemId, answer: cardAnswer });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const input = { ref, threadId, origin: "https://example.com" };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* service
          .useCard(input, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("complete" as const),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.equal(
          (yield* service
            .useCard(input, () => Effect.succeed("complete" as const))
            .pipe(Effect.flip)).reason,
          "ref_unavailable",
        );
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Fiber.join(first), "complete");
      }),
    { requestKind: "card", siteOrigin: "https://example.com" },
  ),
);

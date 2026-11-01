import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { LOGIN, makeCliHarness, RECEIPT } from "./testing.ts";

it.effect("reads a cursor-spaced, wrapped diagnostic as Claude shows it on screen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      // Native capture: Claude spaces words with cursor-column jumps and wraps at 120 columns.
      h.fake.emit(
        "\u001b7\u001b[r\u001b8\u001b[?25hError:\u001b[8GThis\u001b[13Grepository\u001b[24Gis\u001b[27Gtoo\u001b[31Glarge\u001b[37Gto\u001b[40Gupload:\u001b[48Geven\u001b[53Gwithout\u001b[61Gits\u001b[65Ghistory\u001b[73Git\u001b[76Gis\u001b[79G100.6MB,\u001b[88Gand\u001b[92Gan\u001b[95Gupload\u001b[102Gcan\u001b[106Gbe\u001b[109Gat\u001b[112Gmost\r\r\n" +
          "100MB.\u001b[8GGitHub\u001b[15Gisn't\u001b[21Gconnected\u001b[31Gto\u001b[34Gyour\u001b[39GClaude\u001b[46Gaccount,\u001b[55Gso\u001b[58Gthis\u001b[63Grepository\u001b[74Gcan't\u001b[80Gbe\u001b[83Gcloned\u001b[90Gin\u001b[93Gthe\u001b[97Gcloud.\u001b[104GConnect\u001b[112Git\u001b[115Gon\u001b[118Gthe\r\r\n" +
          "web\u001b[5Gat\u001b[8Ghttps://claude.ai/connect-github\r\r\n\u001b[?25h\u001b[?2004l\u001b]0;\u0007\u001b[?25h",
      );
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.detail).toBe(
        "This repository is too large to upload: even without its history it is 100.6MB, and an upload can be at most 100MB. GitHub isn't connected to your Claude account, so this repository can't be cloned in the cloud. Connect it on the web at [link redacted]",
      );
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect.each([
  ["fixture  secret", "Error: invalid fixture  secret\n"],
  ["fixture\nsecret", "Error: invalid fixture\r\r\nsecret\r\r\n"],
  ["fixture-secret", "Error: invalid fixture-\u001b[24Gsecret\n"],
  ["fixture-secret", "Error: invalid fixture-\u001b[1Csecret\n"],
] as const)(
  "redacts a sign-in value however the screen spaced or wrapped it (%#)",
  ([value, output]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const login = { ...LOGIN, environment: { ...LOGIN.environment, FIXTURE_TOKEN: value } };
        const fiber = yield* h.service
          .start(login, "/fixture/project", "task")
          .pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(output);
        h.fake.finish(1);
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error.detail).toBe("invalid [redacted]");
      }),
    ),
);

it.effect("still recognizes a diagnostic whose text starts on the line after Error:", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error:\nfixture transport interrupted\n" + RECEIPT);
      const handle = yield* Fiber.join(fiber);
      h.fake.finish(0, 0);
      const error = yield* handle.exited.pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toContain("fixture transport interrupted");
    }),
  ),
);

it.effect("masks a wrapped link together with its continuation line", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error: visit https://example.invalid/?token=\r\r\nprivate-url-token\r\r\n");
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.detail).toBe("visit [link redacted]");
    }),
  ),
);

it.effect.each([
  [
    "",
    "Error: visit https:\u001b[1C//example.invalid/?token=private-url-token\n",
    "visit [link redacted]",
  ],
  ["", "Error: invalid Bearer private-\u001b[1Ctoken\n", "invalid [redacted]"],
  [
    "",
    "Error: visit https://example.invalid/?token=\r\r\n\u001b[1Cprivate-url-token\r\r\n",
    "visit [link redacted]",
  ],
  ["ab  cd", "Error: invalid ab \u001b[1C cd\n", "invalid [redacted]"],
  ["/fixture/tool/bin:".repeat(1024), "Error: a simple error\n", "a simple error"],
  ["abc\uE000def", "Error: invalid abc\uE000def\n", "invalid [redacted]"],
  ["public secret", "Error: visit https://public secret-tail\n", "visit [link redacted]"],
  [" https://", "Error: https://example.invalid/?token=private-token\n", "[link redacted]"],
  [" Bearer", "Error: Bearer private-token\n", "[redacted]"],
  [
    "failed\nhttps://",
    "Error: failed\r\r\nhttps://example.invalid/?token=private-token\r\r\n",
    "[link redacted]",
  ],
  ["fixture-secret", "Error: invalid fixture-\u001b\u001b[1m[1msecret\n", "invalid [redacted]"],
  [
    "synthetic-secret-prefix\nView: synthetic-suffix",
    "Error: invalid synthetic-secret-prefix\r\r\nView: synthetic-suffix\r\r\n",
    "invalid [redacted]",
  ],
] as const)(
  "masks what plain redaction masks however the screen spaced it (%#)",
  ([value, output, shown]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const login = { ...LOGIN, environment: { ...LOGIN.environment, FIXTURE_VALUE: value } };
        const fiber = yield* h.service
          .start(login, "/fixture/project", "task")
          .pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(output);
        h.fake.finish(1);
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error.detail).toBe(shown);
      }),
    ),
);

it.effect("an Error: line with nothing readable still makes the submission uncertain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT + "Error: \n");
      const handle = yield* Fiber.join(fiber);
      h.fake.finish(0, 0);
      const error = yield* handle.exited.pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toBe("Claude could not confirm cloud submission.");
    }),
  ),
);

it.effect("reads a wrapped diagnostic whose lines arrive in separate chunks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error: repository too large\r\r\n");
      h.fake.emit("Connect GitHub to clone in the cloud.\r\r\n");
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toBe("repository too large Connect GitHub to clone in the cloud.");
    }),
  ),
);

it.effect.each([
  // Near the 64 KiB output bound, with a value that rewrites every word.
  [{ V: "abcdef", W: "redacted" }, "Error: " + "abcdef".repeat(10_900) + "\n"],
  // Values equal to the mask label itself, so each pass re-masks earlier labels.
  [
    Object.fromEntries(Array.from({ length: 6 }, (_, index) => ["V" + index, "[redacted]"])),
    "Error: [redacted]\n",
  ],
] as const)("redacts adversarial values without failing (%#)", ([values, output]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const login = { ...LOGIN, environment: { ...LOGIN.environment, ...values } };
      const fiber = yield* h.service
        .start(login, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(output);
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail.startsWith("[redacted]")).toBe(true);
      expect(error.detail).not.toContain("abcdef");
    }),
  ),
);

it.effect("a wrapped diagnostic stops at the session receipt that follows it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error: first\r\r\nwrapped end\r\r\n" + RECEIPT);
      const handle = yield* Fiber.join(fiber);
      h.fake.finish(1);
      const error = yield* handle.exited.pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toBe("first wrapped end");
    }),
  ),
);

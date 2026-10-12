import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, type CompletionWebhookSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CompletionWebhook from "./completionWebhook.ts";
import { newLaunchWatch, type LaunchWatch } from "./launchWatch.ts";

const launcher = ThreadId.make("launcher");
const target = ThreadId.make("target");
const run1 = RunId.make("run-1");

const watchFor = (input: { notifyWebhook: boolean; host?: string | null }): LaunchWatch =>
  newLaunchWatch({
    launcherThreadId: launcher,
    host: input.host ?? null,
    threadId: target,
    projectId: ProjectId.make("project"),
    title: "Fix the flake",
    incarnation: "incarnation-1",
    notifyWebhook: input.notifyWebhook,
    now: 0,
  });

const runReport = (
  id = "server:launch-watch:w:run:run-1",
): CompletionWebhook.CompletionWebhookReport => ({
  id,
  event: "run.completed",
  runId: run1,
  status: "completed",
  title: null,
  summary: 'Launched thread "Fix the flake" completed',
  excerpt: "Fixed the flake; tests pass.",
  prUrl: "https://github.com/acme/app/pull/7",
});

const enabled = {
  enabled: true,
  url: "https://agent.example/hooks/goat",
  secret: "s3cret",
  allLaunches: false,
} satisfies CompletionWebhookSettings;

interface Received {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A webhook receiver answering each request in turn; the last answer repeats. */
const harness = (
  settings: Partial<CompletionWebhookSettings>,
  answers: ReadonlyArray<number | "network" | "hang"> = [200],
) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<Received>();
    const log: Array<Received> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const entry = { url: request.url, headers: request.headers, body: await request.text() };
      const answer = answers[Math.min(log.length, answers.length - 1)] ?? 200;
      log.push(entry);
      Queue.offerUnsafe(received, entry);
      if (answer === "network") throw new Error("connection refused");
      if (answer === "hang") return new Promise<Response>(() => {});
      return new Response(null, { status: answer });
    };
    const layer = CompletionWebhook.layer.pipe(
      Layer.provideMerge(ServerSettings.layerTest({ completionWebhook: settings })),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    );
    return { received, log, layer };
  });

const withWebhook = <A, E, LE>(
  layer: Layer.Layer<
    CompletionWebhook.CompletionWebhook | ServerSettings.ServerSettingsService,
    LE
  >,
  body: (
    webhook: CompletionWebhook.CompletionWebhookShape,
    settings: ServerSettings.ServerSettingsService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const webhook = yield* CompletionWebhook.CompletionWebhook;
    const settings = yield* ServerSettings.ServerSettingsService;
    return yield* body(webhook, settings);
  }).pipe(Effect.provide(layer));

/** Lets forked deliveries run up to their next sleep or pending request. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
  // @effect-diagnostics-next-line globalTimers:off -- The fake fetch resolves outside the test clock.
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("completionWebhookPayload", () => {
  it("carries the run, the watch's threads and host, and leaves out absent optional fields", () => {
    const remote = watchFor({ notifyWebhook: true, host: "box" });
    expect(CompletionWebhook.completionWebhookPayload(remote, runReport(), 0)).toEqual({
      id: "server:launch-watch:w:run:run-1",
      event: "run.completed",
      threadId: target,
      runId: run1,
      host: "box",
      title: "Fix the flake",
      status: "completed",
      summary: 'Launched thread "Fix the flake" completed',
      excerpt: "Fixed the flake; tests pass.",
      prUrl: "https://github.com/acme/app/pull/7",
      launcherThreadId: launcher,
      at: "1970-01-01T00:00:00.000Z",
    });
    const question = CompletionWebhook.completionWebhookPayload(
      watchFor({ notifyWebhook: true }),
      {
        ...runReport(),
        event: "question",
        requestId: "question-1",
        status: "waiting",
        excerpt: null,
        prUrl: null,
      },
      0,
    );
    expect(question).toMatchObject({ host: null, requestId: "question-1", excerpt: null });
    expect(question).not.toHaveProperty("prUrl");
  });
});

describe("completionWebhookWanted", () => {
  it.each([
    [{ ...enabled }, false, false],
    [{ ...enabled }, true, true],
    [{ ...enabled, allLaunches: true }, false, true],
    [{ ...enabled, enabled: false, allLaunches: true }, true, false],
    [{ ...enabled, url: "" }, true, false],
  ] as const)("%o with notifyWebhook %s posts: %s", (settings, notifyWebhook, wanted) => {
    expect(CompletionWebhook.completionWebhookWanted(settings, watchFor({ notifyWebhook }))).toBe(
      wanted,
    );
  });
});

describe("CompletionWebhook", () => {
  it.effect("posts the payload signed with the secret, with event and delivery headers", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          const request = yield* Queue.take(h.received);
          expect(request.url).toBe(enabled.url);
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(request.headers.get("x-goat-event")).toBe("run.completed");
          expect(request.headers.get("x-goat-delivery")).toBe("server:launch-watch:w:run:run-1");
          expect(JSON.parse(request.body)).toMatchObject({
            event: "run.completed",
            threadId: target,
            runId: run1,
            launcherThreadId: launcher,
            prUrl: "https://github.com/acme/app/pull/7",
          });
          const verify = (secret: string) =>
            verifyWebhookSignature({
              signature: { header: "x-goat-signature", prefix: "sha256=", encoding: "hex" },
              secret,
              headers: { "x-goat-signature": request.headers.get("x-goat-signature") ?? "" },
              body: new TextEncoder().encode(request.body),
            });
          expect(verify("s3cret")).toBe(true);
          expect(verify("other")).toBe(false);
        }),
      );
    }),
  );

  it.effect("omits the signature without a secret", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, secret: "" });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          const request = yield* Queue.take(h.received);
          expect(request.headers.has("x-goat-signature")).toBe(false);
        }),
      );
    }),
  );

  it.effect.each([
    ["the webhook is off", { ...enabled, enabled: false }, true],
    ["the launch did not opt in", enabled, false],
    ["the url is empty", { ...enabled, url: "" }, true],
    ["the url is not http(s)", { ...enabled, url: "file:///etc/passwd" }, true],
  ] as const)("posts nothing when %s", ([, settings, notifyWebhook]) =>
    Effect.gen(function* () {
      const h = yield* harness(settings);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook }), runReport());
          yield* settle;
        }),
      );
      expect(h.log).toEqual([]);
    }),
  );

  it.effect("posts for a watch that did not opt in when allLaunches is on", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, allLaunches: true });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: false }), runReport());
          yield* Queue.take(h.received);
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("returns before the receiver answers, so a wake is never held back", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, ["hang"]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
        }),
      );
    }),
  );

  it.effect("retries failures with the launch watch backoff until the receiver accepts", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503, "network", 429, 204]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          for (const backoff of [30_000, 60_000, 120_000]) {
            yield* settle;
            yield* TestClock.adjust(backoff - 1);
            yield* settle;
            expect(Queue.sizeUnsafe(h.received)).toBe(0);
            yield* TestClock.adjust(1);
            yield* Queue.take(h.received);
          }
          yield* settle;
          yield* TestClock.adjust(60 * 60_000);
          yield* settle;
        }),
      );
      expect(h.log).toHaveLength(4);
      // Every retry is the same event under the same id and body.
      expect(new Set(h.log.map((request) => request.body)).size).toBe(1);
      expect(new Set(h.log.map((request) => request.headers.get("x-goat-delivery"))).size).toBe(1);
    }),
  );

  it.effect("gives up after the last attempt and does not retry a refusal", () =>
    Effect.gen(function* () {
      const failing = yield* harness(enabled, [500]);
      yield* withWebhook(failing.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          for (let i = 0; i < 10; i++) {
            yield* settle;
            yield* TestClock.adjust(15 * 60_000);
          }
          yield* settle;
        }),
      );
      expect(failing.log).toHaveLength(CompletionWebhook.MAX_ATTEMPTS);

      const refused = yield* harness(enabled, [400]);
      yield* withWebhook(refused.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(refused.received);
          yield* settle;
          yield* TestClock.adjust(60 * 60_000);
          yield* settle;
        }),
      );
      expect(refused.log).toHaveLength(1);
    }),
  );

  it.effect("a shutdown stops a delivery reported from an uninterruptible section", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503]);
      // The launch watch reports while it holds its lock, uninterruptibly; leaving the
      // layer must still end the delivery that is waiting out its backoff.
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* Effect.uninterruptible(
            webhook.notify(watchFor({ notifyWebhook: true }), runReport()),
          );
          yield* Queue.take(h.received);
          yield* settle;
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("stops retrying once the webhook is turned off", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503]);
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          yield* settings.updateSettings({ completionWebhook: { enabled: false } });
          yield* settle;
          yield* TestClock.adjust(60 * 60_000);
          yield* settle;
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("posts each event once, however often it is reported", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const watch = watchFor({ notifyWebhook: true });
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.received);
          yield* webhook.notify(watch, runReport());
          yield* webhook.notify(watch, runReport("server:launch-watch:w:run:run-2"));
          yield* Queue.take(h.received);
          yield* settle;
        }),
      );
      expect(h.log.map((request) => request.headers.get("x-goat-delivery"))).toEqual([
        "server:launch-watch:w:run:run-1",
        "server:launch-watch:w:run:run-2",
      ]);
    }),
  );

  it.effect("a report skipped while the webhook was off can still post later", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, enabled: false });
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          const watch = watchFor({ notifyWebhook: true });
          yield* webhook.notify(watch, runReport());
          yield* settle;
          yield* settings.updateSettings({ completionWebhook: { enabled: true } });
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.received);
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubPullRequestEvents from "./gitHubPullRequestEvents.ts";
import {
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiResponseError,
} from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const target = { host: "github.com", repository: "pingdotgg/t3code", number: 15 };

const sse = (...frames: ReadonlyArray<readonly [string, string]>) =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join("");

function fakeRest(
  subscribe: (
    count: number,
  ) => Effect.Effect<
    string,
    GitHubApiResponseError | GitHubApiNotFoundError | GitHubApiAuthenticationError
  >,
) {
  const posts: Array<unknown> = [];
  const deletes: Array<string> = [];
  const rest = GitHubRest.GitHubRest.of({
    rest: (input) =>
      input.method === "DELETE"
        ? Effect.sync(() => {
            deletes.push(input.path);
            return { status: 204, headers: {}, body: "", truncated: false, invalidUtf8: false };
          })
        : Effect.suspend(() => {
            posts.push(input.body);
            return subscribe(posts.length);
          }).pipe(
            Effect.map((body) => ({
              status: 201,
              headers: {},
              body,
              truncated: false,
              invalidUtf8: false,
            })),
          ),
    credential: () => Effect.succeed({ token: Redacted.make("host-token"), fingerprint: "host" }),
  });
  return { rest, posts, deletes };
}

const eventsOf = (rest: GitHubRest.GitHubRest["Service"], httpClient: HttpClient.HttpClient) =>
  GitHubPullRequestEvents.make.pipe(
    Effect.provideService(GitHubRest.GitHubRest, rest),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

const subscription = (id: number) =>
  Effect.succeed(
    JSON.stringify({ id, events_url: `https://api.github.com/event-subscriptions/${id}/events` }),
  );

it.effect("follows a pull request across reconnects and renewals with the host credential", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(subscription);
    const connections: Array<string> = [];
    const answers = [
      () =>
        new Response(
          sse(
            ["com.github.pull_request.head.changed.v1", "{}"],
            ["github.stream.end", '{"outcome":"reconnect","reason":"shutdown"}'],
          ),
        ),
      () =>
        new Response(
          sse(["github.stream.end", '{"outcome":"subscription_ended","reason":"expired"}']),
        ),
      () => new Response(": heartbeat\n\n"),
    ];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        connections.push(`${request.url} ${request.headers.authorization}`);
        return HttpClientResponse.fromWeb(request, answers[connections.length - 1]!());
      }),
    );

    const events = yield* eventsOf(rest, httpClient);
    const fiber = yield* events(target).pipe(Stream.take(4), Stream.runCount, Effect.forkChild);
    yield* TestClock.adjust("5 minutes");
    // An open per connection plus the head change.
    assert.equal(yield* Fiber.join(fiber), 4);

    assert.deepEqual(connections, [
      "https://api.github.com/event-subscriptions/1/events Bearer host-token",
      "https://api.github.com/event-subscriptions/1/events Bearer host-token",
      "https://api.github.com/event-subscriptions/2/events Bearer host-token",
    ]);
    assert.deepEqual(posts[0], {
      resource_url: "https://github.com/pingdotgg/t3code/pull/15",
      event_types: [
        "com.github.pull_request.review.submitted.v1",
        "com.github.pull_request.head.changed.v1",
        "com.github.pull_request.state.changed.v1",
        "com.github.pull_request.merge_conflict.v1",
        "com.github.pull_request.check_suite.status.changed.v1",
      ],
    });
    assert.deepEqual(deletes, ["event-subscriptions/1", "event-subscriptions/2"]);
  }),
);

it.effect("gives up on a silent stream and deletes its subscription", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(subscription);
    let connections = 0;
    // Answers, then never sends a byte, not even a keep-alive.
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        connections += 1;
        return HttpClientResponse.fromWeb(request, new Response(new ReadableStream()));
      }),
    );
    const events = yield* eventsOf(rest, httpClient);
    const fiber = yield* events(target).pipe(Stream.runCount, Effect.forkChild);
    yield* TestClock.adjust("15 minutes");

    assert.equal(yield* Fiber.join(fiber), 7, "one catch-up read per connection");
    assert.equal(connections, 7);
    assert.equal(posts.length, 1);
    assert.deepEqual(deletes, ["event-subscriptions/1"]);
  }),
);

it.effect("leaves rejected tokens, other hosts, and refusals to polling", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make(() => Effect.die("no stream without a subscription"));
    const signedOut = fakeRest(() =>
      Effect.fail(
        new GitHubApiAuthenticationError({
          host: "github.com",
          operation: "subscribePullRequestEvents",
        }),
      ),
    );
    const signedOutEvents = yield* eventsOf(signedOut.rest, httpClient);
    assert.equal(yield* Stream.runCount(signedOutEvents(target)), 0);
    assert.equal(yield* Stream.runCount(signedOutEvents({ ...target, number: 16 })), 0);
    assert.equal(signedOut.posts.length, 1, "a rejected token is not tried again for an hour");

    const signedIn = fakeRest(subscription);
    const enterprise = { ...target, host: "ghe.example.com" };
    assert.equal(
      yield* Stream.runCount((yield* eventsOf(signedIn.rest, httpClient))(enterprise)),
      0,
    );
    assert.equal(signedIn.posts.length, 0);

    const refused = fakeRest(() =>
      Effect.fail(
        new GitHubApiResponseError({
          host: "github.com",
          operation: "subscribePullRequestEvents",
          status: 403,
        }),
      ),
    );
    const events = yield* eventsOf(refused.rest, httpClient);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
    assert.equal(refused.posts.length, 1, "a refused account is not asked again for an hour");
    yield* TestClock.adjust("61 minutes");
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(refused.posts.length, 2);

    const missing = fakeRest(() =>
      Effect.fail(
        new GitHubApiNotFoundError({ host: "github.com", operation: "subscribePullRequestEvents" }),
      ),
    );
    const missingEvents = yield* eventsOf(missing.rest, httpClient);
    assert.equal(yield* Stream.runCount(missingEvents(target)), 0);
    assert.equal(yield* Stream.runCount(missingEvents(target)), 0);
    assert.equal(missing.posts.length, 1, "a pull request it cannot see is not asked again");
    assert.equal(yield* Stream.runCount(missingEvents({ ...target, number: 16 })), 0);
    assert.equal(missing.posts.length, 2, "other pull requests on the host still subscribe");
  }),
);

it.effect("stops following a pull request whose stream the token cannot read", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(subscription);
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
    );
    const events = yield* eventsOf(rest, httpClient);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(posts.length, 1);
    assert.deepEqual(deletes, ["event-subscriptions/1"]);
  }),
);

it.effect.each([
  "https://evil.example/event-subscriptions/1/events",
  "https://api.github.com.evil.example/event-subscriptions/1/events",
  "https://api.github.com@evil.example/event-subscriptions/1/events",
  "http://api.github.com/event-subscriptions/1/events",
])(
  "deletes a subscription whose events URL leaves GitHub's API (%s) and sends it no token",
  (eventsUrl) =>
    Effect.gen(function* () {
      const { rest, posts, deletes } = fakeRest(() =>
        Effect.succeed(JSON.stringify({ id: 1, events_url: eventsUrl })),
      );
      let streams = 0;
      const httpClient = HttpClient.make(() =>
        Effect.suspend(() => {
          streams += 1;
          return Effect.die("no stream request may leave GitHub's API");
        }),
      );
      const events = yield* eventsOf(rest, httpClient);
      assert.equal(yield* Stream.runCount(events(target)), 0);
      assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
      assert.equal(streams, 0, "a stream request went out");
      assert.deepEqual(
        deletes,
        ["event-subscriptions/1"],
        "the subscription GitHub made stays behind",
      );
      assert.equal(posts.length, 1, "the host subscribes again at once");
    }),
);

it.effect("pauses the host when a subscription answer does not decode", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(() => Effect.succeed("{}"));
    const httpClient = HttpClient.make(() => Effect.die("no stream without a subscription"));
    const events = yield* eventsOf(rest, httpClient);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
    assert.deepEqual(deletes, []);
    assert.equal(posts.length, 1, "the host subscribes again at once");
  }),
);

const refusing = (status: number) =>
  fakeRest(() =>
    Effect.fail(
      new GitHubApiResponseError({
        host: "github.com",
        operation: "subscribePullRequestEvents",
        status,
      }),
    ),
  );
const noStream = HttpClient.make(() => Effect.die("no stream without a subscription"));

it.effect.each([400, 410, 415])("pauses the host for an hour on a %s subscribe answer", (status) =>
  Effect.gen(function* () {
    const { rest, posts } = refusing(status);
    const events = yield* eventsOf(rest, noStream);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
    assert.equal(posts.length, 1, "a refused host is asked again at once");
    yield* TestClock.adjust("61 minutes");
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(posts.length, 2);
  }),
);

it.effect("keeps the subscription limit pause at ten minutes", () =>
  Effect.gen(function* () {
    const { rest, posts } = refusing(422);
    const events = yield* eventsOf(rest, noStream);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    yield* TestClock.adjust("9 minutes");
    assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
    assert.equal(posts.length, 1);
    yield* TestClock.adjust("2 minutes");
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(posts.length, 2);
  }),
);

it.effect("asks again after a server error", () =>
  Effect.gen(function* () {
    const { rest, posts } = refusing(502);
    const events = yield* eventsOf(rest, noStream);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(posts.length, 2);
  }),
);

it.effect.each([401, 403, 404])(
  "a stream answering %s stops, deletes its subscription and pauses that pull request",
  (status) =>
    Effect.gen(function* () {
      const { rest, posts, deletes } = fakeRest(subscription);
      let connections = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          connections += 1;
          return HttpClientResponse.fromWeb(request, new Response(null, { status }));
        }),
      );
      const events = yield* eventsOf(rest, httpClient);
      const fiber = yield* events(target).pipe(Stream.runCount, Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Fiber.join(fiber), 0);
      assert.equal(connections, 1, "the stream reconnected");
      assert.deepEqual(deletes, ["event-subscriptions/1"]);
      assert.equal(yield* Stream.runCount(events(target)), 0);
      assert.equal(posts.length, 1, "the pull request subscribed again at once");
      const other = yield* events({ ...target, number: 16 }).pipe(
        Stream.runCount,
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 minutes");
      yield* Fiber.join(other);
      assert.equal(posts.length, 2, "other pull requests still subscribe");
    }),
);

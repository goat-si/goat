import { assert, describe, it } from "@effect/vitest";
import type { DesktopPenMembersState } from "@goat/contracts";
import type { PenSnapshot, PenWatchStale } from "@goat/pen-protocol/snapshot";
import { PenAliasUnreadable } from "@goat/ssh/penAlias";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as DesktopPenMembers from "./DesktopPenMembers.ts";

vi.mock("electron", () => ({}));

const id = (letter: string) => letter.repeat(26);
const SELF = id("s");
const MESH = id("m");
const key = (letter: string) => letter.repeat(43);
const member = (letter: string, online = true) => ({
  nodeId: id(letter),
  noisePub: key(letter),
  name: `box-${letter}`,
  online,
});
const snapshot = (gen: number, ...letters: string[]): PenSnapshot => ({
  gen,
  mesh: MESH,
  self: SELF,
  members: [{ nodeId: SELF, noisePub: key("s"), name: "this-mac", online: true }].concat(
    letters.map((letter) => member(letter)),
  ),
  revoked: [],
});
const trusted = (letter: string, noise = letter) => ({
  alias: `pen-${id(letter)}`,
  nodeId: id(letter),
  noisePub: key(noise),
  revision: `pen:${letter}`,
  target: { alias: `pen-${id(letter)}`, hostname: `pen-${id(letter)}`, username: "me", port: null },
});
const target = (letter: string) => trusted(letter).target;

type Inspection = Effect.Success<ReturnType<DesktopPenMembers.DesktopPenMembersDeps["inspect"]>>;

const harness = Effect.fn("test.DesktopPenMembers.harness")(function* (
  options: { readonly stateDir?: string | undefined; readonly exists?: boolean } = {},
) {
  const published: DesktopPenMembersState[] = [];
  const watches: Array<{
    readonly onSnapshot: (snapshot: PenSnapshot) => void;
    readonly onStale: (reason: PenWatchStale) => void;
    stopped: boolean;
  }> = [];
  const state = {
    left: false,
    inspections: new Map<string, Effect.Effect<Inspection, PenAliasUnreadable>>(),
    inspected: [] as string[],
  };
  const service = yield* DesktopPenMembers.make({
    stateDir: "stateDir" in options ? options.stateDir : "/pen",
    stateDirExists: () => Effect.succeed(options.exists ?? true),
    leftMesh: () => Effect.sync(() => state.left),
    watch: (input) => {
      const watch = { onSnapshot: input.onSnapshot, onStale: input.onStale, stopped: false };
      watches.push(watch);
      return () => {
        watch.stopped = true;
      };
    },
    inspect: (alias) =>
      Effect.suspend(() => {
        state.inspected.push(alias);
        return (
          state.inspections.get(alias) ??
          Effect.succeed<Inspection>({ refused: "not-in-pen-config" })
        );
      }),
    publish: (next) => Effect.sync(() => void published.push(next)),
  });
  const trust = (...letters: string[]) => {
    for (const letter of letters)
      state.inspections.set(`pen-${id(letter)}`, Effect.succeed(trusted(letter)));
  };
  yield* TestClock.adjust(0);
  return { service, published, watches, state, trust, last: () => published.at(-1) };
});

const routes = (state: DesktopPenMembersState | undefined) =>
  state?.kind === "ready"
    ? state.members.map((entry) =>
        entry.route.kind === "trusted" ? [entry.name, "trusted"] : [entry.name, entry.route.reason],
      )
    : state?.kind;

describe("DesktopPenMembers", () => {
  it.effect("native member eligibility follows the live pin without inspecting SSH", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const pin = { meshId: MESH, nodeId: id("a"), noisePub: key("a") };
      assert.equal(yield* h.service.requireMember(pin), "unavailable");
      const views: string[] = [];
      const unsubscribe = h.service.subscribeMembership((view) => views.push(view.kind));
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      const inspections = h.state.inspected.length;
      assert.equal(yield* h.service.requireMember(pin), "member");
      assert.equal(yield* h.service.requireMember({ ...pin, noisePub: key("b") }), "not-member");
      assert.equal(
        yield* h.service.requireMember({ ...pin, nodeId: SELF, noisePub: key("s") }),
        "not-member",
      );
      h.watches[0]?.onStale("connect");
      assert.equal(yield* h.service.requireMember(pin), "unavailable");
      assert.deepEqual(views.slice(0, 2), ["ready", "unavailable"]);
      unsubscribe();
      assert.equal(h.state.inspected.length, inspections);
    }).pipe(Effect.scoped),
  );

  it.effect("native eligibility refuses ambiguous or revoked member records", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const pin = { meshId: MESH, nodeId: id("a"), noisePub: key("a") };
      const view = snapshot(1, "a");
      h.watches[0]?.onSnapshot({ ...view, members: [...view.members, member("a")] });
      assert.equal(yield* h.service.requireMember(pin), "not-member");
      h.watches[0]?.onSnapshot({
        ...view,
        gen: 2,
        revoked: [{ nodeId: pin.nodeId, name: "box-a" }],
      });
      assert.equal(yield* h.service.requireMember(pin), "not-member");
    }).pipe(Effect.scoped),
  );
  it.effect("ready lists only members whose alias pins the key the snapshot names", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.trust("a");
      h.state.inspections.set(`pen-${id("b")}`, Effect.succeed(trusted("b", "x")));
      h.state.inspections.set(
        `pen-${id("c")}`,
        Effect.succeed<Inspection>({ refused: "global-known-hosts" }),
      );
      h.state.inspections.set(
        `pen-${id("d")}`,
        Effect.fail(new PenAliasUnreadable({ alias: `pen-${id("d")}`, detail: "ssh -G failed" })),
      );
      h.watches[0]?.onSnapshot(snapshot(1, "a", "b", "c", "d"));
      yield* TestClock.adjust(0);
      assert.deepEqual(routes(h.last()), [
        ["box-a", "trusted"],
        ["box-b", "key-mismatch"],
        ["box-c", "global-known-hosts"],
        ["box-d", "unreadable"],
      ]);
      const ready = h.last();
      assert.equal(ready?.kind === "ready" && ready.selfNodeId, SELF);
      assert.equal(ready?.kind === "ready" && ready.meshId, MESH);
      assert.notInclude(h.state.inspected, `pen-${SELF}`);
      assert.deepEqual(yield* h.service.state, ready);
    }).pipe(Effect.scoped),
  );

  it.effect("this machine missing from the member list is not-member", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.watches[0]?.onSnapshot({ ...snapshot(1, "a"), self: id("z") });
      yield* TestClock.adjust(0);
      assert.equal(h.last()?.kind, "not-member");
      assert.deepEqual(h.state.inspected, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a dead socket is unavailable, and not-member only with Pen's left marker", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.trust("a");
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      yield* TestClock.adjust(0);
      h.watches[0]?.onStale("connect");
      yield* TestClock.adjust(0);
      assert.deepEqual(h.last(), { kind: "unavailable", seq: 2, reason: "daemon-down" });
      assert.isTrue(h.watches[0]?.stopped);
      h.state.left = true;
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 2);
      h.watches[1]?.onStale("closed");
      yield* TestClock.adjust(0);
      assert.deepEqual(h.last(), { kind: "not-member", seq: 3 });
    }).pipe(Effect.scoped),
  );

  it.effect("a PEN_HOME Pen would not use, or a missing Pen folder, is no-pen and unwatched", () =>
    Effect.gen(function* () {
      const relative = yield* harness({ stateDir: undefined });
      assert.deepEqual(relative.last(), { kind: "unavailable", seq: 1, reason: "no-pen" });
      assert.equal(relative.watches.length, 0);
      const missing = yield* harness({ exists: false });
      assert.deepEqual(missing.last(), { kind: "unavailable", seq: 1, reason: "no-pen" });
      assert.equal(missing.watches.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a member Pen has not written to ssh config yet is inspected once more 2 s later", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      yield* TestClock.adjust(0);
      assert.deepEqual(routes(h.last()), [["box-a", "not-in-pen-config"]]);
      h.trust("a");
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(routes(h.last()), [["box-a", "trusted"]]);
      yield* TestClock.adjust("10 seconds");
      assert.equal(h.state.inspected.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("the watch is retried on a backoff that doubles and resets after a snapshot", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.watches[0]?.onStale("connect");
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 2);
      h.watches[1]?.onStale("connect");
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 2);
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 3);
      h.watches[2]?.onSnapshot(snapshot(1));
      yield* TestClock.adjust(0);
      h.watches[2]?.onStale("gap");
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("requireTrusted refuses a member whose Noise key changed", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.trust("a");
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      yield* TestClock.adjust(0);
      assert.deepEqual(
        yield* h.service.requireTrusted(target("a"), id("a"), { requireReady: true }),
        { selfNodeId: SELF, selfName: "this-mac" },
      );
      h.state.inspections.set(`pen-${id("a")}`, Effect.succeed(trusted("a", "x")));
      const error = yield* Effect.flip(
        h.service.requireTrusted(target("a"), id("a"), { requireReady: false }),
      );
      assert.equal(error._tag, "SshInvalidTargetError");
      const other = yield* Effect.flip(
        h.service.requireTrusted(target("a"), id("b"), { requireReady: false }),
      );
      assert.equal(other._tag, "SshInvalidTargetError");
    }).pipe(Effect.scoped),
  );

  it.effect("while Pen is down a new credential is refused and a reconnect is allowed", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.trust("a");
      h.watches[0]?.onStale("connect");
      yield* TestClock.adjust(0);
      const error = yield* Effect.flip(
        h.service.requireTrusted(target("a"), id("a"), { requireReady: true }),
      );
      assert.equal(error._tag, "SshInvalidTargetError");
      assert.isUndefined(
        yield* h.service.requireTrusted(target("a"), id("a"), { requireReady: false }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a member a snapshot removed is refused before its other routes are inspected", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.trust("a", "b");
      h.watches[0]?.onSnapshot(snapshot(1, "a", "b"));
      yield* TestClock.adjust(0);
      const held = yield* Deferred.make<void>();
      h.state.inspections.set(`pen-${id("b")}`, Deferred.await(held).pipe(Effect.as(trusted("b"))));
      h.watches[0]?.onSnapshot(snapshot(2, "b"));
      yield* TestClock.adjust(0);
      assert.deepEqual(routes(h.last()), [
        ["box-a", "trusted"],
        ["box-b", "trusted"],
      ]);
      const error = yield* Effect.flip(
        h.service.requireTrusted(target("a"), id("a"), { requireReady: false }),
      );
      assert.equal(error._tag, "SshInvalidTargetError");
      const waiting = yield* h.service
        .requireTrusted(target("b"), id("b"), { requireReady: true })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(held, undefined);
      assert.deepEqual(yield* Fiber.join(waiting), { selfNodeId: SELF, selfName: "this-mac" });
      yield* TestClock.adjust(0);
      assert.deepEqual(routes(h.last()), [["box-b", "trusted"]]);
    }).pipe(Effect.scoped),
  );
});

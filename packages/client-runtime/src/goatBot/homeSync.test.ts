import { EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { resolveGoatBotHome, type GoatBotHomeTarget } from "./home.ts";
import { createGoatBotHomeSync } from "./homeSync.ts";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const c = EnvironmentId.make("c");
const winner: GoatBotHomeClaim = { environmentId: a, claimedAt: 100, claimId: "winner" };

function target(
  environmentId: EnvironmentId,
  overrides: Partial<GoatBotHomeTarget> = {},
): GoatBotHomeTarget {
  return {
    environmentId,
    connected: true,
    supportsHome: true,
    supportsBot: true,
    settingsLoaded: true,
    home: null,
    ...overrides,
  };
}

function fixture() {
  let time = 1_000;
  const onSettled = vi.fn();
  const randomId = vi.fn(() => "created");
  const write = vi.fn(async (_environmentId: EnvironmentId, _claim: GoatBotHomeClaim) => true);
  const controller = createGoatBotHomeSync({ now: () => time, randomId, onSettled });
  controller.setActive(true);
  const update = (
    targets: ReadonlyArray<GoatBotHomeTarget>,
    overrides: Partial<Parameters<typeof controller.update>[0]> = {},
  ) =>
    controller.update({
      targets,
      resolution: resolveGoatBotHome({ targets }),
      candidateId: a,
      writableIds: new Set([a, b, c]),
      write,
      ...overrides,
    });
  return {
    controller,
    update,
    write,
    onSettled,
    randomId,
    setTime: (value: number) => (time = value),
  };
}

async function settled() {
  await Promise.resolve();
  await Promise.resolve();
}

it("creates one claim on connected supporting writable targets, including non-bot replicas", async () => {
  const f = fixture();
  const targets = [
    target(a),
    target(b, { supportsBot: false }),
    target(c, { connected: false }),
    target(EnvironmentId.make("unsupported"), { supportsHome: false }),
    target(EnvironmentId.make("denied")),
  ];
  expect(f.update(targets)).toEqual({ nextWakeAt: null });
  expect(f.write.mock.calls).toEqual([
    [a, { environmentId: a, claimedAt: 1_000, claimId: "created" }],
    [b, { environmentId: a, claimedAt: 1_000, claimId: "created" }],
  ]);
  f.update(targets);
  await settled();
  f.update(targets);
  expect(f.randomId).toHaveBeenCalledTimes(1);
  expect(f.write).toHaveBeenCalledTimes(2);
});

it("does not claim a candidate without settings write permission", () => {
  const f = fixture();
  expect(f.update([target(a), target(b)], { writableIds: new Set([b]) })).toEqual({
    nextWakeAt: null,
  });
  expect(f.randomId).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});

it("waits for settings to load before creating a claim", () => {
  const f = fixture();
  f.update([], { candidateId: null });
  f.update([target(a, { settingsLoaded: false })]);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.randomId).not.toHaveBeenCalled();
  f.update([target(a)]);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("rewrites stale targets and backs failures off for 2s then 8s", async () => {
  const f = fixture();
  const targets = [target(a, { home: winner }), target(b)];
  f.write.mockResolvedValue(false);
  f.update(targets);
  expect(f.write).toHaveBeenCalledWith(b, winner);
  await settled();
  expect(f.update(targets)).toEqual({ nextWakeAt: 3_000 });
  f.setTime(2_999);
  f.update(targets);
  expect(f.write).toHaveBeenCalledTimes(1);
  f.setTime(3_000);
  expect(f.update(targets)).toEqual({ nextWakeAt: null });
  await settled();
  expect(f.update(targets)).toEqual({ nextWakeAt: 11_000 });
  expect(f.write).toHaveBeenCalledTimes(2);
  f.write.mockResolvedValue(true);
  f.setTime(11_000);
  f.update(targets);
  await settled();
  expect(f.update(targets)).toEqual({ nextWakeAt: null });
  expect(f.write).toHaveBeenCalledTimes(3);
});

it("does not rewrite successful writes until a new raw snapshot arrives", async () => {
  const f = fixture();
  const targets = [target(a, { home: winner }), target(b)];
  f.update(targets);
  await settled();
  f.setTime(61_000);
  expect(f.update(targets)).toEqual({ nextWakeAt: null });
  expect(f.write).toHaveBeenCalledTimes(1);
  f.update([target(a, { home: winner }), target(b, { home: { ...winner, claimedAt: 50 } })]);
  expect(f.write).toHaveBeenCalledTimes(2);
});

it("records inactive completions without waking and resumes the recorded backoff", async () => {
  const f = fixture();
  let finish!: (success: boolean) => void;
  f.write.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const targets = [target(a, { home: winner }), target(b)];
  f.update(targets);
  f.controller.setActive(false);
  finish(false);
  await settled();
  expect(f.onSettled).not.toHaveBeenCalled();
  f.controller.setActive(true);
  expect(f.update(targets)).toEqual({ nextWakeAt: 3_000 });
  expect(f.write).toHaveBeenCalledTimes(1);
  f.setTime(3_000);
  f.update(targets);
  await settled();
  expect(f.onSettled).toHaveBeenCalledTimes(1);
});

it("reactivates a pending write without duplicating it and wakes when it settles", async () => {
  const f = fixture();
  let finish!: (success: boolean) => void;
  f.write.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const targets = [target(a)];
  f.update(targets);
  f.controller.setActive(false);
  f.controller.setActive(true);
  f.update(targets);
  expect(f.write).toHaveBeenCalledTimes(1);
  finish(true);
  await settled();
  expect(f.onSettled).toHaveBeenCalledTimes(1);
  f.update(targets);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("uses the write supplied by a later update for new writes", async () => {
  const f = fixture();
  const laterWrite = vi.fn(async (_environmentId: EnvironmentId, _claim: GoatBotHomeClaim) => true);
  let finish!: (success: boolean) => void;
  f.update([], { candidateId: null, write: laterWrite });
  f.write.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  f.update([target(a, { home: winner }), target(b)]);
  f.update([target(a, { home: winner }), target(b), target(c)], { write: laterWrite });
  expect(f.write.mock.calls).toEqual([[b, winner]]);
  expect(laterWrite.mock.calls).toEqual([[c, winner]]);
  finish(false);
  await settled();
  expect(
    f.update([target(a, { home: winner }), target(b), target(c)], { write: laterWrite }),
  ).toEqual({
    nextWakeAt: 3_000,
  });
  f.setTime(3_000);
  f.update([target(a, { home: winner }), target(b), target(c)], { write: laterWrite });
  expect(laterWrite.mock.calls).toEqual([
    [c, winner],
    [b, winner],
  ]);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("stops retrying when settings write permission is revoked", async () => {
  const f = fixture();
  const targets = [target(a, { home: winner }), target(b)];
  f.write.mockResolvedValue(false);
  f.update(targets);
  await settled();
  f.setTime(3_000);
  expect(f.update(targets, { writableIds: new Set([a]) })).toEqual({ nextWakeAt: null });
  expect(f.write).toHaveBeenCalledTimes(1);
  f.update(targets);
  expect(f.write).toHaveBeenCalledTimes(2);
});

it("ignores pre-reconnect completions while the same claim retries on a new connection", async () => {
  const f = fixture();
  const completions: Array<(success: boolean) => void> = [];
  f.write.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
  const targets = [target(a, { home: winner }), target(b)];
  f.update(targets);
  f.update([targets[0]!, target(b, { connected: false })]);
  f.update(targets);
  expect(f.write).toHaveBeenCalledTimes(2);
  completions[0]!(false);
  await settled();
  f.setTime(3_000);
  expect(f.update(targets)).toEqual({ nextWakeAt: null });
  expect(f.write).toHaveBeenCalledTimes(2);
  completions[1]!(false);
  await settled();
  expect(f.update(targets)).toEqual({ nextWakeAt: 5_000 });
});

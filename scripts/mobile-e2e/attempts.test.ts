import { expect, it } from "vite-plus/test";

import { attemptPose } from "./attempts.ts";
import type { Pose } from "./poses.ts";
import { poolBlocked, type PoseResult } from "./report.ts";

const pose: Pose = {
  id: "android-phone-light",
  platform: "android",
  device: "Pixel 9",
  form: "phone",
  appearance: "light",
};
const launchError = {
  name: "launch error",
  checks: [{ name: "no error dialog on launch", pass: false, detail: "Could not connect" }],
};
const threads = {
  name: "threads",
  checks: [{ name: "thread list visible", pass: true, detail: "" }],
};

const attempts = (...results: ReadonlyArray<PoseResult>) => {
  const sessions: string[] = [];
  const attempt = async (session: string) => {
    sessions.push(session);
    return results[sessions.length - 1] ?? results[results.length - 1]!;
  };
  return { sessions, attempt };
};

it("an attempt that recorded an app failure before the pool failed is kept, not retried away", async () => {
  const { sessions, attempt } = attempts(
    { pose, steps: [launchError], error: "agent-device snapshot: Daemon connection closed" },
    { pose, steps: [threads] },
  );

  const result = await attemptPose(attempt, "run", () => {});

  expect(sessions).toEqual(["run"]);
  expect(result.steps).toEqual([launchError]);
  expect(poolBlocked(result)).toBe(false);
});

it("a pose the pool stopped before any app failure is retried on a fresh session", async () => {
  const { sessions, attempt } = attempts(
    { pose, steps: [threads], error: "agent-device snapshot: Daemon connection closed" },
    { pose, steps: [threads] },
  );

  const result = await attemptPose(attempt, "run", () => {});

  expect(sessions).toEqual(["run", "run-retry1"]);
  expect(result.error).toBeUndefined();
});

it("an app error after the first screen is not retried", async () => {
  const { sessions, attempt } = attempts({
    pose,
    steps: [threads],
    error: "the app did not show the fixture threads after pairing",
  });

  await attemptPose(attempt, "run", () => {});

  expect(sessions).toEqual(["run"]);
});

it("an app error before any recorded step is not retried", async () => {
  const { sessions, attempt } = attempts({
    pose,
    steps: [],
    error: "the app did not show the fixture threads after pairing (screen: New thread)",
  });

  const result = await attemptPose(attempt, "run", () => {});

  expect(sessions).toEqual(["run"]);
  expect(poolBlocked(result)).toBe(false);
});

it("a pool failure before the first screen is retried on a fresh session", async () => {
  const { sessions, attempt } = attempts(
    { pose, steps: [], error: "agent-device open: WORKER_UNREACHABLE" },
    { pose, steps: [threads] },
  );

  const result = await attemptPose(attempt, "run", () => {});

  expect(sessions).toEqual(["run", "run-retry1"]);
  expect(result.error).toBeUndefined();
});

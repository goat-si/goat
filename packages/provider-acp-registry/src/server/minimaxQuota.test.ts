import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { miniMaxQuotaWindows, makeMiniMaxQuotaReader } from "./minimaxQuota.ts";

const payload = (model: Record<string, unknown>) => ({
  base_resp: { status_code: 0 },
  model_remains: [model],
});

it("converts remaining quota to used quota and omits unlimited or invalid readings", () => {
  expect(
    miniMaxQuotaWindows(
      payload({
        current_interval_remaining_percent: 100,
        current_weekly_remaining_percent: 0,
        weekly_end_time: 1000,
      }),
    ),
  ).toEqual([
    { id: "session", kind: "session", label: "5h", usedPercent: 0 },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 100,
      resetsAt: "1970-01-01T00:00:01.000Z",
    },
  ]);
  expect(
    miniMaxQuotaWindows(
      payload({
        current_interval_status: 3,
        current_interval_remaining_percent: 0,
        current_weekly_remaining_percent: -1,
      }),
    ),
  ).toEqual([]);
  expect(
    miniMaxQuotaWindows({
      ...payload({ current_interval_remaining_percent: 99 }),
      base_resp: { status_code: 1004 },
    }),
  ).toEqual([]);
});

it.effect("uses the instance's signed-in region and skips expired or signed-out credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reader = yield* makeMiniMaxQuotaReader;
    const dir = yield* fs.makeTempDirectoryScoped();

    const profile = path.join(dir, "auth/prod/en/mcode-public");
    yield* fs.makeDirectory(profile, { recursive: true });
    const state = {
      region: "en",
      storeKind: "file",
      generation: 2,
      audience: "agent-backend",
      status: "authenticated",
    };
    const stateFile = path.join(profile, "auth-state.json");
    yield* fs.writeFileString(stateFile, JSON.stringify(state));
    const credential = {
      ...state,
      clientId: "mcode-public",
      accessToken: "fixture",
      expiresAtMs: Date.UTC(2100, 0, 1),
    };
    const save = (expiresAtMs: number) =>
      fs.writeFileString(
        path.join(profile, "auth.json"),
        JSON.stringify({ records: { profile: { ...credential, expiresAtMs } } }),
      );
    yield* save(credential.expiresAtMs);
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(payload({ current_weekly_remaining_percent: 85 })),
      );
    const read = () => reader({ MINIMAX_DATA_DIR: dir }, request);
    expect((yield* read())?.windows[0]?.usedPercent).toBe(15);
    expect(String(request.mock.calls[0]?.[0])).toMatch(/^https:\/\/platform\.minimax\.io\//);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
    yield* save(0);
    expect(yield* read()).toBeUndefined();
    yield* save(credential.expiresAtMs);
    yield* fs.writeFileString(stateFile, JSON.stringify({ ...state, status: "logged_out" }));
    expect(yield* read()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

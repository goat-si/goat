import type { ServerProviderUsageWindow } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import type { AcpRegistrySettings } from "../settings.ts";

export function isMiniMaxCode(settings: AcpRegistrySettings): boolean {
  if (settings.source === "registry")
    return settings.agentId === "minimax-code" && !settings.commandPath;
  return (
    /^mcode(?:\.cmd|\.exe)?$/i.test(settings.commandPath.split(/[\\/]/).at(-1) ?? "") &&
    settings.commandArgs.length === 1 &&
    settings.commandArgs[0] === "acp"
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const hosts = { cn: "https://www.minimaxi.com", en: "https://platform.minimax.io" };

export function miniMaxQuotaWindows(payload: unknown): ServerProviderUsageWindow[] {
  const response = record(payload);
  if (record(response?.base_resp)?.status_code !== 0 || !Array.isArray(response?.model_remains))
    return [];
  // MCode uses the first model entry for the account's shared text quota.
  const model = record(response.model_remains[0]);
  if (!model) return [];
  const windows: ServerProviderUsageWindow[] = [];
  for (const [key, kind, label, reset] of [
    ["current_interval", "session", "5h", "end_time"],
    ["current_weekly", "weekly", "Weekly", "weekly_end_time"],
  ] as const) {
    if (model[key + "_status"] === 3) continue; // Unlimited.
    const remaining = model[key + "_remaining_percent"];
    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 100
    )
      continue;
    const end = model[reset];
    const date = typeof end === "number" && end > 0 ? DateTime.make(end) : Option.none();
    windows.push({
      id: kind,
      kind,
      label,
      usedPercent: 100 - remaining,
      ...(Option.isSome(date) ? { resetsAt: DateTime.formatIso(date.value) } : {}),
    });
  }
  return windows;
}

export const makeMiniMaxQuotaReader = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const readRecord = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.map(record),
      Effect.orElseSucceed(() => undefined),
    );
  return Effect.fn("MiniMaxCode.readQuota")(function* (env: NodeJS.ProcessEnv, request = fetch) {
    if (env.MAVIS_BUILD_ENV && env.MAVIS_BUILD_ENV !== "prod") return;
    const dir =
      env.MINIMAX_DATA_DIR ||
      env.MAVIS_DATA_DIR ||
      path.join(env.HOME || env.USERPROFILE || home, ".minimax");
    const authDir = (region: keyof typeof hosts) =>
      path.join(dir, "auth", "prod", region, "mcode-public");
    const [cn, en, preference] = yield* Effect.all([
      readRecord(path.join(authDir("cn"), "auth-state.json")),
      readRecord(path.join(authDir("en"), "auth-state.json")),
      readRecord(path.join(dir, "preferences", "mcode-region.json")),
    ]);
    // Match MCode's explicit region, saved preference, then sole signed-in region or CN.
    const hasLogin = (state: typeof cn) =>
      ["authorizing", "authenticated", "refreshing", "scope_upgrade_required", "expired"].some(
        (s) => s === state?.status,
      );
    const region =
      env.MAVIS_REGION ||
      record(preference?.regions)?.prod ||
      (hasLogin(en) && !hasLogin(cn) ? "en" : "cn");
    if (region !== "cn" && region !== "en") return;
    const state = region === "cn" ? cn : en;
    if (state?.status !== "authenticated" || state.region !== region || state.storeKind !== "file")
      return;
    const credentials = yield* readRecord(path.join(authDir(region), "auth.json"));
    const records = Object.values(record(credentials?.records) ?? {})
      .map(record)
      .filter(
        (entry) =>
          entry?.clientId === "mcode-public" &&
          entry.audience === state.audience &&
          entry.generation === state.generation,
      );
    if (records.length !== 1) return;
    const credential = records[0];
    if (
      typeof credential?.accessToken !== "string" ||
      !credential.accessToken ||
      typeof credential.expiresAtMs !== "number" ||
      credential.expiresAtMs <= (yield* Clock.currentTimeMillis)
    )
      return;
    const windows = yield* Effect.tryPromise(async (signal) => {
      const result = await request(
        new URL(
          "/v1/api/openplatform/coding_plan/remains?business=Agent&device_platform=mcode",
          hosts[region],
        ),
        {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + credential.accessToken,
          },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        },
      );
      return result.ok ? miniMaxQuotaWindows(await result.json()) : [];
    }).pipe(Effect.orElseSucceed(() => []));
    return windows.length
      ? { checkedAt: DateTime.formatIso(yield* DateTime.now), windows }
      : undefined;
  });
});

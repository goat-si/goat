// @effect-diagnostics nodeBuiltinImport:off -- private file descriptor flags and POSIX identity aren't available via Effect FileSystem.
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_BYTES = 64 * 1024;
const CLIENT = "mcode-public";
const AUDIENCE = "agent-backend";
const ORIGINS = {
  cn: { account: "https://agent.minimaxi.com", quota: "https://www.minimaxi.com" },
  en: { account: "https://agent.minimax.io", quota: "https://platform.minimax.io" },
} as const;

type Region = keyof typeof ORIGINS;
type Json = Record<string, unknown>;
type ReadJson = (path: string) => Promise<Json | undefined>;
const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const region = (value: unknown): Region | undefined =>
  value === "cn" || value === "en" ? value : undefined;

async function readPrivateJson(path: string, uid: number): Promise<Json | undefined> {
  try {
    // Refuse redirected paths, devices, symlinks, foreign owners, and non-private files.
    if ((await NodeFSP.realpath(path)) !== path) return;
    const parent = await NodeFSP.stat(NodePath.dirname(path));
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) return;
    const before = await NodeFSP.lstat(path);
    if (!before.isFile()) return;
    const file = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) return;
      if (metadata.size === 0 || metadata.size > MAX_BYTES) return;
      if (before.dev !== metadata.dev || before.ino !== metadata.ino) return;
      if ((await NodeFSP.realpath(path)) !== path) return;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_BYTES) return;
      return record(JSON.parse(bytes.toString("utf8", 0, offset)));
    } finally {
      await file.close();
    }
  } catch {
    // Never attach credential-bearing parse errors or environment paths to a log.
    return;
  }
}

function profileRoot(env: NodeJS.ProcessEnv, args: readonly string[]) {
  if (args.length !== 1 || args[0] !== "acp") return;
  if (env.MAVIS_BUILD_ENV && env.MAVIS_BUILD_ENV !== "prod") return;
  // Require the same explicit profile root used to launch the agent. Without it,
  // MCode can select a different profile based on the project or runtime state.
  const root = env.MINIMAX_DATA_DIR?.trim();
  if (!root || !NodePath.isAbsolute(root)) return;
  return NodePath.resolve(root);
}

function authDir(root: string, selected: Region) {
  return NodePath.join(root, "auth", "prod", selected, CLIENT);
}

async function chooseRegion(read: ReadJson, root: string, configured: string | undefined) {
  if (configured) return region(configured);
  const preference = await read(NodePath.join(root, "preferences", "mcode-region.json"));
  return preference?.version === 1 ? region(record(preference.regions)?.prod) : undefined;
}

async function readLogin(read: ReadJson, root: string, selected: Region, now: number) {
  const directory = authDir(root, selected);
  const state = await read(NodePath.join(directory, "auth-state.json"));
  if (
    state?.schemaVersion !== 2 ||
    state.status !== "authenticated" ||
    state.storeKind !== "file" ||
    state.buildEnv !== "prod" ||
    state.region !== selected ||
    state.clientId !== CLIENT ||
    state.audience !== AUDIENCE ||
    !Number.isSafeInteger(state.generation)
  ) {
    return;
  }
  const payload = await read(NodePath.join(directory, "auth.json"));
  if (payload?.schemaVersion !== 1) return;
  const account = NodeCrypto.createHash("sha256")
    .update(NodePath.join(root, "auth") + "\0" + CLIENT)
    .digest("base64url");
  const key = `com.minimax.mcode.oauth.prod.${selected}\0${account}`;
  const login = record(record(payload.records)?.[key]);
  const token = login?.accessToken;
  if (
    login?.schemaVersion !== 1 ||
    login.clientId !== CLIENT ||
    login.audience !== AUDIENCE ||
    login.tokenType !== "Bearer" ||
    login.generation !== state.generation ||
    login.expiresAtMs !== state.expiresAtMs ||
    typeof login.expiresAtMs !== "number" ||
    !Number.isFinite(login.expiresAtMs) ||
    login.expiresAtMs <= now + 4_000 ||
    typeof token !== "string" ||
    token.length > 8192 ||
    !/^[A-Za-z0-9._~+/=-]+$/.test(token)
  ) {
    return;
  }
  return { token, generation: login.generation };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Json | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) return;
    const bytes = Buffer.alloc(MAX_BYTES);
    let offset = 0;
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return record(JSON.parse(bytes.toString("utf8", 0, offset)));
      if (offset + value.byteLength > MAX_BYTES) return;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function personalGroup(payload: Json | undefined): string | undefined {
  if (!payload) return;
  const code = record(payload.statusInfo)?.code;
  const baseCode = record(payload.base_resp)?.status_code;
  if ((code ?? baseCode) !== 0 || (baseCode !== undefined && baseCode !== 0)) return;
  const workspaces = payload.workspaces ?? record(payload.data)?.workspaces;
  if (!Array.isArray(workspaces)) return;
  const personal = workspaces.map(record).filter((workspace) => workspace?.workspace_type === 0);
  if (personal.length !== 1 || personal[0]?.has_token_plan === false) return;
  const workspace = personal[0]?.workspace_id;
  if (
    !(typeof workspace === "string" && /^[0-9]{1,32}$/.test(workspace)) &&
    !(typeof workspace === "number" && Number.isSafeInteger(workspace) && workspace > 0)
  )
    return;
  const group = personal[0]?.op_group_id;
  if (typeof group === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(group)) return group;
}

function quotaWindows(payload: Json | undefined): ServerProviderUsageWindow[] {
  if (record(payload?.base_resp)?.status_code !== 0 || !Array.isArray(payload?.model_remains)) {
    return [];
  }
  // MCode interprets the first row as its shared 5-hour and weekly text plan.
  const model = record(payload.model_remains[0]);
  if (!model) return [];
  const windows: ServerProviderUsageWindow[] = [];
  for (const [key, kind, label, reset, duration] of [
    ["current_interval", "session", "5h", "end_time", 300],
    ["current_weekly", "weekly", "Weekly", "weekly_end_time", 10080],
  ] as const) {
    if (model[key + "_status"] === 3) continue; // Unlimited.
    const remainingValue = model[key + "_remaining_percent"];
    const total = model[key + "_total_count"];
    // In the legacy payload, usage_count is the remaining quantity, not used.
    const count = model[key + "_usage_count"];
    const fromCounts =
      typeof total === "number" &&
      Number.isFinite(total) &&
      total > 0 &&
      typeof count === "number" &&
      Number.isFinite(count) &&
      count >= 0 &&
      count <= total
        ? (count / total) * 100
        : undefined;
    const remaining = remainingValue ?? fromCounts;
    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 100
    ) {
      continue;
    }
    const end = model[reset];
    const date = typeof end === "number" && end > 0 ? DateTime.make(end) : Option.none();
    windows.push({
      id: kind,
      kind,
      label,
      usedPercent: 100 - remaining,
      windowDurationMins: duration,
      ...(Option.isSome(date) ? { resetsAt: DateTime.formatIso(date.value) } : {}),
    });
  }
  return windows;
}

export const makeMiniMaxCodeQuotaReader = Effect.fnUntraced(function* (
  request: typeof fetch = fetch,
) {
  const uid = yield* HostProcess.UserId;
  return Effect.fnUntraced(function* (env: NodeJS.ProcessEnv, args: readonly string[]) {
    const root = profileRoot(env, args);
    if (root === undefined || uid === undefined || !NodeFS.constants.O_NOFOLLOW) return;
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: async (signal): Promise<ServerProviderUsageLimits | undefined> => {
        // realpath also handles operating system aliases such as /var on macOS.
        // Do not accept a symlinked data directory, which would change the account key.
        if ((await NodeFSP.realpath(root)) !== root) return;
        const read = (path: string) =>
          signal.aborted ? Promise.resolve(undefined) : readPrivateJson(path, uid);
        const selected = await chooseRegion(read, root, env.MAVIS_REGION);
        if (!selected) return;
        const login = await readLogin(read, root, selected, now);
        if (!login || signal.aborted) return;
        const stillSignedIn = async () => {
          if ((await chooseRegion(read, root, env.MAVIS_REGION)) !== selected) return false;
          const current = await readLogin(read, root, selected, now);
          return (
            !signal.aborted &&
            current?.token === login.token &&
            current.generation === login.generation
          );
        };

        const origin = ORIGINS[selected];
        const headers = { Accept: "application/json", Authorization: "Bearer " + login.token };
        // Private MiniMax routes observed in MCode. Do not invent a group ID or try
        // unrelated endpoints: an unproven personal workspace must show no quota.
        const identity = await request(
          new URL("/matrix/api/v1/user/get_user_extra_info", origin.account),
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: "{}",
            redirect: "error",
            signal,
          },
        );
        const group = personalGroup(await boundedJson(identity, signal));
        if (!group || !(await stillSignedIn())) return;
        const response = await request(
          new URL("/v1/api/openplatform/coding_plan/remains", origin.quota),
          {
            method: "GET",
            headers: { ...headers, "X-Group-Id": group },
            redirect: "error",
            signal,
          },
        );
        const windows = quotaWindows(await boundedJson(response, signal));
        if (!windows.length || signal.aborted) return;
        // Discard responses that raced an account/region change or token rotation.
        if (!(await stillSignedIn())) return;
        return { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), windows };
      },
      catch: () => undefined,
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.undefined }),
    );
  });
});

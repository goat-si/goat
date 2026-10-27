> Stale check @852ebfb51 — source-only verification at `852ebfb51a2190e32bd572830c9f1aa8e0ab8588`; no builds, tests, SSH, or probe execution performed. wp2/wp3/wp6/wp4 renames are present. Live release availability, credentials, remote state and end-to-end behavior remain unverified.

# 040 — wp5: end-to-end runtime preparation and probe on juns-macbook-pro

## Loop spec

- Archetype: satisfy-spec verification cycle (no production code expected; fixes found here loop back to the owning decade doc via P amendment).
- Trigger: user asked to run a Claude Opus 5.5 probe on the MacBook Pro; the dispatch failed with a pingdotgg 404 (Finding F1).
- Goal: from the integrated branch (wp2/wp3/wp6/wp4 done), GOAT prepares its runtime on juns-macbook-pro without any pingdotgg request, launches a GOAT server isolated from the host's upstream `~/.t3` state, and a read-only probe thread completes with claude-opus-5-5.
- Non-goals: publishing a release; restarting the user's running dev app (pid 89653/90578); touching `~/.t3/userdata`, `~/.t3/ssh-launch`, or `~/.t3/runtime` on the host; pushing.
- Verifier: captured command output in `evidence/wp5-*.txt` (see steps); acceptance listed below.
- Stop: probe turn reports hostname/whoami/pwd/sw_vers/date and the model, or a documented blocker.
- Memory artifact: this doc + evidence/.
- Outcomes: DONE; BLOCKED (SSH/gh/build failure with evidence); NEEDS_HUMAN if D7 is not ~/.goat (then this cycle must not launch a server against `~/.t3/userdata`).
- Escalation: any step that would write under the host's `~/.t3`.

## Preconditions

- D7 decided as `~/.goat` (remote root) and implemented in wp4 (030 §D7-A).
- juns-macbook-pro is this Mac (Finding F1): the SSH target shares the filesystem with the source worktree, so "remote" paths below are local paths reached over SSH. Evidence still goes through the real SSH path.

## Steps

Paths assume D7-A: GOAT root on the host is `~/.goat`, runtime `~/.goat/runtime/goat/versions/<v>`, state `~/.goat/ssh-launch`, server home `~/.goat`.

0. Cold-host precondition and snapshot: `ssh juns-macbook-pro 'ls -la ~/.goat 2>&1; ls -la ~/.t3/ssh-launch/*/ ~/.t3/runtime/versions; shasum -a 256 ~/.t3/ssh-launch/*/run-t3.sh'` → `evidence/wp5-before.txt`. If `~/.goat` already exists, record it and do not delete it; use a fresh version suffix only if the user agrees (NEEDS_HUMAN), otherwise continue with explicit artifact-identity checks below.
1. Build identity: `git -C /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename rev-parse HEAD`, `git status --short` (must be clean), `jq -r .version apps/server/package.json` → `evidence/wp5-build-id.txt`.
2. Build inputs for the archive (commands verified against `852ebfb51`; execute only in the parent's authorized build/probe phase):
   a. `vp run --filter t3 build` (web client into apps/server/dist/client).
   b. With **Node 25.7+** as the build host and `vp` available, run `node apps/server/scripts/cli.ts build-exe --target darwin-arm64`. Target output is `apps/server/dist-exe/goat-darwin-arm64`; the default host build is `apps/server/dist-exe/goat`. The archive script prefers the target output and accepts the unsuffixed binary only on a matching darwin-arm64 host (`apps/server/scripts/cli.ts:110-164`, `apps/server/vite.config.ts:29-60,82-95`, `scripts/build-cli-archive.ts:470-487`). The SEA embeds pinned Node `26.8.2`; source-harness Node 24 is a separate prerequisite.
   c. Resource monitor: the read-only stale check found an executable **Mach-O arm64** helper at `native/resource-monitor/target/release/t3-resource-monitor`. During the build phase, stage that existing binary with `mkdir -p /tmp/goat-wp5/resource-monitor/darwin-arm64` and `install -m 755 native/resource-monitor/target/release/t3-resource-monitor /tmp/goat-wp5/resource-monitor/darwin-arm64/t3-resource-monitor`; record its origin/hash. Pass the **parent directory** `/tmp/goat-wp5/resource-monitor` to `--resource-monitor-dir`, yielding archive member `resource-monitor/darwin-arm64/t3-resource-monitor`. Do not pass the binary or its `darwin-arm64` directory. If a rebuild is needed, the repository command is `vp run build:resource-monitor` (`package.json:26`), not a nonexistent staging script; it produces the native build output, which still needs staging. An existing archive/runtime copy is also usable with recorded origin. Layout sources: `scripts/build-cli-archive.ts:489-511,576-581`, `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts:133-155`.
   d. macOS signing: `build-cli-archive` signs `goat` and native helpers/addons; without `T3CODE_CLI_MAC_SIGN_IDENTITY` it uses identity `-` (ad hoc), then returns without notarization (`scripts/build-cli-archive.ts:299-335`). There is no unsigned CLI flag. Retain any actual signing failure and return to the owning phase; do not modify signing code here.
   e. `node scripts/build-cli-archive.ts --platform mac --arch arm64 --version 0.0.45 --resource-monitor-dir /tmp/goat-wp5/resource-monitor --output-dir /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.t3/runtime/archives` → expect `goat-0.0.45-darwin-arm64.tar.gz` with `goat-0.0.45-darwin-arm64/goat` and the helper member from step 2c. These flags are defined at `scripts/build-cli-archive.ts:567-584`. Record `tar -tzf` members and archive sha256. Extract the **post-signing archived binary** with `tar -xOf /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.t3/runtime/archives/goat-0.0.45-darwin-arm64.tar.gz goat-0.0.45-darwin-arm64/goat > /tmp/goat-wp5/packaged-goat`; require exit 0 before running `shasum -a 256 /tmp/goat-wp5/packaged-goat`. The pre-signing `dist-exe` file is not the comparison input, and the script's temporary staging directory is scoped and removed → `evidence/wp5-archive.txt`.
3. gh failure path on a cold cache (live only when step 0 shows the requested runtime is absent and no retained ready runner short-circuits preparation; if either is ready remotely, record live gh acquisition as UNOBSERVED and rely on the hermetic wp2 gh evidence): `gh release view v0.0.45 -R goat-si/goat`. If the release remains unpublished, expect not found; release availability was not checked by this leaf. Run `prepareRemoteRuntime` via the Harness script against juns-macbook-pro with `archiveDirectory` = empty temp dir and no mirror → expect the D3 `SshLaunchError` naming goat-si/goat, v0.0.45, goat-0.0.45-darwin-arm64.tar.gz. The integrated source calls local `gh release download`, requesting that asset plus `SHA256SUMS`, and uploads only after successful acquisition/checksum validation (`packages/ssh/src/runtimeArchiveGh.ts:46-153`, `tunnel.ts:1188-1212`). Retain the actual refusal and before/after remote staging observations; absence of curl text alone is not live proof. If the release now exists, mark the expected-missing-release criterion UNOBSERVED and refer its disposition to the parent → `evidence/wp5-gh-missing.txt`.
4. Upload path: same script with `archiveDirectory=/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.t3/runtime/archives`. Then `ssh juns-macbook-pro 'cat ~/.goat/runtime/goat/versions/0.0.45/.install-complete; shasum -a 256 ~/.goat/runtime/goat/versions/0.0.45/goat; ~/.goat/runtime/goat/versions/0.0.45/goat --version'`; the installed binary hash must equal step 2e's post-signing archived binary hash → `evidence/wp5-remote-runtime.txt`.
5. Dispatch probe through the isolated source server in Harness (`--base-dir /tmp/goat-wp5/server-home`, PID captured at spawn): call `goat_ssh_thread_launch` with the exact Harness arguments. The message restricts work to reads; the thread uses `approval-required`, the most restrictive supported runtime mode (`read-only` is a sandbox/session access value, not a RuntimeMode). Evidence: launched remote process `ps -o pid,command` showing `~/.goat/runtime/goat/versions/0.0.45/goat serve ... --base-dir ~/.goat`, the remote `~/.goat/ssh-launch/<resolved-key>/run-t3.sh` hash, completed remote run, probe reply, and activity tool ids `goat_*` / `mcp__goat__goat_*` → `evidence/wp5-probe.txt`. Stop only the source server and SSH forward PIDs captured by Harness; leave the remote GOAT server per `leaveRemoteServerRunning`.
6. Gates: `ssh juns-macbook-pro "grep -c pingdotgg ~/.goat/ssh-launch/*/run-t3.sh"` → 0; step 0 snapshot of `~/.t3` re-taken and diffed → identical → `evidence/wp5-after.txt`.

## Harness

This is code to materialize and run **during wp5**, after wp2 → wp3 → wp6 → wp4. The plan amendment itself does not run it. All helper files, credentials, local server state and first-capture output live under `/tmp/goat-wp5/`; no helper is placed in the source worktree. Save each complete code block at the stated absolute path. Run the setup first:

```sh
umask 077
mkdir -p /tmp/goat-wp5
node --version
```

Use Node 24 for the source Harness, matching the root `package.json` engine `^24.13.1`; source scripts already use `node scripts/*.ts`, and server dev uses `node --watch src/bin.ts` (`apps/server/package.json:19`). The earlier amendment recorded Node **v24.17.0** and no `vp` on that leaf's PATH; those environment observations were not refreshed by this stale check. The Harness uses `node --experimental-strip-types` and installed source dependencies. Step 2b separately requires a **Node 25.7+ build host** and `vp`; switching build hosts does not change the source Harness's Node 24 requirement. No commands here have been executed as probes or tests by this leaf.

All source anchors below are relative to `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename` at verified HEAD `852ebfb51`. The integrated contracts use `goat_*` MCP tools, provider MCP key `goat`, executable `goat`, SSH root `~/.goat`, and runtime `~/.goat/runtime/goat/versions/<v>/goat`. Source functions named `prepareRemoteRuntime`, `remoteStateKey`, etc. keep their TypeScript names; npm/workspace package identities stay `@t3tools/*` per D8. The SSH wrapper filename deliberately remains `run-t3.sh` under `~/.goat/ssh-launch/<key>/`; do not rename that file in these commands.

### Effect dependencies and runtime preparation

`/tmp/goat-wp5/effect-runtime.ts`:

```ts
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const source = "/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename";
// /tmp has no node_modules. Resolve ESM package exports from the SSH package,
// whose installed dependencies are the ones the imported source uses.
const fromSsh = createRequire(`${source}/packages/ssh/package.json`);
const load = (name: string) => import(pathToFileURL(fromSsh.resolve(name)).href);
export const Effect = await load("effect/Effect");
export const Exit = await load("effect/Exit");
export const Cause = await load("effect/Cause");
export const Crypto = await load("effect/Crypto");
export const FileSystem = await load("effect/FileSystem");
export const Path = await load("effect/Path");
export const { ChildProcessSpawner } = await load("effect/process");
export const NodeServices = await load("@effect/platform-node/NodeServices");
```

Imports/layers: `packages/ssh/src/tunnel.ts:19-32`, `packages/ssh/src/tunnel.test.ts:1-19`, and `packages/ssh/package.json` dependency blocks. The installed `packages/ssh/node_modules/@effect/platform-node/src/NodeServices.ts:34-53` provides **ChildProcessSpawner, Crypto, FileSystem and Path**, plus Stdio/Terminal. `HostProcess.Platform` and related references have default values (`packages/shared/src/HostProcess.ts:6-16`); this preparation/observer harness does not require an HTTP-client or Net layer. Preserve the real NodeServices layer. Package-relative `createRequire` is used in `scripts/lib/third-party-licenses.ts:472`; URL-based dynamic imports appear in `scripts/build-desktop-artifact.ts:588-589`.

`/tmp/goat-wp5/prepare-runtime.ts`:

```ts
import { resolve } from "node:path";
import { prepareRemoteRuntime } from "/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts";
import {
  resolveSshTarget,
  remoteStateKey,
} from "/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/command.ts";
import {
  Effect,
  Exit,
  Cause,
  NodeServices,
  Crypto,
  FileSystem,
  Path,
  ChildProcessSpawner,
} from "./effect-runtime.ts";

if (!process.argv[2]) throw new Error("usage: prepare-runtime.ts <archive-directory>");
const alias = "juns-macbook-pro";
const authOptions = { batchMode: "yes" as const, interactiveAuth: false };
const runner = {
  archiveVersion: "0.0.45",
  archiveDirectory: resolve(process.argv[2]),
  keepExistingRunner: true, // Match the source server's SSH dispatch policy.
};
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    // Resolve each required live service before touching SSH.
    yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Crypto.Crypto;
    yield* FileSystem.FileSystem;
    yield* Path.Path;
    const target = yield* resolveSshTarget(alias);
    const stateKey = yield* remoteStateKey(target);
    if (!/^[a-f0-9]{16}$/.test(stateKey)) throw new Error("invalid remote state key");
    yield* prepareRemoteRuntime(target, authOptions, runner, stateKey);
    return { target, stateKey };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
const ok = !Exit.isFailure(result);
console.log(
  JSON.stringify({
    ok,
    alias,
    runner,
    ...(ok ? result.value : { error: Cause.pretty(result.cause) }),
  }),
);
process.exitCode = ok ? 0 : 1;
```

Target fields are exactly `packages/contracts/src/ipc.ts:388-394`. Resolve the alias as the manager does (`packages/ssh/src/command.ts:333-358`, `tunnel.ts:2085-2091`) before hashing its state key (`command.ts:76-83`). Runner fields are `tunnel.ts:75-101`; the verified signature is **`prepareRemoteRuntime(target, authOptions, runner?, stateKey?)`** (`tunnel.ts:1128-1133`), with auth fields at `packages/ssh/src/auth.ts:31-35`. The fourth argument enables retained-runner probing when `keepExistingRunner` is true; omitting it remains valid but would skip that policy. This helper follows current dispatch's `keepExistingRunner: true` (`apps/server/src/sshRemote/SshRemoteDispatch.ts:605-619`). A retained ready runner can short-circuit even when the requested version is cold; a retained missing runtime fails without replacing its runner. Retain/report that evidence and return to the parent rather than removing/replacing it. `prepareRemoteRuntime` returns `void`; the helper's outer effect adds target/key metadata. `{ok:true}` records successful preparation/reuse, **not** whether upload or gh was exercised. Step 0's cold-version/runner observations and step 4's independent hash establish that distinction. No `releaseBaseUrl` is passed; explicitly remove an ambient mirror for the isolated server below.

Exact step-3/4 invocations (run individually; the expected step-3 failure depends on a cold remote/runner, empty local cache and a still-absent release):

```sh
mkdir -p /tmp/goat-wp5/empty-archives
gh release view v0.0.45 -R goat-si/goat > /tmp/goat-wp5/gh-release.txt 2>&1
printf 'exit=%s\n' "$?"
node --experimental-strip-types /tmp/goat-wp5/prepare-runtime.ts /tmp/goat-wp5/empty-archives > /tmp/goat-wp5/prepare-missing.txt 2>&1
printf 'exit=%s\n' "$?"
node --experimental-strip-types /tmp/goat-wp5/prepare-runtime.ts /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.t3/runtime/archives > /tmp/goat-wp5/prepare-upload.txt 2>&1
printf 'exit=%s\n' "$?"
```

Record each exit code immediately (`printf 'exit=%s\n' "$?"`); do not batch the expected failure under `set -e`. Check `empty-archives` is empty at run time. The **wp2 gh path is present** at `852ebfb51`: `tunnel.ts:1195-1197` falls back from a local-cache miss to `downloadRuntimeArchiveWithGh`, whose command and contextual errors are at `runtimeArchiveGh.ts:46-125`. Do not run step 3 when the requested version or retained runner is ready, or if the release check invalidates the missing-release precondition. Step 4 remains subject to its hash gate even on successful reuse.

### Fetch MCP client, launch arguments and completion observation

External authentication requires a bearer session with **subject `mcp-client`**, not a browser pairing token. There is no `--role` flag. Local launch gets only `orchestration:read` + `orchestration:operate`, with `--runtime-mode-ceiling full-access`, because SSH launch registers projects and uses `writesEnvironment`. The remote observer gets only `orchestration:read`, which maps to read-only client access. Sources: `apps/server/src/cli/auth.ts:55-90,172-208`, `cli/authScopes.ts:3-10`, `auth/EnvironmentAuth.ts:1200-1218`, `mcp/McpToolAccess.ts:238-255`, `mcp/toolkits/ssh/handlers.ts:54-75`. The ceiling controls caller authority; the launched thread still explicitly receives `approval-required`.

`RuntimeMode` permits only `approval-required`, `auto-accept-edits`, `auto`, `full-access` (`packages/contracts/src/providerPolicy.ts:25-35`); `read-only` at lines 18-23 is a distinct sandbox enum. This probe is limited to reads by its message, with approvals enforced by the most restrictive allowed mode. If Claude requests approval, retain the thread and report NEEDS_HUMAN; never raise the mode automatically. The Harness uses canonical `modelSelection: { instanceId, model }`; historical `modelSelection.provider` remains accepted compatibility input (`packages/contracts/src/modelSelection.ts:16-58`). This provider-instance selection is separate from the Claude MCP server key `goat`.

`/tmp/goat-wp5/mcp-client.ts`:

```ts
import { readFile, writeFile, open } from "node:fs/promises";

export class Client {
  session: string | null = null;
  protocol = "2025-06-18";
  sequence = 0;
  endpoint: string;
  token: string;
  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint;
    this.token = token;
  }
  async send(method: string, params?: unknown, notification = false) {
    const id = ++this.sequence;
    const response = await fetch(this.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        "mcp-protocol-version": this.protocol,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id }),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    this.session = response.headers.get("mcp-session-id") ?? this.session;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`MCP ${method}: HTTP ${response.status}`);
    }
    if (notification || response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      if (!notification) throw new Error(`MCP ${method}: missing response`);
      return;
    }
    const select = (payload) => {
      if (payload.id !== id) return undefined;
      if (payload.error) throw new Error(JSON.stringify(payload.error));
      return { result: payload.result };
    };
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const found = select(await response.json());
      if (!found) throw new Error(`MCP ${method}: unmatched JSON-RPC id`);
      return found.result;
    }
    // A stream need not close after its result; stop at the matching id.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const found = select(JSON.parse(data));
          if (found) return found.result;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    throw new Error(`MCP ${method}: stream ended without matching result`);
  }
  async catalog() {
    const initialized = await this.send("initialize", {
      protocolVersion: this.protocol,
      capabilities: {},
      clientInfo: { name: "goat-wp5-external-probe", version: "1" },
    });
    this.protocol = initialized.protocolVersion;
    if (initialized.serverInfo?.name !== "GOAT") throw new Error("server name is not GOAT");
    await this.send("notifications/initialized", undefined, true);
    const tools = [];
    let cursor;
    do {
      const page = await this.send("tools/list", cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of ["goat_ssh_thread_launch", "goat_thread_read", "goat_thread_wait"])
      if (!names.has(name)) throw new Error(`missing integrated tool ${name}`);
    if (tools.some((tool) => tool.name.startsWith("t3_"))) throw new Error("legacy live t3_* tool");
    return { initialize: initialized, tools };
  }
  async call(name: string, args: unknown) {
    const result = await this.send("tools/call", { name, arguments: args });
    const text = result.content?.find((block) => block.type === "text")?.text;
    const payload = result.structuredContent ?? (text ? JSON.parse(text) : undefined);
    if (result.isError || payload?.code || payload === undefined)
      throw new Error(`tool ${name} refused: ${JSON.stringify(payload)}`);
    return payload;
  }
}

async function readAll(client: Client, threadId: string, view: string) {
  const pages = [];
  let afterPosition;
  do {
    const page = await client.call("goat_thread_read", {
      threadId,
      view,
      limit: 100,
      runLimit: 50,
      maxCharsPerItem: 50_000,
      ...(afterPosition === undefined ? {} : { afterPosition }),
    });
    pages.push(page);
    if (page.items.some((item) => item.textTruncated))
      throw new Error(
        "NEEDS_HUMAN: recover truncated text with itemId/textOffset before acceptance",
      );
    if (!page.hasMore) break;
    if (page.nextPosition === null || page.nextPosition === afterPosition)
      throw new Error("thread_read pagination did not advance");
    afterPosition = page.nextPosition;
  } while (true);
  return pages;
}

// Usage: mcp-client.ts <endpoint> <session-json> <launch|observe> <output-json>
const [endpoint, sessionFile, action, outputFile] = process.argv.slice(2);
if (!endpoint || !sessionFile || !outputFile || !["launch", "observe"].includes(action))
  throw new Error("usage: mcp-client.ts <endpoint> <session-json> <launch|observe> <output-json>");
const credentials = JSON.parse(await readFile(sessionFile, "utf8"));
if (typeof credentials.token !== "string") throw new Error("no issued MCP token");
const client = new Client(endpoint, credentials.token);
const catalog = await client.catalog();
await writeFile(`${outputFile}.catalog.json`, JSON.stringify(catalog, null, 2), { mode: 0o600 });

if (action === "launch") {
  // No automatic retry: an SSH launch creates a new thread on every call.
  // A persistent attempt marker prevents an operator from rerunning blindly.
  const marker = await open(`${outputFile}.attempt`, "wx", 0o600);
  await marker.writeFile(new Date().toISOString());
  await marker.close();
  const args = {
    host: "juns-macbook-pro",
    cwd: "/Users/jun/tmp",
    workspace: { type: "cwd" },
    title: "GOAT wp5 MacBook 읽기 전용 프로브",
    runtimeMode: "approval-required",
    interactionMode: "default",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    message:
      "GOAT SSH 런타임 확인용 읽기 전용 프로브입니다. 파일 작성·수정·삭제, 설치, 서버 재시작, git 변경은 하지 마세요. hostname, whoami, pwd, sw_vers, date 명령만 실행하고 각 결과를 원문으로 보고하세요. 현재 대화의 goat_thread_configuration 도구도 읽기 호출해 provider/model/runtimeMode를 확인하고, 실제 사용 가능한 MCP 도구 이름과 namespace를 함께 보고하세요. 모델은 claude-opus-5-5여야 합니다. 명령 실행에 승인이 필요하면 우회하지 말고 승인 필요 상태를 알려 주세요.",
  };
  const launch = await client.call("goat_ssh_thread_launch", args);
  if (typeof launch.threadId !== "string" || launch.runtimeMode !== "approval-required")
    throw new Error("launch result missing remote thread id or wrong runtime mode");
  await writeFile(outputFile, JSON.stringify({ args, launch }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ args, launch }, null, 2));
} else {
  const { launch } = JSON.parse(await readFile("/tmp/goat-wp5/launch.json", "utf8"));
  const first = await client.call("goat_thread_read", { threadId: launch.threadId });
  const runId = first.thread.latestRunId;
  if (typeof runId !== "string") throw new Error("NEEDS_HUMAN: launch has no durable run yet");
  const waits = [];
  let completed = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await client.call("goat_thread_wait", {
      threadId: launch.threadId,
      runId,
      timeoutMs: 30_000,
    });
    waits.push(state);
    if (state.runId !== runId) throw new Error("wait selected another run");
    if (!state.timedOut) {
      completed = state.status === "completed";
      break;
    }
    if (state.status === "waiting") break;
  }
  const messages = await readAll(client, launch.threadId, "messages");
  const activity = await readAll(client, launch.threadId, "activity");
  const result = { launch, runId, waits, messages, activity };
  await writeFile(outputFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  const thread = messages[0].thread;
  if (
    thread.providerInstanceId !== "claudeAgent" ||
    thread.model !== "claude-opus-5-5" ||
    thread.runtimeMode !== "approval-required"
  )
    throw new Error("wrong remote thread configuration");
  if (!completed)
    throw new Error("NEEDS_HUMAN/BLOCKED: probe run has not completed; see waits/activity");
}
```

Protocol/session headers, initialize and notification follow `apps/server/src/mcp/AcpMcpStdioBridge.ts:92-147`; streaming JSON/SSE decoding follows `packages/shared/src/mcpResponsePayloads.ts:12-30,41-64`. Server name **GOAT**, `/mcp` path and protocol `2025-06-18` are implemented at `apps/server/src/mcp/McpHttpServer.ts:868-874`. Result extraction mirrors `apps/server/src/sshRemote/SshRemoteDispatch.ts:213-240`. Exact launch schema/result is `apps/server/src/mcp/toolkits/ssh/tools.ts:110-139`; launch's `threadId` is **remote**, and it does not return a bearer token, endpoint or run id (`SshRemoteDispatch.ts:568-599`). `goat_thread_list/read/wait` are registered at `apps/server/src/mcp/toolkits/orchestrator/tools.ts:179-245`, and `goat_thread_configuration` at `mcp/toolkits/thread/tools.ts:178`. Claude uses provider MCP key **`goat`** (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1022-1033`), with qualified identity `mcp__goat__goat_thread_configuration` in its read-only tool list (`ClaudeAdapterV2.ts:958-969`). Read/wait inputs, pagination and configuration fields are `packages/contracts/src/orchestratorMcp.ts:340-423,444-457`; wait pins the selected run (`mcp/OrchestratorMcpService.ts:2481-2500`). `idle` or a timeout is not completion. Observation uses the remote server, never the local server's `goat_thread_read`.

### Remote observer session and exact state ownership

`/tmp/goat-wp5/remote-session.ts`:

```ts
import { writeFile } from "node:fs/promises";
import {
  resolveSshTarget,
  remoteStateKey,
  runSshCommand,
} from "/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/command.ts";
import { Effect, NodeServices } from "./effect-runtime.ts";

const info = await Effect.runPromise(
  Effect.gen(function* () {
    // Same resolution/key used by SshEnvironmentManager.ensureEnvironment.
    const target = yield* resolveSshTarget("juns-macbook-pro");
    const key = yield* remoteStateKey(target);
    if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("invalid remote state key");
    const remote = (script: string) =>
      runSshCommand(target, {
        batchMode: "yes",
        interactiveAuth: false,
        remoteCommandArgs: ["sh", "-s"],
        stdin: script,
      });
    const metadata = yield* remote(`set -eu
STATE_DIR="$HOME/.goat/ssh-launch/${key}"
test -f "$STATE_DIR/run-t3.sh"
PID="$(cat "$STATE_DIR/pid")"
PORT="$(cat "$STATE_DIR/port")"
case "$PID:$PORT" in *[!0-9:]*|:*|*:) exit 1;; esac
kill -0 "$PID"
printf 'GOAT_WP5_META %s %s\\n' "$PID" "$PORT"
printf 'GOAT_WP5_HOME %s\\n' "$HOME/.goat"
ps -p "$PID" -o pid=,command=
shasum -a 256 "$STATE_DIR/run-t3.sh"
`);
    const match = /^GOAT_WP5_META (\d+) (\d+)$/m.exec(metadata.stdout);
    if (!match) throw new Error("no owned remote server metadata");
    // Do not issue through a stale runtime; retain evidence and return to wp4.
    if (
      !metadata.stdout.includes("/.goat/runtime/goat/versions/0.0.45/goat") ||
      !metadata.stdout.includes("serve") ||
      !(() => {
        const home = /^GOAT_WP5_HOME (.+)$/m.exec(metadata.stdout)?.[1];
        return home !== undefined && metadata.stdout.includes("--base-dir " + home);
      })()
    )
      throw new Error("remote process identity does not match integrated GOAT archive");
    const issued = yield* remote(`set -eu
STATE_DIR="$HOME/.goat/ssh-launch/${key}"
test -x "$STATE_DIR/run-t3.sh"
"$STATE_DIR/run-t3.sh" auth session issue --base-dir "$HOME/.goat" --subject mcp-client --scope orchestration:read --label goat-wp5-observer --ttl 1h --json
`);
    const credentials = JSON.parse(issued.stdout.trim());
    if (
      credentials.subject !== "mcp-client" ||
      typeof credentials.token !== "string" ||
      credentials.scopes.length !== 1 ||
      credentials.scopes[0] !== "orchestration:read"
    )
      throw new Error("remote observer is not read-only MCP client");
    // No token is printed or included in normal evidence.
    yield* Effect.promise(() =>
      writeFile("/tmp/goat-wp5/remote-session.json", JSON.stringify(credentials), { mode: 0o600 }),
    );
    yield* Effect.promise(() =>
      writeFile("/tmp/goat-wp5/remote-process.txt", metadata.stdout, { mode: 0o600 }),
    );
    return { target, stateKey: key, pid: Number(match[1]), port: Number(match[2]) };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
await writeFile("/tmp/goat-wp5/remote-info.json", JSON.stringify(info, null, 2), { mode: 0o600 });
console.log(JSON.stringify(info, null, 2));
```

Resolution and key are `packages/ssh/src/command.ts:44-83,333-358`; the manager resolves the target at `tunnel.ts:2085-2091` and launch/session operations derive the key at `tunnel.ts:1239,1360`. The remote session invocation uses the current runner/CLI approach at `tunnel.ts:839-858`, with the observer's narrower scope and implemented `~/.goat` root. It does not replace a runner, run a migration, or issue through the local source CLI against remote data. JSON token fields are `apps/server/src/cliAuthFormat.ts:118-131`. The caller's manager leaves the remote server running (`apps/server/src/sshRemote/SshRemoteDispatch.ts:622-634`). Its own local forward disappears when the isolated server stops; the observer creates a separately owned forward below.

### Isolated source server lifecycle and execution

`vp run dev` would use the worktree's `.t3`, and `--home-dir` can override it (`docs/operations/development.md:20-35`). For this API-only probe choose the direct source CLI. It runs the integrated source without a watch parent, Vite, a browser, or dependency installation, and its explicit scratch base is `/tmp/goat-wp5/server-home`. `serve` and its headless behavior are defined at `apps/server/src/cli/server.ts:60-69`; `--host`, `--port`, `--base-dir`, `--no-browser` are at `apps/server/src/cli/config.ts:33-55,218-236`. Explicit base state is `<base>/userdata` (`apps/server/src/config.ts:135-166`). `auth session issue` accepts `--base-dir`, repeated `--scope`, `--subject`, `--runtime-mode-ceiling`, `--label`, `--ttl`, `--json` (`apps/server/src/cli/auth.ts:55-90,172-208`, `cli/config.ts:204-213`). The SSH archive directory override is read by `apps/server/src/sshRemote/SshRemoteDispatch.ts:607-608`; archiveVersion is the server package's `0.0.45` (`apps/server/package.json:3`). The worktree `.t3/runtime/archives` is an explicit local build cache, distinct from the host's protected `~/.t3`; neither source CLI invocation may omit its scratch `--base-dir`.

`/tmp/goat-wp5/ready.ts`:

```ts
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
const [origin, pidFile, runtimeFile] = process.argv.slice(2);
if (!origin || !pidFile)
  throw new Error("usage: ready.ts <origin> <spawn-pid-file> [runtime-file]");
const pid = Number((await readFile(pidFile, "utf8")).trim());
if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid captured PID");
let ready = false;
for (let i = 0; i < 120; i++) {
  process.kill(pid, 0); // A dead child is failure, even if another service answers.
  try {
    if (runtimeFile) {
      const state = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (state.pid !== pid || state.origin !== origin)
        throw new Error("wrong source server owner");
    }
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* Startup/readiness retry; never a test synchronization mechanism. */
  }
  await pause(250);
}
if (!ready) throw new Error(`readiness failed for captured PID ${pid}`);
console.log(JSON.stringify({ ready, pid, origin }));
```

The `/` 2xx readiness criterion follows `packages/ssh/src/tunnel.ts`'s `REMOTE_WAIT_READY_SCRIPT` and `packages/shared/src/httpReadiness.ts:39-44,72`. Owner matching uses the source's persisted `pid`/`origin` (`apps/server/src/serverRuntimeState.ts:56-68`) at `userdata/server-runtime.json` (`apps/server/src/config.ts:166`); subsequent authenticated initialize confirms GOAT MCP identity. These startup retries are not backend behavior tests.

`/tmp/goat-wp5/run-probe.sh`:

```sh
#!/bin/sh
set -eu
umask 077
WP5_SOURCE=/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
WP5_SCRATCH=/tmp/goat-wp5
WP5_SERVER_PID=
WP5_FORWARD_PID=
cleanup() {
  # Only PIDs captured from this shell's child spawns; no discovery/pattern kills.
  for WP5_PID in "$WP5_FORWARD_PID" "$WP5_SERVER_PID"; do
    if [ -n "$WP5_PID" ]; then
      kill "$WP5_PID" 2>/dev/null || true
      wait "$WP5_PID" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$WP5_SOURCE"
test -d /Users/jun/tmp
test ! -e "$WP5_SCRATCH/launch.json.attempt"
# Refuse old scratch server state rather than silently restarting/reusing it.
test ! -e "$WP5_SCRATCH/server-home"
mkdir "$WP5_SCRATCH/server-home"
unset T3CODE_RELEASE_BASE_URL VITE_HTTP_URL VITE_WS_URL VITE_DEV_SERVER_URL
# Every T3CODE_* override (trace file, home, port, ...) could point back at
# ~/.t3; the isolated server relies on --base-dir alone.
for name in $(env | sed -n 's/^\(T3CODE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
# Fail on occupied fixed ports; do not stop their owners.
node --input-type=module <<'JS'
import { createServer } from 'node:net';
for (const port of [43872, 43873]) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
JS
T3CODE_SSH_RUNTIME_ARCHIVE_DIR="$WP5_SOURCE/.t3/runtime/archives" \
  node --experimental-strip-types apps/server/src/bin.ts serve \
  --base-dir "$WP5_SCRATCH/server-home" --host 127.0.0.1 --port 43872 --no-browser \
  > "$WP5_SCRATCH/source-server.log" 2>&1 &
WP5_SERVER_PID=$!
printf '%s\n' "$WP5_SERVER_PID" > "$WP5_SCRATCH/source-server.pid"
node --experimental-strip-types "$WP5_SCRATCH/ready.ts" http://127.0.0.1:43872 \
  "$WP5_SCRATCH/source-server.pid" "$WP5_SCRATCH/server-home/userdata/server-runtime.json"
node --experimental-strip-types apps/server/src/bin.ts auth session issue \
  --base-dir "$WP5_SCRATCH/server-home" --subject mcp-client \
  --scope orchestration:read --scope orchestration:operate --runtime-mode-ceiling full-access \
  --label goat-wp5-launch --ttl 1h --json > "$WP5_SCRATCH/local-session.json"
node --experimental-strip-types "$WP5_SCRATCH/mcp-client.ts" http://127.0.0.1:43872/mcp \
  "$WP5_SCRATCH/local-session.json" launch "$WP5_SCRATCH/launch.json" \
  > "$WP5_SCRATCH/launch.txt"
node --experimental-strip-types "$WP5_SCRATCH/remote-session.ts" > "$WP5_SCRATCH/remote-info.txt"
WP5_REMOTE_PORT=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync("/tmp/goat-wp5/remote-info.json", "utf8")).port)')
case "$WP5_REMOTE_PORT" in ''|*[!0-9]*) exit 1;; esac
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none \
  -L "127.0.0.1:43873:127.0.0.1:$WP5_REMOTE_PORT" juns-macbook-pro \
  > "$WP5_SCRATCH/observer-forward.log" 2>&1 &
WP5_FORWARD_PID=$!
printf '%s\n' "$WP5_FORWARD_PID" > "$WP5_SCRATCH/observer-forward.pid"
node --experimental-strip-types "$WP5_SCRATCH/ready.ts" http://127.0.0.1:43873 \
  "$WP5_SCRATCH/observer-forward.pid"
node --experimental-strip-types "$WP5_SCRATCH/mcp-client.ts" http://127.0.0.1:43873/mcp \
  "$WP5_SCRATCH/remote-session.json" observe "$WP5_SCRATCH/observation.json" \
  > "$WP5_SCRATCH/probe.txt"
# EXIT trap stops the source server and observer forward; remote server stays up.
```

Run after the runtime upload and binary-hash gate:

```sh
sh /tmp/goat-wp5/run-probe.sh > /tmp/goat-wp5/harness.txt 2>&1
printf 'exit=%s\n' "$?"
```

`-N/-L` forwarding and non-multiplexed SSH match `packages/ssh/src/tunnel.ts:1556-1578`; BatchMode/timeout args also come from `packages/ssh/src/command.ts:105-115`. The stop operation is the exact `kill "$WP5_SERVER_PID"; wait "$WP5_SERVER_PID"` / forward equivalent in the trap. Do not use a PID found by matching source paths. The runner intentionally refuses an existing attempt marker/home; resumption after an uncertain launch must inspect the remote project's threads using `goat_thread_list` with the returned project id, not issue another launch or delete the marker. If no launch result arrived, retrieve that project/thread from the remote client before resuming observation; report the ambiguity to the parent.

### Evidence disposition

Do not put `local-session.json`, `remote-session.json`, `server-home`, or the source server's pairing URL/log in public evidence. Retain scratch privately. Parent copies only these bounded outputs into this unit's existing `evidence/` after inspection:

- `prepare-missing.txt` / `gh-release.txt` → `wp5-gh-missing.txt`; `prepare-upload.txt` plus independent installed/built binary hashes → `wp5-remote-runtime.txt`.
- `launch.json`, `launch.json.catalog.json`, `remote-info.json`, `remote-process.txt`, `observation.json`, `observation.json.catalog.json`, `probe.txt` → `wp5-probe.txt` (or separate named attachments). Catalog JSON records **server name GOAT**, `goat_*` names and full input schemas, and contains no bearer token.
- Inspect the terminal **assistant** message and actual command outputs, not the input prompt echo. Its claimed model must agree with `thread.model`/`providerInstanceId`; actual qualified tool identity must appear in activity or provider trace as `mcp__goat__goat_thread_configuration`. A model's prose saying it has that namespace is not proof. If activity summarizes away the raw qualified id, record that subcriterion UNOBSERVED and obtain the scoped provider trace from the GOAT remote root; do not claim acceptance from the catalog alone.
- `completed` plus all five command outputs plus the model/namespace evidence is DONE. `waiting`, failed/interrupted/cancelled, missing credentials/model, stale remote process/binary or truncated timeline is not DONE; retain evidence and return NEEDS_HUMAN/BLOCKED or to the owning work-phase. No automatic retry of launch, privilege increase, remote restart or artifact cleanup is part of this harness.

## Acceptance

- No pingdotgg URL fetched or embedded in the GOAT runner on the host.
- GOAT runtime lives under `~/.goat/runtime/goat/versions` with the step-2e post-signing archived binary hash; `~/.t3` listings unchanged.
- Probe reply contains hostname, whoami, pwd, sw_vers, date and identifies claude-opus-5-5.
- Tool calls visible as `goat_*` and qualified `mcp__goat__goat_*` for Claude (wp6 is integrated at the stale-check HEAD).

## Risks / rollback

- Cleanup is ownership-bounded and needs explicit user approval: only paths this cycle created (recorded in step 0/4 evidence) and only after stopping the GOAT server it launched via `~/.goat/ssh-launch/<key>/pid`. Never delete pre-existing `~/.goat` state; never touch `~/.t3`.
- If the isolated dev server cannot reach Claude credentials, steps 0–4 stay as evidence and step 5 runs through the user's GOAT app after they restart it on this build (NEEDS_HUMAN handoff).
- Version-only readiness can reuse an earlier unpublished build; step 4's binary-hash comparison is the identity gate.

## Source delta for this cycle (user docs)

MODIFY docs/user/remote-access.md, section "Desktop-managed SSH": one short paragraph telling users that GOAT keeps its runtime, launch state and server data on the host under `~/.goat` (separate from any T3 Code install in `~/.t3`), and installs its runtime by uploading an archive from this computer: a cached archive in `<GOAT home>/runtime/archives`, otherwise one downloaded with the signed-in GitHub CLI (`gh auth status`) from the goat-si/goat release matching the app version. If neither is available, the connection fails naming the missing release asset. Any fix found by the e2e run is also part of this cycle's delta and goes through review.

## Audit fold (cycle 5)

1. The isolated server block unsets every inherited `T3CODE_*` variable (including `T3CODE_TRACE_FILE`, which config.ts honors independently of --base-dir) before both source CLI invocations.
2. The user-doc delta REPLACES the existing passage in docs/user/remote-access.md (Desktop-managed SSH, lines ~167-170) that says the remote downloads into `~/.t3/runtime`, instead of adding a contradictory paragraph, and states the matching goat-si/goat release must carry the platform archive and SHA256SUMS.

import type * as CodexReplay from "effect-codex-app-server/replay";
import * as Predicate from "effect/Predicate";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import packageJson from "../../../package.json" with { type: "json" };

export function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

export function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly sentPrompt?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "auto",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

export function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
    // Session credentials vary per thread; tests inspect them at the protocol boundary.
    metadata: {
      recorderThreadConfigKeys: [
        "shell_environment_policy.set.GOAT_ACP_MCP_ENDPOINT",
        "shell_environment_policy.set.GOAT_ACP_MCP_AUTHORIZATION",
        "shell_environment_policy.set.TMPDIR",
        "shell_environment_policy.set.TEMP",
        "shell_environment_policy.set.TMP",
        "shell_environment_policy.set.GOAT_SYSTEM_TMPDIR",
        "shell_environment_policy.set.T3CODE_SYSTEM_TMPDIR", // goat-rename: legacy
        "shell_environment_policy.set.T3_ACP_MCP_ENDPOINT",
        "shell_environment_policy.set.T3_ACP_MCP_AUTHORIZATION",
      ],
    },
  };
}

/** What Codex reports while a turn runs: its start, then the thread idle once the turn is over. */
export function codexTurnReportedIdle(
  threadId: string,
  turnId: string,
): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "emit_inbound",
      frame: {
        method: "turn/started",
        params: { threadId, turn: makeCodexReplayTurn({ id: turnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      frame: { method: "thread/status/changed", params: { threadId, status: { type: "idle" } } },
    },
  ];
}

const withRequestId = (
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry =>
  entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;

const outboundFrame = (entry: CodexReplay.CodexAppServerReplayEntry | undefined) =>
  entry?.type === "expect_outbound" && Predicate.isObject(entry.frame) ? entry.frame : undefined;

export function withThreadNames(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  titles: readonly string[],
): CodexReplay.CodexAppServerReplayTranscript {
  const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let ids = new Map<number, number>();
  let named = new Set<unknown>();
  let titleIndex = 0;
  // Only root threads GOAT starts turns on get a name; Codex starts subagent turns itself.
  const rootThreads = new Set(
    transcript.entries.flatMap((entry) => {
      const frame = outboundFrame(entry);
      return frame?.method === "turn/start" && Predicate.isObject(frame.params)
        ? [frame.params.threadId]
        : [];
    }),
  );
  for (const [index, entry] of transcript.entries.entries()) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      entries.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      if (frame.method === "initialize") {
        offset = 0;
        ids = new Map();
        named = new Set();
        titleIndex = 0;
      }
      const params = Predicate.isObject(frame.params) ? frame.params : {};
      if (frame.method === "thread/name/set") named.add(params.threadId);
      const nextFrame =
        frame.method === "config/read" || frame.method === "thread/goal/get"
          ? outboundFrame(
              transcript.entries
                .slice(index + 1)
                .find((candidate) => candidate.type === "expect_outbound"),
            )
          : undefined;
      // A turn's quiet check reads goals after the name; a /goal command reads before naming.
      const quietCheckRead =
        frame.method === "thread/goal/get" &&
        rootThreads.has(params.threadId) &&
        nextFrame?.method !== "thread/goal/set" &&
        nextFrame?.method !== "thread/goal/clear";
      const turnParams =
        frame.method === "turn/start" || quietCheckRead
          ? params
          : frame.method === "config/read" &&
              nextFrame?.method === "turn/start" &&
              Predicate.isObject(nextFrame.params)
            ? nextFrame.params
            : undefined;
      if (turnParams !== undefined && !named.has(turnParams.threadId)) {
        named.add(turnParams.threadId);
        const name = titles[titleIndex++] ?? titles.at(-1) ?? "Codex continuation test";
        const id = frame.id + offset;
        entries.push(
          {
            type: "expect_outbound",
            label: "thread/name/set",
            frame: {
              id,
              method: "thread/name/set",
              params: { threadId: turnParams.threadId, name },
            },
          },
          { type: "emit_inbound", label: "thread/name/set", frame: { id, result: {} } },
        );
        offset++;
      }
      ids.set(frame.id, frame.id + offset);
      entries.push(withRequestId(entry, frame.id + offset));
      continue;
    }
    const mapped = ids.get(frame.id);
    entries.push(
      entry.type === "emit_inbound" && frame.method === undefined && mapped !== undefined
        ? withRequestId(entry, mapped)
        : entry,
    );
  }
  return { ...transcript, entries };
}

export function withThreadSetupReads(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
): CodexReplay.CodexAppServerReplayTranscript {
  const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let ids = new Map<number, number>();
  let pendingRead = false;
  let previousMethod = "";
  let previousId = -1;
  let failed = "";
  for (const [index, entry] of transcript.entries.entries()) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      entries.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      if (frame.method === "initialize") {
        offset = 0;
        ids = new Map();
        pendingRead = false;
      }
      const params = Predicate.isObject(frame.params) ? frame.params : {};
      const next = transcript.entries
        .slice(index + 1)
        .find((candidate) => candidate.type === "expect_outbound");
      const nextFrame =
        next?.type === "expect_outbound" && Predicate.isObject(next.frame) ? next.frame : undefined;
      const reload = frame.method === "thread/unsubscribe" && nextFrame?.method === "thread/resume";
      const setup = ["thread/start", "thread/resume", "thread/fork"].includes(frame.method);
      if (frame.method === "config/read") pendingRead = previousMethod !== "thread/start";
      else if (setup && pendingRead) pendingRead = false;
      else if (
        (reload || setup) &&
        failed !== frame.method &&
        previousMethod !== "thread/unarchive"
      ) {
        const id = frame.id + offset;
        entries.push(
          {
            type: "expect_outbound",
            label: "config/read",
            frame: {
              id,
              method: "config/read",
              params: { cwd: params.cwd ?? null, includeLayers: false },
            },
          },
          {
            type: "emit_inbound",
            label: "config/read",
            frame: { id, result: { config: {}, origins: {} } },
          },
        );
        offset++;
        if (reload) pendingRead = true;
      } else if (!reload && !setup) pendingRead = false;
      previousMethod = frame.method;
      previousId = frame.id;
      failed = "";
      ids.set(frame.id, frame.id + offset);
      entries.push(withRequestId(entry, frame.id + offset));
      continue;
    }
    if (entry.type === "emit_inbound" && frame.id === previousId && "error" in frame)
      failed = previousMethod;
    const mapped = ids.get(frame.id);
    entries.push(
      entry.type === "emit_inbound" && frame.method === undefined && mapped !== undefined
        ? withRequestId(entry, mapped)
        : entry,
    );
  }
  return { ...transcript, entries };
}

/** Every turn/start follows a config/read; inserts that exchange and shifts later client ids. */
function withConfigReadBeforeTurnStart(
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
): Array<CodexReplay.CodexAppServerReplayEntry> {
  const result: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let clientIds = new Map<number, number>();
  for (const entry of entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      result.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      if (frame.method === "initialize") {
        offset = 0;
        clientIds = new Map();
      }
      if (frame.method === "turn/start") {
        const id = frame.id + offset;
        const params = Predicate.isObject(frame.params) ? frame.params : {};
        result.push(
          {
            type: "expect_outbound",
            label: "config/read",
            frame: { id, method: "config/read", params: { cwd: params.cwd, includeLayers: false } },
          },
          {
            type: "emit_inbound",
            label: "config/read",
            frame: { id, result: { config: {}, origins: {} } },
          },
        );
        offset += 1;
      }
      clientIds.set(frame.id, frame.id + offset);
      result.push(withRequestId(entry, frame.id + offset));
      continue;
    }
    const mapped = clientIds.get(frame.id);
    result.push(
      entry.type === "emit_inbound" && frame.method === undefined && mapped !== undefined
        ? withRequestId(entry, mapped)
        : entry,
    );
  }
  return result;
}

export function withConfigReads(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  includeSetup = true,
  title = "Codex continuation test",
): CodexReplay.CodexAppServerReplayTranscript {
  const named = withThreadNames(transcript, [title]);
  const setup = includeSetup ? withThreadSetupReads(named) : named;
  return { ...setup, entries: withConfigReadBeforeTurnStart(setup.entries) };
}

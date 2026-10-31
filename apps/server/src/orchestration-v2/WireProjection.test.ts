import { redactComputerUseTypedOutput } from "@goat/shared/toolActivity";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { coalesceLiveUpdatedEvents } from "./ThreadLiveEventCoalescer.ts";
import {
  boundFileChangeForStorage,
  makeLiveBodyDeduper,
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
  projectTranscriptRowForClient,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import {
  htmlRenderFromToolItem,
  MAX_TOOL_OUTPUT_IMAGES,
  toolOutputImages,
} from "@goat/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("never sends a client typed computer-use text, including an ACP child's call envelope", () => {
    const typed = {
      ...base,
      toolName: "cua-driver.type_text",
      input: { pid: 1, text: "hunter2" },
    } as OrchestrationV2TurnItem;
    const child = {
      ...typed,
      input: { server: "cua-driver", tool: "type_text", arguments: { pid: 1, text: "hunter2" } },
    } as OrchestrationV2TurnItem;
    for (const item of [typed, child]) {
      const event = projectDomainEventForWire({
        id: EventId.make("typed"),
        type: "turn-item.updated",
        threadId: item.threadId,
        occurredAt: item.updatedAt,
        payload: item,
      } as OrchestrationV2DomainEvent);
      const row = projectTranscriptRowForClient({ position: 0, item });
      for (const sent of [projectTurnItemForWire(item), projectTurnItemForDetail(item), event, row])
        expect(JSON.stringify(sent)).not.toContain("hunter2");
      expect(JSON.stringify(row)).toContain('"text":{"redactedCharacters":7}');
    }
    // Raw text that reads like a redaction is still the agent's text.
    const lookalike = {
      ...typed,
      input: { pid: 1, text: "123 characters" },
    } as OrchestrationV2TurnItem;
    const sent = projectTurnItemForWire(lookalike);
    expect(sent.type === "dynamic_tool" ? sent.input : undefined).toEqual({
      pid: 1,
      text: { redactedCharacters: 14 },
    });
  });

  it("never sends a client text typed inside a run_steps batch or a run_script source", () => {
    const steps = [
      { tool: "type_text", args: { pid: 1, text: "hunter2" } },
      { set: { role: "textfield", name: "Password", value: "hunter2" } },
      { click: { role: "button", name: "Sign in" }, expect: [{ value: "hunter2" }] },
      { type: { text: "hunter2" }, wait_for: { value_contains: "hunter2", name: "Password" } },
    ];
    const batch = {
      ...base,
      toolName: "cua-driver.run_steps",
      input: { pid: 1, steps },
    } as OrchestrationV2TurnItem;
    const script = {
      ...base,
      toolName: "mcp__cua-driver__run_script",
      input: { script: 'await type_text({ text: "hunter2" }); return "done";', timeout_ms: 500 },
    } as OrchestrationV2TurnItem;
    const child = {
      ...batch,
      toolName: "cua-driver.run_steps",
      input: { server: "cua-driver", tool: "run_steps", arguments: { steps } },
    } as OrchestrationV2TurnItem;
    for (const item of [batch, script, child]) {
      const event = projectDomainEventForWire({
        id: EventId.make("typed"),
        type: "turn-item.updated",
        threadId: item.threadId,
        occurredAt: item.updatedAt,
        payload: item,
      } as OrchestrationV2DomainEvent);
      const row = projectTranscriptRowForClient({ position: 0, item });
      for (const sent of [projectTurnItemForWire(item), projectTurnItemForDetail(item), event, row])
        expect(JSON.stringify(sent)).not.toContain("hunter2");
    }
    // What the steps do stays readable: only the typed values become their lengths.
    const sent = projectTurnItemForWire(batch);
    expect(sent.type === "dynamic_tool" ? sent.input : undefined).toEqual({
      pid: 1,
      steps: [
        { tool: "type_text", args: { pid: 1, text: { redactedCharacters: 7 } } },
        { set: { role: "textfield", name: "Password", value: { redactedCharacters: 7 } } },
        {
          click: { role: "button", name: "Sign in" },
          expect: [{ value: { redactedCharacters: 7 } }],
        },
        {
          type: { text: { redactedCharacters: 7 } },
          wait_for: { value_contains: { redactedCharacters: 7 }, name: "Password" },
        },
      ],
    });
  });

  it("keeps a batch's typed values out of its result, and catches every step form the driver runs", () => {
    const item = {
      ...base,
      toolName: "cua-driver.run_steps",
      input: {
        steps: [
          { noop: null, type: { text: "hunter2" } },
          { click: { name: "Sign in" }, expect: { name: "Password", value: "hunter2" } },
          { press_key: { key: "a" } },
        ],
      },
      output: {
        structuredContent: {
          steps: [{ index: 1, tool: "click", message: 'expected value "hunter2" but saw ""' }],
        },
      },
    } as OrchestrationV2TurnItem;
    const row = projectTranscriptRowForClient({ position: 0, item });
    for (const sent of [projectTurnItemForWire(item), projectTurnItemForDetail(item), row])
      expect(JSON.stringify(sent)).not.toContain("hunter2");
    const detail = projectTurnItemForDetail(item);
    expect(JSON.stringify(detail.type === "dynamic_tool" ? detail.output : null)).toContain(
      'expected value \\"[typed text]\\" but saw',
    );
  });

  it("masks short and JSON-escaped typed values in a batch's result, and keeps its image blocks intact", () => {
    const item = {
      ...base,
      toolName: "cua-driver.run_steps",
      input: {
        steps: [
          { set_value: { name: "PIN", value: "123" }, expect: [{ value: "123" }] },
          { type_text: { text: 'a"b\\c\nd' } },
          { type_text: { text: "image" } },
        ],
      },
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message: 'value "123" expected', typed: 'a"b\\c\nd' }),
          },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
      },
    } as OrchestrationV2TurnItem;
    const row = projectTranscriptRowForClient({ position: 0, item });
    const output =
      row.item.type === "dynamic_tool"
        ? (row.item.output as { content: Array<Record<string, string>> })
        : undefined;
    const text = JSON.parse(output!.content[0]!.text!) as Record<string, string>;
    expect(text).toEqual({ message: 'value "[typed text]" expected', typed: "[typed text]" });
    expect(output!.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    // A short value is masked as a whole token, never inside a longer one.
    expect(
      redactComputerUseTypedOutput(
        "cua-driver.run_steps",
        { steps: [{ set_value: { value: "123" } }] },
        "code 1234 and 123",
      ),
    ).toBe("code 1234 and [typed text]");
  });

  it("masks typed values through nested JSON text without breaking its structure, and survives huge values", () => {
    const secret = 'a"b\\c';
    const input = {
      steps: [
        { type_text: { text: secret } },
        { type_text: { text: "image" } },
        { type_text: { text: "error" } },
        { type_text: { text: '"' } },
      ],
    };
    const inner = JSON.stringify({
      typed: secret,
      type: "image",
      mimeType: "image/png",
      error: "image failed",
    });
    const output = {
      content: [
        { type: "text", text: JSON.stringify({ result: inner }) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      ],
    };
    const masked = redactComputerUseTypedOutput(
      "cua-driver.run_steps",
      input,
      output,
    ) as typeof output;
    const outer = JSON.parse(String(masked.content[0]!.text)) as { result: string };
    expect(JSON.parse(outer.result)).toEqual({
      typed: "[typed text]",
      type: "image",
      mimeType: "image/png",
      error: "[typed text] failed",
    });
    expect(masked.content[1]).toEqual(output.content[1]);
    // A value far past any pattern size is still masked, and a short ok stays.
    const huge = "x".repeat(100_000);
    expect(
      redactComputerUseTypedOutput("cua-driver.run_script", { script: huge }, [
        "ok",
        `echo ${huge}`,
      ]),
    ).toEqual(["ok", "echo [typed text]"]);
  });

  it("masks short values in any script or punctuation as whole tokens in a batch's result", () => {
    const input = {
      steps: [
        { set_value: { value: "秘密" }, expect: { value: "秘密" } },
        { type_text: { text: "!!" } },
        { type_text: { text: "?" } },
      ],
    };
    expect(
      redactComputerUseTypedOutput("cua-driver.run_steps", input, [
        'expected value "秘密" but saw ""',
        "typed !! then Hello!!",
        "?",
        "Is it done?",
      ]),
    ).toEqual([
      'expected value "[typed text]" but saw ""',
      "typed [typed text] then Hello!!",
      "[typed text]",
      "Is it done?",
    ]);
  });

  it("masks a typed value that is itself JSON, alone or inside a JSON result", () => {
    const value = '{"token":"hunter2"}';
    const input = { steps: [{ set_value: { value } }] };
    const masked = redactComputerUseTypedOutput("cua-driver.run_steps", input, {
      expected: value,
      text: JSON.stringify({ expected: value }),
    }) as { expected: string; text: string };
    expect(masked.expected).toBe("[typed text]");
    expect(JSON.parse(masked.text)).toEqual({ expected: "[typed text]" });
  });

  it("masks a text check that repeats what the batch typed, and leaves other text checks readable", () => {
    const item = {
      ...base,
      toolName: "cua-driver.run_steps",
      input: {
        steps: [
          { type_text: { text: "hunter2" }, expect: { text: "hunter2" } },
          { click: { name: "Sign in" }, wait_for: { text: "Welcome hunter2" } },
          { click: { name: "OK" }, expect: [{ text: "Thanks" }] },
        ],
      },
    } as OrchestrationV2TurnItem;
    const sent = projectTurnItemForWire(item);
    const input = JSON.stringify(sent.type === "dynamic_tool" ? sent.input : null);
    expect(input).not.toContain("hunter2");
    expect(input).toContain('"text":"Thanks"');
  });

  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps a settle wait's outcome on the wire, so a row that never fetches detail shows it", () => {
    const settle = { outcome: "pending", reason: "deadline" };
    const item = {
      ...base,
      toolName: "mcp__cua-driver__wait_for_window_settle",
      output: {
        content: [{ type: "text", text: "Notification settle: pending (deadline)." }],
        structuredContent: { settle },
      },
    } satisfies OrchestrationV2TurnItem;
    const sent = decodeTurnItemJson(encodeTurnItemJson(projectTurnItemForWire(item)));
    expect(sent.type === "dynamic_tool" ? sent.output : undefined).toEqual({ settle });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("keeps a page rendered through goat_call when its input is too large to send", () => {
    const htmlRender = { attachmentId: "thread-1-page", title: "Chart", height: 300 };
    const page = (toolName: string, input: unknown) =>
      projectTurnItemForWire({
        ...base,
        toolName,
        input,
        output: { status: "ok", value: { htmlRender } },
      });
    const html = "<p>" + "x".repeat(17_000) + "</p>";
    // MCP's own {name, arguments} spelling, which goat_call also takes, keeps the page too.
    for (const input of [
      { path: "html.render", args: { html } },
      { name: "html.render", arguments: { html } },
    ]) {
      const wrapped = page("mcp__goat__goat_call", input);
      expect(
        htmlRenderFromToolItem(wrapped as Parameters<typeof htmlRenderFromToolItem>[0]),
        Object.keys(input).join(","),
      ).toEqual(htmlRender);
    }
    // Another tool's path-shaped argument stays inside the summary.
    const other = page("mcp__github__fetch_pr", { path: "html.render", body: html });
    expect(other.type === "dynamic_tool" ? other.input : null).not.toHaveProperty("path");
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const progress = "a".repeat(32_767) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect code",
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(32_767) + "\n… output truncated for transport",
    );
    expect(item.progress).toBe(progress);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3-code__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output: %s", (output) => {
    const projected = projectTurnItemForWire({
      ...base,
      type: "command_execution" as const,
      input: "rg -n error logs fixtures",
      output,
      exitCode: 0,
    });
    expect(projected).not.toHaveProperty("outputIndicatesFailure");
    expect(projected).toMatchObject({ exitCode: 0, outputOmitted: true });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("sends an edit's own patch only on demand", () => {
    const patch = "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n";
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      diffStr: "@@ -1 +1 @@",
      patch,
    };
    const wire = projectTurnItemForWire(item);
    expect(wire).not.toHaveProperty("patch");
    expect(wire).toMatchObject({ patchOmitted: true });
    expect(projectTurnItemForWire(wire)).toEqual(wire);
    const detail = projectTurnItemForDetail(item);
    expect(detail).toMatchObject({ patch });
    expect(detail).not.toHaveProperty("patchOmitted");
    expect(detail).not.toHaveProperty("diffStr");
    expect(projectTurnItemForWire({ ...item, status: "failed" })).not.toHaveProperty(
      "patchOmitted",
    );
    expect(projectTurnItemForDetail({ ...item, status: "failed" })).not.toHaveProperty("patch");
  });

  it("stores no patch too large to send whole", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      patch: `diff --git a/a b/a\n${"+x\n".repeat(200_000)}`,
    };
    expect(boundFileChangeForStorage(item)).not.toHaveProperty("patch");
    const small = { ...item, patch: "diff --git a/a b/a\n" };
    expect(boundFileChangeForStorage(small)).toBe(small);
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });
});

describe("live body deduper", () => {
  const at = base.updatedAt;
  const messageId = MessageId.make("message-live");
  const event = (
    sequence: number,
    rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
  ): Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> => ({
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      threadId: base.threadId,
      occurredAt: at,
      ...rest,
    } as OrchestrationV2DomainEvent,
  });
  const message = (sequence: number, text: string) =>
    event(sequence, {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId: base.threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
  const reply = (sequence: number, text: string) =>
    event(sequence, {
      type: "turn-item.updated",
      payload: {
        ...base,
        status: "running",
        type: "assistant_message",
        messageId,
        text,
        streaming: true,
      },
    });
  const payloadOf = (item: OrchestrationV2ThreadStreamItem) =>
    item.kind === "event" ? item.event.payload : undefined;

  it("blanks a reply that repeats the message delivered before it, after coalescing", () => {
    const delivered = coalesceLiveUpdatedEvents([
      message(1, "a"),
      reply(2, "a"),
      message(3, "ab"),
      reply(4, "ab"),
    ]).map(makeLiveBodyDeduper());

    expect(
      delivered.map((item) => [item.kind === "event" && item.sequence, payloadOf(item)]),
    ).toEqual([
      [3, message(3, "ab").event.payload],
      [4, { ...reply(4, "ab").event.payload, text: "", textOmitted: true }],
    ]);
  });

  it("caps a large checkpoint's files for the wire and still dedupes its item", () => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `vendor/file-${index}.ts`,
      kind: "modified",
      additions: 2,
      deletions: 1,
    }));
    const checkpointId = CheckpointId.make("checkpoint-large");
    const scopeId = CheckpointScopeId.make("scope-large");
    const captured = event(1, {
      type: "checkpoint.captured",
      payload: {
        id: checkpointId,
        threadId: base.threadId,
        scopeId,
        runId: null,
        nodeId: NodeId.make("node-large"),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: null,
        ref: CheckpointRef.make("refs/t3/checkpoints/large"),
        status: "ready",
        files,
        capturedAt: at,
      },
    });
    const item = event(2, {
      type: "turn-item.updated",
      payload: { ...base, type: "checkpoint", checkpointId, scopeId, files },
    });
    const dedupe = makeLiveBodyDeduper();
    const [record, card] = [captured, item].map((streamed) =>
      dedupe({ ...streamed, event: projectDomainEventForWire(streamed.event) }),
    );

    const filesTotal = { count: 250, additions: 500, deletions: 250 };
    expect(payloadOf(record!)).toMatchObject({ files: files.slice(0, 200), filesTotal });
    expect(payloadOf(card!)).toMatchObject({ files: [], filesOmitted: true, filesTotal });
  });

  it("ships a reply whole when its message arrives after it", () => {
    const first = reply(1, "a");
    expect([first, message(2, "a")].map(makeLiveBodyDeduper())[0]).toBe(first);
  });
});

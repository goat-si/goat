import { describe, expect, it } from "@effect/vitest";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Option from "effect/Option";

import { makeCli } from "../binCli.ts";
import {
  agentSurfaceInvocation,
  type CallFailure,
  exitCodeOf,
  failureResult,
  type InputReader,
  OPERATOR_VERBS,
  toolResultEnvelope,
} from "./agentSurfaceCommand.ts";

const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
const files: Record<string, string> = { "note.md": "from a file" };
const input: InputReader = {
  stdin: () => '{"threadId":"from-stdin"}',
  file: (path) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
};
const invoke = (...argv: ReadonlyArray<string>) => agentSurfaceInvocation(argv, input);

const error = (fields: Partial<Extract<AgentSurfaceResult, { status: "error" }>["error"]>) =>
  ({
    status: "error",
    error: { code: "internal", reason: "x", message: "x", retryable: false, ...fields },
  }) as AgentSurfaceResult;

describe("exit codes", () => {
  it("map every envelope outcome to the documented code", () => {
    const cases: ReadonlyArray<readonly [AgentSurfaceResult, number]> = [
      [{ status: "ok", value: null }, 0],
      [error({ code: "not_found" }), 1],
      [error({ code: "unavailable", retryable: true }), 4],
      [error({ code: "unknown_outcome" }), 5],
      [
        {
          status: "needs_human",
          handoff: {
            handoffId: "h",
            kind: "approval",
            title: "Approve",
            state: "pending",
            expiresAt: null,
            targetPath: "thread.send",
          },
        },
        3,
      ],
    ];
    for (const [result, code] of cases)
      expect(exitCodeOf(result), JSON.stringify(result)).toBe(code);
  });

  it("call a lost answer to a write an unknown outcome, and retry only what proves nothing ran", () => {
    const at = (failure: Omit<CallFailure, "message">, effect: "read" | "write" = "write") =>
      exitCodeOf(failureResult({ ...failure, message: "m" }, effect));
    // Before goat_call was sent nothing can have run.
    expect(at({ phase: "connect", kind: "transport" })).toBe(4);
    expect(at({ phase: "connect", kind: "http", status: 503 })).toBe(4);
    expect(at({ phase: "connect", kind: "http", status: 400 })).toBe(1);
    expect(at({ phase: "connect", kind: "protocol" })).toBe(1);
    // A refused credential is final wherever it comes, and never falls back.
    expect(at({ phase: "connect", kind: "http", status: 401 })).toBe(1);
    expect(at({ phase: "dispatch", kind: "http", status: 403 })).toBe(1);
    // The server refuses malformed requests before any tool runs.
    expect(at({ phase: "dispatch", kind: "rpc", rpcCode: -32602 })).toBe(1);
    // After dispatch, a write may have run.
    for (const kind of ["transport", "protocol"] as const)
      expect(at({ phase: "dispatch", kind })).toBe(5);
    expect(at({ phase: "dispatch", kind: "http", status: 500 })).toBe(5);
    expect(at({ phase: "dispatch", kind: "rpc", rpcCode: -32603 })).toBe(5);
    expect(at({ phase: "dispatch", kind: "transport" }, "read")).toBe(4);
  });

  it("treat an error result without an envelope as /mcp refusing the credential", () => {
    const refused = toolResultEnvelope({
      isError: true,
      content: [{ type: "text", text: "This MCP credential has expired." }],
    });
    expect(Option.map(refused, exitCodeOf)).toEqual(Option.some(1));
    expect(refused).toMatchObject(
      Option.some({ error: { code: "unauthenticated", reason: "credential_refused" } }),
    );
    const envelope = { status: "ok", value: { threadId: "t" } };
    expect(toolResultEnvelope({ structuredContent: envelope })).toEqual(Option.some(envelope));
    expect(toolResultEnvelope({ content: [] })).toEqual(Option.none());
  });
});

describe("arguments", () => {
  it("follow gh's -f and -F rules over a JSON base", () => {
    expect(
      invoke(
        "call",
        "thread.read",
        '{"threadId":"base","limit":1}',
        "-f",
        "limit=3",
        "-F",
        "count=3",
        "-F",
        "flag=true",
        "-F",
        "none=null",
        "-F",
        "big=12345678901234567890",
        "-F",
        "body=@note.md",
        "--raw-field=word=true",
      ),
    ).toMatchObject({
      kind: "call",
      path: "thread.read",
      args: {
        threadId: "base",
        limit: "3",
        count: 3,
        flag: true,
        none: null,
        big: "12345678901234567890",
        body: "from a file",
        word: "true",
      },
    });
    expect(invoke("call", "thread.read", "-")).toMatchObject({ args: { threadId: "from-stdin" } });
    expect(invoke("call", "thread.read", "-F", "body=@-")).toMatchObject({
      args: { body: '{"threadId":"from-stdin"}' },
    });
  });

  it("turn the reserved flags into the call's own arguments", () => {
    expect(
      invoke("thread", "read", "--host", "box", "--request-id", "r-1", "--json"),
    ).toMatchObject({
      kind: "call",
      path: "thread.read",
      json: true,
      args: { host: "box", clientRequestId: "r-1" },
    });
    const dryRun = entries.find((entry) => entry.dryRun === "supported");
    if (dryRun !== undefined)
      expect(invoke("call", dryRun.path, "--dry-run")).toMatchObject({ args: { dryRun: true } });
  });

  it("are usage errors when malformed or not accepted by the path", () => {
    const local = entries.find((entry) => !entry.hostRoutable && entry.resource !== "surface")!;
    const noDryRun = entries.find((entry) => entry.dryRun === "unsupported")!;
    for (const argv of [
      ["call"],
      ["call", "thread.read", "[1]"],
      ["call", "thread.read", "{"],
      ["call", "thread.read", "-f", "novalue"],
      ["call", "thread.read", "-f"],
      ["call", "thread.read", "-F", "body=@missing.md"],
      ["call", "thread.read", "--force"],
      ["call", "thread.read", "{}", "extra"],
      ["call", local.path, "--host", "box"],
      ["call", noDryRun.path, "--dry-run"],
      ["describe", "--host", "box"],
      ["preview", "teleport"],
      ["preview", "--bogus"],
    ])
      expect(invoke(...argv), argv.join(" ")).toMatchObject({ kind: "usage" });
  });
});

describe("routing", () => {
  it("leaves operator commands to the operator CLI and generates the rest", () => {
    expect(invoke("serve")).toBeUndefined();
    expect(invoke("thread", "send", "t", "hi")).toBeUndefined();
    expect(invoke("thread", "--help")).toBeUndefined();
    expect(invoke("thread", "teleport")).toBeUndefined();
    expect(invoke("thread", "wait", "-f", "threadId=t")).toMatchObject({
      kind: "call",
      path: "thread.wait",
      effect: agentSurfaceRegistry["thread.wait"].effect,
    });
    expect(invoke("pending-request", "respond", "--help")).toMatchObject({ kind: "help" });
    expect(invoke("preview")).toMatchObject({ kind: "help" });
    expect(invoke("preview", "-h")).toMatchObject({ kind: "help" });
    expect(invoke("describe", "thread", "--query", "send message")).toMatchObject({
      kind: "call",
      path: "surface.describe",
      args: { path: "thread", query: "send message" },
      format: "describe",
    });
    // An agent's terminal fallback always gets the envelope.
    expect(invoke("acp-mcp-call", "task_status", "{}")).toMatchObject({
      kind: "call",
      path: "task_status",
      json: true,
    });
    expect(invoke("call", "goat_some_future_tool")).toMatchObject({ effect: "destructive" });
  });

  it("keeps OPERATOR_VERBS equal to the operator commands that share a registry resource", () => {
    const resources = new Set(entries.map((entry) => entry.resource.replaceAll("_", "-")));
    const shared = makeCli()
      .subcommands.flatMap((group) => group.commands)
      .filter((command) => resources.has(command.name))
      .map((command) => [
        command.name.replaceAll("-", "_"),
        command.subcommands.flatMap((group) => group.commands.map((sub) => sub.name)).toSorted(),
      ]);
    expect(Object.fromEntries(shared)).toEqual(
      Object.fromEntries(
        Object.entries(OPERATOR_VERBS).map(([name, verbs]) => [name, verbs.toSorted()]),
      ),
    );
  });
});

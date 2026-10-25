import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
// oxlint-disable-next-line goat/no-global-process-runtime -- The production Swift session requires macOS AppKit to link.
const platform = process.platform;
const source = NodeURL.fileURLToPath(new URL("../native/computer-use-helper/", import.meta.url));

// quarantine: #1506 Native session contracts require a macOS Swift toolchain; no AX/GUI is invoked.
describe.skipIf(platform !== "darwin")("injected production MCP window-settle session", () => {
  let directory;
  let executable;
  beforeAll(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-settle-session-"));
    executable = NodePath.join(directory, "session-fixture");
    await execFile("xcrun", [
      "swiftc",
      "-warnings-as-errors",
      "-whole-module-optimization",
      "-o",
      executable,
      ...[
        "McpFraming.swift",
        "McpJsonSyntax.swift",
        "McpObject.swift",
        "McpWire.swift",
        "NativeManifest.swift",
        "WindowSettle.swift",
        "McpNativeToolContract.swift",
        "McpNativeSession.swift",
        "fixtures/McpNativeFixture.swift",
      ].map((name) => NodePath.join(source, name)),
    ]);
  });
  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  const run = async (name) => {
    const { stdout, stderr } = await execFile(executable, [name]);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ ok: true, case: name });
    return result;
  };

  it.each([
    [
      "fresh",
      "starts the final sample after quiet and preserves driver tokens, images and invalidations",
    ],
    [
      "dirty-final",
      "requires new quiet and a new read when notifications arrive during the final sample",
    ],
    [
      "deadline",
      "reports unavailable at startup or outstanding-read deadline and never reuses a stale baseline",
    ],
    [
      "deadline-recovery",
      "privately drains expired reads before allowing metadata and forced full same-target recovery",
    ],
    [
      "cancel-recovery",
      "privately drains cancelled reads before allowing metadata and forced full same-target recovery",
    ],
    ["cancellation", "cancellation prevents later reads and drops already queued native results"],
    [
      "busy",
      "refuses all tools during observer startup or sampling while servicing discovery and control",
    ],
    [
      "observer-checks",
      "rechecks private coverage before each read and fences deferred checks after cancellation or deadline",
    ],
    [
      "delayed-check",
      "reports the actual final read start and remaining budget after a deferred observer check",
    ],
    [
      "interrupts",
      "ignores capture hides but immediately fences private, ended and human interruption output",
    ],
    [
      "sample-errors",
      "distinguishes missing windows from generic failures and preserves actual typed driver error codes",
    ],
    [
      "unsupported",
      "refuses incomplete observer coverage before baseline and rejects degraded final samples",
    ],
    [
      "admission",
      "denies unknown manifest, tool ceiling and exact-bundle mismatches before observation",
    ],
    ["arguments", "enforces native argument bounds, rejects booleans and uses public defaults"],
    [
      "collisions",
      "remaps internal-prefix provider IDs and cancellation while ignoring forged private cancellations",
    ],
    [
      "opaque",
      "preserves opaque surrogate and overflow fields on ordinary traffic and numeric cancellation identity",
    ],
  ])("%s: %s", async (name) => {
    await run(name);
  });

  it("tools/list retains original tools and advertises the native tool's exact input and availability schema", async () => {
    const { result } = await run("discovery");
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "original_tool",
      "wait_for_window_settle",
    ]);
    const tool = result.tools[1];
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["pid", "window_id"],
      properties: {
        pid: { type: "integer", minimum: 1, maximum: 2147483647 },
        window_id: { type: "integer", minimum: 1, maximum: 4294967295 },
        session: { type: "string", minLength: 1, maxLength: 128 },
        quiet_ms: { type: "integer", minimum: 50, maximum: 2000, default: 200 },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
      },
    });
    expect(tool.outputSchema.required).toEqual(["pid", "window_id", "settle", "sample"]);
    expect(tool.outputSchema.properties.sample).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["unavailable"],
      properties: {
        unavailable: { type: "boolean" },
        reason: { type: "string" },
        started_after_ms: { type: "integer", minimum: 0 },
        completed_after_ms: { type: "integer", minimum: 0 },
      },
    });
    expect(tool.outputSchema.properties.settle.properties.outcome.enum).toEqual([
      "settled",
      "pending",
      "unsupported",
      "destroyed",
    ]);
  });
});

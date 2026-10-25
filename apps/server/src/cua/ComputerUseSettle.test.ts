import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  active,
  call,
  CONTROL,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

it.effect("a settle read cut off by pause carries no mutation uncertainty or fresh sample", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active());
    yield* h.send(call(1, "wait_for_window_settle", { pid: 4, window_id: 9 }));
    assert.equal((yield* h.nextToDriver).id, 1);
    yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
    yield* h.killed;
    const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
    assert.isTrue(answer.result.isError);
    assert.deepEqual(answer.result.structuredContent, {
      code: "interrupted",
      detail: "private_mode",
    });
    assert.notProperty(answer.result.structuredContent, "effect");
    assert.notProperty(answer.result.structuredContent, "snapshot_id");
    assert.notInclude(answer.result.content[0]?.text ?? "", "may already have acted");
  }),
);

// oxlint-disable-next-line goat/no-global-process-runtime -- This fixture compiles for its actual host toolchain.
const nativePlatform = NodeOS.platform();
// quarantine: #1506 This compiles native schema construction only, with no live AX or TCC calls.
it.skipIf(nativePlatform !== "darwin")(
  "the MCP SDK accepts the native discovery and result schemas",
  async () => {
    const [
      { execFileSync },
      fs,
      os,
      path,
      { ListToolsResultSchema, CallToolResultSchema },
      { AjvJsonSchemaValidator },
    ] = await Promise.all([
      import("node:child_process"),
      import("node:fs"),
      import("node:os"),
      import("node:path"),
      import("@modelcontextprotocol/sdk/types.js"),
      import("@modelcontextprotocol/sdk/validation/ajv"),
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goat-settle-schema-"));
    try {
      const source = path.resolve(
        import.meta.dirname,
        "../../../desktop/native/computer-use-helper",
      );
      const fixture = path.join(directory, "SchemaFixture.swift");
      const executable = path.join(directory, "schema");
      fs.writeFileSync(
        fixture,
        `import Foundation
@main struct SchemaFixture {
  static func main() throws {
    let request = SettleRequest(pid: 41, windowID: 73, quietMs: 200, timeoutMs: 1000, session: nil)
    let snapshot = SettleSnapshot(result: try mcpJSON(["content": [["type": "text", "text": "invented fixture"]], "structuredContent": ["snapshot_id": "fixture"]]), invalidated: [], degraded: false)
    var replies: [String: Any] = [:]
    for outcome in ["settled", "pending", "unsupported", "destroyed"] {
      let completion = SettleCompletion(outcome: outcome, reason: "fixture", sample: outcome == "settled" ? snapshot : nil, sampleStartedAt: 200, sampleCompletedAt: 210, invalidated: [], coverage: ["AXValueChanged"], observedQuietMs: 200, driverCode: nil, message: nil)
      replies[outcome] = settleToolResult(completion, request: request, startedAt: 0)
    }
    FileHandle.standardOutput.write(try mcpJSON(["catalog": ["tools": [windowSettleTool]], "replies": replies]))
  }
}`,
      );
      execFileSync("xcrun", [
        "swiftc",
        "-whole-module-optimization",
        "-o",
        executable,
        ...["WindowSettle.swift", "NativeManifest.swift", "McpNativeToolContract.swift"].map(
          (name) => path.join(source, name),
        ),
        fixture,
      ]);
      const payload: unknown = JSON.parse(execFileSync(executable, { encoding: "utf8" }));
      const decoded = payload as { catalog: unknown; replies: Record<string, unknown> };
      const listed = ListToolsResultSchema.parse(decoded.catalog);
      const tool = listed.tools[0];
      assert.isDefined(tool);
      if (!tool?.outputSchema) return assert.fail("native tool needs its result schema");
      const validator = new AjvJsonSchemaValidator();
      const input = validator.getValidator(tool.inputSchema as JsonSchemaType);
      assert.isTrue(input({ pid: 41, window_id: 73 }).valid);
      for (const arguments_ of [
        { pid: true, window_id: 73 },
        { pid: 41, window_id: 0 },
        { pid: 41, window_id: 73, extra: true },
      ])
        assert.isFalse(input(arguments_).valid);
      const output = validator.getValidator(tool.outputSchema as JsonSchemaType);
      for (const result of Object.values(decoded.replies)) {
        const reply = CallToolResultSchema.parse(result);
        assert.isTrue(output(reply.structuredContent).valid);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

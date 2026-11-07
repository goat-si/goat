import * as M from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  initialMemoryImportWorkflowState,
  memoryImportFormats,
  memoryImportIssueReason,
  memoryImportRequestFailureMessage,
  memoryImportResultLines,
  reduceMemoryImportProgress,
} from "./memoryImportWorkflow.ts";

const receipt: M.MemoryImportReceipt = {
  operationId: M.MemoryOperationId.make("00000000-0000-4000-8000-000000000050"),
  sourceId: M.MemoryImportSourceId.make("00000000-0000-4000-8000-000000000003"),
  sessionId: "import-session",
  sessionNewItems: 1,
  sessionBodyBytes: 1,
  state: "completed",
  remaining: 0,
  items: [],
};

describe("memoryImportIssueReason", () => {
  it("distinguishes an oversized or secret-bearing page from a whole-request refusal", () => {
    expect(memoryImportIssueReason("limit_exceeded", "item")).toBe(
      "This memory exceeds the import size limit.",
    );
    expect(memoryImportIssueReason("secret_detected", "item")).toBe(
      "This file contains sensitive content.",
    );
    expect(memoryImportIssueReason("secret_detected")).toBe(
      "Import stopped because sensitive content was found.",
    );
  });

  it("offers Aside only when the destination server explicitly advertises it", () => {
    expect(memoryImportFormats(undefined)).toEqual(["codex", "claude", "omo"]);
    expect(
      memoryImportFormats({ repositoryIdentity: false, memory: { protocolVersion: 1 } }),
    ).toEqual(["codex", "claude", "omo"]);
    expect(
      memoryImportFormats({
        repositoryIdentity: false,
        memory: { protocolVersion: 1, asideImport: true },
      }),
    ).toEqual(["codex", "claude", "omo", "aside"]);
  });
  it("names the refusals a person can act on", () => {
    expect(memoryImportIssueReason("limit_exceeded")).toBe(
      "This source is over an import limit: up to 128 memories per preview, 256 KiB per file and 8 MiB in total. Two other previews running at once also hit this limit.",
    );
    expect(memoryImportIssueReason("scope_unmapped")).toBe(
      "Items in projects/ need a project scope.",
    );
    expect(memoryImportIssueReason("source_missing")).toBe(
      "That memory store or profile is not on this device.",
    );
    expect(memoryImportIssueReason("source_missing", "request", "claude")).toBe(
      "No Claude memories were found on this device. GOAT looks in .claude/projects/<project>/memory in your home folder.",
    );
  });

  it("a capacity refusal names what is full and how to free space", () => {
    const capacity = {
      code: "capacity_exceeded" as const,
      dimension: "user_items" as const,
      current: 500,
      limit: 500,
      reclaimable: 0,
    };
    expect(
      memoryImportRequestFailureMessage(
        new M.MemoryImportRpcError({ issue: "capacity_exceeded", capacity }),
      ),
    ).toBe(
      "Memory storage is full: User memory count limit reached (500 of 500). Forget memories you no longer need in Settings → Memory to free space, then preview again.",
    );
    expect(
      memoryImportResultLines({
        outcomes: { created: 2, rejected: 1 },
        issues: { capacity_exceeded: 1 },
        capacity: { user_items: 1 },
      }),
    ).toEqual([
      "Added: 2",
      "Could not import: 1",
      "Storage limit reached: 1",
      "User memory count limit reached: 1",
      "Forget memories you no longer need in Settings → Memory to free space, then preview again",
    ]);
    // Forgetting does not lower lifetime identifiers, so that limit gets no forget advice.
    expect(
      memoryImportRequestFailureMessage(
        new M.MemoryImportRpcError({
          issue: "capacity_exceeded",
          capacity: { ...capacity, dimension: "lifetime_ids" },
        }),
      ),
    ).toBe("Memory storage is full: Memory identifier limit reached (500 of 500).");
    expect(
      memoryImportResultLines({ outcomes: {}, issues: {}, capacity: { lifetime_ids: 1 } }),
    ).toEqual(["Memory identifier limit reached: 1"]);
  });

  it("shows a typed refusal and leaves other failures unnamed", () => {
    expect(
      memoryImportRequestFailureMessage(new M.MemoryImportRpcError({ issue: "limit_exceeded" })),
    ).toBe(memoryImportIssueReason("limit_exceeded"));
    expect(memoryImportRequestFailureMessage(new Error("network"))).toBeNull();
    expect(memoryImportRequestFailureMessage({ _tag: "MemoryRpcError", code: "unavailable" })).toBe(
      null,
    );
  });

  it("tells a full memory store apart from the live memory text limit it shares", () => {
    const refused = (limit: number): M.MemoryImportItemResult => ({
      sourceItemKey: `item-${limit}`,
      outcome: "rejected",
      issue: "capacity_exceeded",
      capacity: {
        code: "capacity_exceeded",
        dimension: "live_payload_bytes",
        current: limit,
        limit,
        reclaimable: 0,
      },
      memoryId: null,
      revisionId: null,
    });
    const state = reduceMemoryImportProgress(
      { ...initialMemoryImportWorkflowState, phase: "applying" as const },
      {
        type: "receipt",
        receipt: {
          ...receipt,
          items: [refused(M.MEMORY_STORE_BUDGET_BYTES), refused(4096)],
        },
      },
    );
    expect(memoryImportResultLines(state.totals)).toEqual([
      "Could not import: 2",
      "Storage limit reached: 2",
      "Memory storage limit reached: 1",
      "Automatic cleanup already ran and could not make room. Forgetting a memory frees only its own text, so it helps only when many memories are no longer needed",
      "Memory content storage limit reached: 1",
      "Forget memories you no longer need in Settings → Memory to free space, then preview again",
    ]);
    expect(
      memoryImportRequestFailureMessage(
        new M.MemoryImportRpcError({
          issue: "capacity_exceeded",
          capacity: refused(M.MEMORY_STORE_BUDGET_BYTES).capacity!,
        }),
      ),
    ).toMatch(/^Memory storage limit reached: 100\.0 MiB of 100\.0 MiB used\. Automatic cleanup/);
  });
});

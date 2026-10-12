import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  confirmPromotedGlobalAgent,
  resolveGlobalAgent,
  type GlobalAgentResolverInput,
} from "./globalAgentResolver";

const ENV = "env-1" as EnvironmentId;
const SCRATCH_ENV = "env-2" as EnvironmentId;
const REF = { environmentId: ENV, threadId: "thread-1" as ThreadId, draftId: "draft-1" as DraftId };
const LIVE = { archivedAt: null, deletedAt: null };
const ARCHIVED = { archivedAt: "2026-10-10T00:00:00.000Z", deletedAt: null };
const DELETED = { archivedAt: null, deletedAt: "2026-10-10T00:00:00.000Z" };

function input(overrides: Partial<GlobalAgentResolverInput>): GlobalAgentResolverInput {
  return {
    bootstrapped: true,
    ref: REF,
    threadShell: null,
    draftState: "none",
    refEnvironmentKnown: true,
    scratchEnvironmentId: SCRATCH_ENV,
    ...overrides,
  };
}
const CREATE = { kind: "create", environmentId: SCRATCH_ENV };

describe("resolveGlobalAgent", () => {
  it("waits until shells bootstrap", () => {
    expect(resolveGlobalAgent(input({ bootstrapped: false }))).toEqual({ kind: "wait" });
  });
  it("falls back when the saved machine is unknown", () => {
    expect(resolveGlobalAgent(input({ refEnvironmentKnown: false }))).toEqual({ kind: "fallback" });
  });
  it("opens the live thread", () => {
    expect(resolveGlobalAgent(input({ threadShell: LIVE }))).toEqual({
      kind: "open-thread",
      environmentId: ENV,
      threadId: REF.threadId,
    });
  });
  it("creates when the shell is archived", () => {
    expect(resolveGlobalAgent(input({ threadShell: ARCHIVED }))).toEqual(CREATE);
  });
  it("creates when the shell is deleted", () => {
    expect(resolveGlobalAgent(input({ threadShell: DELETED }))).toEqual(CREATE);
  });
  it("creates when the shell is archived even if a promoted draft survives", () => {
    expect(resolveGlobalAgent(input({ threadShell: ARCHIVED, draftState: "promoted" }))).toEqual(
      CREATE,
    );
  });
  it("opens an unsent draft", () => {
    expect(resolveGlobalAgent(input({ draftState: "unpromoted" }))).toEqual({
      kind: "open-draft",
      draftId: REF.draftId,
    });
  });
  it("confirms a promoted draft whose shell has not arrived", () => {
    expect(resolveGlobalAgent(input({ draftState: "promoted" }))).toEqual({
      kind: "confirm-thread",
      environmentId: ENV,
      threadId: REF.threadId,
    });
  });
  it("creates when neither shell nor draft remains", () => {
    expect(resolveGlobalAgent(input({}))).toEqual(CREATE);
  });
  it("creates without a saved ref", () => {
    expect(resolveGlobalAgent(input({ ref: null }))).toEqual(CREATE);
  });
  it("falls back without a saved ref or scratch machine", () => {
    expect(resolveGlobalAgent(input({ ref: null, scratchEnvironmentId: null }))).toEqual({
      kind: "fallback",
    });
  });
  it("falls back when a stale ref has no scratch machine", () => {
    expect(resolveGlobalAgent(input({ scratchEnvironmentId: null }))).toEqual({ kind: "fallback" });
  });
});

describe("confirmPromotedGlobalAgent", () => {
  const confirm = (
    shell: GlobalAgentResolverInput["threadShell"],
    scratchEnvironmentId: EnvironmentId | null,
  ) =>
    confirmPromotedGlobalAgent({
      environmentId: ENV,
      threadId: REF.threadId,
      readScratchEnvironmentId: () => scratchEnvironmentId,
      waitForShell: async () => shell !== null,
      readShell: () => shell,
    });
  it("opens the thread when its live shell arrives", async () => {
    expect(await confirm(LIVE, SCRATCH_ENV)).toEqual({
      kind: "open-thread",
      environmentId: ENV,
      threadId: REF.threadId,
    });
  });
  it("creates when the arriving shell is archived", async () => {
    expect(await confirm(ARCHIVED, SCRATCH_ENV)).toEqual(CREATE);
  });
  it("creates when the shell never arrives (archived elsewhere)", async () => {
    expect(await confirm(null, SCRATCH_ENV)).toEqual(CREATE);
  });
  it("falls back when the shell never arrives and no scratch machine exists", async () => {
    expect(await confirm(null, null)).toEqual({ kind: "fallback" });
  });
  it("reads scratch availability after the wait, not before", async () => {
    let scratch: EnvironmentId | null = null;
    const settled = confirmPromotedGlobalAgent({
      environmentId: ENV,
      threadId: REF.threadId,
      readScratchEnvironmentId: () => scratch,
      waitForShell: async () => {
        scratch = SCRATCH_ENV; // the machine reconnects during the wait
        return false;
      },
      readShell: () => null,
    });
    expect(await settled).toEqual(CREATE);
  });
});

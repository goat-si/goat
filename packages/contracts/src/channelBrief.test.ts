import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChannelTaskBrief,
  ChannelTaskExportInput,
  ChannelTaskMemoryDelivered,
} from "./channelBrief.ts";

const brief = {
  version: 1,
  generation: 1,
  intent: "Inspect the build",
  instruction: "\n Inspect the build\nShow evidence.",
  deliveredText: "\n Inspect the build\nShow evidence.\nWorker guidance.",
  scopeIn: null,
  scopeOut: null,
  criteria: null,
  verification: null,
  context: { notesPath: "/sandbox/memory.md", skillsPath: "/sandbox/skills" },
  target: { environmentId: "env-local", provider: "codex", model: "gpt-6.1-sol" },
  frozenAt: "2026-10-17T00:00:00.000Z",
};

const decode = Schema.decodeUnknownSync(ChannelTaskBrief);

describe("ChannelTaskBrief", () => {
  it("round-trips the exact delivered instruction and nullable criteria", () => {
    const codec = Schema.fromJsonString(ChannelTaskBrief);
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(decode(brief)))).toEqual(brief);
    expect(
      decode({ ...brief, target: { ...brief.target, hostId: "mac-studio" } }).target.hostId,
    ).toBe("mac-studio");
  });

  it("keeps old briefs readable and distinguishes absent notes from a content hash", () => {
    expect(decode(brief).context.notesRevision).toBeUndefined();
    expect(decode({ ...brief, context: { notesRevision: null } }).context.notesRevision).toBeNull();
    expect(
      decode({ ...brief, context: { notesRevision: "a".repeat(64) } }).context.notesRevision,
    ).toBe("a".repeat(64));
    expect(() => decode({ ...brief, context: { notesRevision: "not-a-hash" } })).toThrow();
    const lineage = Schema.decodeUnknownSync(ChannelTaskMemoryDelivered);
    expect(lineage({ state: "unknown", revisions: [] }).state).toBe("unknown");
    expect(() =>
      lineage({
        state: "tracked",
        revisions: Array.from({ length: 101 }, () => "00000000-0000-4000-8000-000000000001"),
      }),
    ).toThrow();
  });

  it("requires positive integer versions and bounds the one-line intent", () => {
    for (const version of [0, -1, 1.5]) expect(() => decode({ ...brief, version })).toThrow();
    expect(() => decode({ ...brief, generation: 0 })).toThrow();
    expect(() => decode({ ...brief, intent: "x".repeat(501) })).toThrow();
  });

  it("bounds export pages and accepts an event sequence cursor", () => {
    const decodeInput = Schema.decodeUnknownSync(ChannelTaskExportInput);
    const range = { from: "2026-10-17T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z" };
    expect(decodeInput({ ...range, cursor: "42", limit: 1 }).cursor).toBe("42");
    for (const limit of [0, 201, 1.5]) expect(() => decodeInput({ ...range, limit })).toThrow();
    expect(() => decodeInput({ ...range, cursor: "not-a-sequence" })).toThrow();
    expect(() => decodeInput({ ...range, cursor: "99999999999999999" })).toThrow();
    expect(() => decodeInput({ ...range, from: "not-a-date" })).toThrow();
    expect(() => decodeInput({ ...range, to: "2026-10-18T00:00:00+09:00" })).toThrow();
  });
});

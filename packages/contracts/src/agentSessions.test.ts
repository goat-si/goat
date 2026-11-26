import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AgentSessionImportResult, AgentSessionScanInput } from "./agentSessions.ts";
import { NonNegativeInt } from "./baseSchemas.ts";

const decodeScanInput = Schema.decodeUnknownSync(AgentSessionScanInput);
const decodeImportResult = Schema.decodeUnknownSync(AgentSessionImportResult);
const decodeOldImportResult = Schema.decodeUnknownSync(
  Schema.Struct({ importedCount: NonNegativeInt, skippedCount: NonNegativeInt }),
);

it("decodes import results across old and new client and server versions", () => {
  const oldResponse = { importedCount: 1, skippedCount: 1 };
  const newResponse = {
    ...oldResponse,
    skippedThreads: [{ thread: "example", reason: "Unavailable" }],
    skippedDetailsOmitted: 2,
  };
  expect(decodeImportResult(oldResponse)).toEqual(oldResponse);
  expect(
    decodeImportResult({ ...oldResponse, skippedThreads: newResponse.skippedThreads }),
  ).toEqual({
    ...oldResponse,
    skippedThreads: newResponse.skippedThreads,
  });
  expect(decodeOldImportResult(newResponse)).toEqual(oldResponse);
  const previousClient = Schema.decodeUnknownSync(
    AgentSessionImportResult.mapFields(({ skippedDetailsOmitted: _, ...fields }) => fields),
  );
  expect(previousClient(newResponse)).toEqual({
    ...oldResponse,
    skippedThreads: newResponse.skippedThreads,
  });
  expect(decodeImportResult(newResponse)).toEqual(newResponse);
});

describe("AgentSessionScanInput", () => {
  it("keeps the window optional for clients that predate it", () => {
    expect(decodeScanInput({})).toEqual({});
    expect(decodeScanInput({ windowDays: 30 })).toEqual({ windowDays: 30 });
  });

  it("rejects a window outside one day to ten years", () => {
    expect(() => decodeScanInput({ windowDays: 0 })).toThrow();
    expect(() => decodeScanInput({ windowDays: 3651 })).toThrow();
  });
});

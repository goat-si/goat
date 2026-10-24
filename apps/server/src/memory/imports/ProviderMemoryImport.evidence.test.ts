import * as M from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachImportEvidence } from "./ProviderMemoryImport.ts";

describe("attachImportEvidence", () => {
  it("commits an imported note with its GOAT credential redacted and its fingerprints unchanged (#1297)", () => {
    // A synthetic canary shaped like a registry token; not a real credential.
    const secret = "canaryImportToken".padEnd(43, "0");
    const sourceId = M.MemoryImportSourceId.make("00000000-0000-4000-8000-000000000003");
    const candidate = {
      sourceItemKey: "note-1",
      sourceFingerprint: "a".repeat(64),
      contentFingerprint: "b".repeat(64),
      payload: {
        text: `deploy with GOAT_MCP_BEARER_TOKEN=${secret}`,
        evidence: [],
        derivedFromMemoryRevisions: [],
      },
      byteCount: 60,
    };

    const { candidate: attached, issue } = attachImportEvidence(candidate, sourceId);

    expect(issue).toBeUndefined();
    expect(attached.payload.text).toBe("deploy with GOAT_MCP_BEARER_TOKEN=[redacted]");
    // The fingerprints describe the raw source, so re-importing the same note still matches.
    expect(attached.sourceFingerprint).toBe(candidate.sourceFingerprint);
    expect(attached.contentFingerprint).toBe(candidate.contentFingerprint);
    expect(attached.payload.evidence).toEqual([
      { origin: "import", importSourceId: sourceId, messageIds: [] },
    ]);
  });
});

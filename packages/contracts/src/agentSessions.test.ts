import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AgentSessionScanInput } from "./agentSessions.ts";

const decodeScanInput = Schema.decodeUnknownSync(AgentSessionScanInput);

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

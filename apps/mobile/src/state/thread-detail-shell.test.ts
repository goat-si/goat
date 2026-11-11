import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { sideChatMarker } from "../features/threads/sideChatMarker";
import { threadDetailToShell } from "./thread-detail-shell";

describe("threadDetailToShell", () => {
  it("keeps a side chat's parent when only its detail is on the device", () => {
    const environmentId = EnvironmentId.make("env-a");
    const parentId = ThreadId.make("parent");
    const shell = threadDetailToShell(environmentId, {
      ...v2Projection,
      thread: { ...v2Projection.thread, sideChatOf: parentId },
    });

    expect(shell.sideChatOf).toBe(parentId);
    expect(sideChatMarker(shell, null)).toEqual({ parent: null });
  });
});

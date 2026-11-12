import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachmentUploadGate } from "./useSendAfterUploads";

const environmentId = EnvironmentId.make("env");
const gate = (states: Record<string, "uploading" | "failed" | "ready">, answering = false) =>
  attachmentUploadGate({
    imageIds: Object.keys(states),
    uploadsByImageId: Object.fromEntries(
      Object.entries(states).map(([id, status]) => [
        id,
        status === "uploading"
          ? { status, environmentId, progress: 0.5 }
          : status === "failed"
            ? { status, environmentId, reason: "network" }
            : { status, environmentId, attachmentId: id },
      ]),
    ),
    environmentId,
    answering,
    uploadsSupported: true,
  });

describe("attachmentUploadGate", () => {
  it("queues a plain send while uploads run", () => {
    expect(gate({ a: "uploading" }).canQueue).toBe(true);
  });

  it("keeps answers and approval redirects waiting for their uploads", () => {
    const answering = gate({ a: "uploading" }, true);
    expect(answering.canQueue).toBe(false);
    expect(answering.plainSend).toBe(false);
  });

  it("does not queue behind a failed upload, so Send waits for the rest as before", () => {
    const mixed = gate({ a: "failed", b: "uploading" });
    expect(mixed.canQueue).toBe(false);
    expect(mixed.plainSend).toBe(false);
    expect(mixed.blockReason).not.toBeNull();
  });
});

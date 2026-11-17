import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2PendingBackgroundTask, TrimmedNonEmptyString } from "./index.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2PendingBackgroundTask);
const encode = Schema.encodeSync(OrchestrationV2PendingBackgroundTask);

describe("a pending background task's nativeItemId", () => {
  it("decodes and encodes the turn item that started the work", () => {
    const task = decode({ taskId: "b1", kind: "command", nativeItemId: "toolu_1" });
    expect(task).toEqual({ taskId: "b1", kind: "command", nativeItemId: "toolu_1" });
    expect(encode(task)).toEqual({ taskId: "b1", kind: "command", nativeItemId: "toolu_1" });
  });

  it("decodes a task from before the field without one", () => {
    expect(decode({ taskId: "b1", kind: "command" })).toEqual({ taskId: "b1", kind: "command" });
  });

  it("refuses a blank id", () => {
    expect(() => decode({ taskId: "b1", kind: "command", nativeItemId: " " })).toThrow();
  });

  it("is dropped by a reader that predates it", () => {
    const olderReader = Schema.decodeUnknownSync(
      Schema.Struct({ taskId: TrimmedNonEmptyString, kind: Schema.String }),
    );
    expect(olderReader({ taskId: "b1", kind: "command", nativeItemId: "toolu_1" })).toEqual({
      taskId: "b1",
      kind: "command",
    });
  });
});

import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  OrchestrationV2RunJson,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShellJson,
} from "./orchestrationV2.ts";

const decodeCompletionNotification = Schema.decodeSync(
  OrchestrationV2RunJson.fields.completionNotification,
);

it("roundtrips notification timestamps and future decisions without confusing absence with null", () => {
  const dates = Schema.Struct({
    notificationCompletedAt: OrchestrationV2AppThreadJson.fields.notificationCompletedAt,
    markedUnreadCompletionAt: OrchestrationV2ThreadShellJson.fields.markedUnreadCompletionAt,
  });
  const decode = Schema.decodeUnknownSync(dates);
  const decoded = decode({
    notificationCompletedAt: null,
    markedUnreadCompletionAt: "2026-10-15T00:00:00.000Z",
  });
  expect(decoded.notificationCompletedAt).toBeNull();
  expect(
    decoded.markedUnreadCompletionAt && DateTime.formatIso(decoded.markedUnreadCompletionAt),
  ).toBe("2026-10-15T00:00:00.000Z");
  expect(decode({}).notificationCompletedAt).toBeUndefined();
  expect(decodeCompletionNotification("future")).toBe("future");
});

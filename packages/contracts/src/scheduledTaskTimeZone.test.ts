import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ScheduledTaskListResult } from "./scheduledTask.ts";

const decodeList = Schema.decodeUnknownSync(ScheduledTaskListResult);

it("accepts a task list from an older server without a time zone", () => {
  expect(decodeList({ tasks: [] })).toEqual({ tasks: [] });
});

it("rejects an empty time zone in a task list", () => {
  expect(() => decodeList({ tasks: [], timeZone: "" })).toThrow();
});

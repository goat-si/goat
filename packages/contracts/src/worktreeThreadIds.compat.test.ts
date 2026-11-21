import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { OrchestrationV2WorktreeThreadIds } from "./orchestrationV2.ts";
import { OrchestrationV2WorktreeThreadIds as base } from "./testing/worktreeThreadIds.base.ts";

const decodeBase = Schema.decodeUnknownSync(base);
const decodeCurrent = Schema.decodeUnknownSync(OrchestrationV2WorktreeThreadIds);

it("keeps old and new peers compatible with the optional removal guard", () => {
  const response = { threadIds: ["thread:side"], managed: true, removalGuarded: true };
  expect(decodeBase(response)).toEqual({ threadIds: ["thread:side"], managed: true });
  expect(decodeCurrent(response)).toEqual(response);
  expect(decodeCurrent({ threadIds: [] })).toEqual({ threadIds: [] });
  expect(decodeCurrent({ threadIds: [], removalGuarded: false })).toEqual({
    threadIds: [],
    removalGuarded: false,
  });
});

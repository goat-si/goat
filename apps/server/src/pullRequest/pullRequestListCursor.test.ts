import { expect, it } from "vite-plus/test";
import { changeRequest } from "./pullRequestTestFixtures.ts";
import { listCursorAt } from "./pullRequestListCursor.ts";

it("stops with no cursor when a tied boundary exceeds the safe limit", () => {
  const boundary = "2026-07-02T00:00:00Z";
  const tied = Array.from({ length: 129 }, (_, i) => changeRequest(i + 1, boundary));
  expect(listCursorAt(undefined, boundary, tied, tied.length)).toBeNull();
});

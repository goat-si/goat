import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:Sample-Tools/goat.git", "Sample-Tools/goat"],
  ["github.com:Sample-Tools/goat.git", "Sample-Tools/goat"],
  ["gitlab.com:T3Tools/platform/t3code", "T3Tools/platform/t3code"],
  ["https://github.com/Sample-Tools/goat.git", "Sample-Tools/goat"],
  ["https://github.com/Sample-Tools/goat.git?view=compact", "Sample-Tools/goat"],
  ["https://github.com/Sample-Tools/goat.git#section", "Sample-Tools/goat"],
  ["C:/repos/t3code", null],
])("reads the repository path of %s", (remoteUrl, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
});

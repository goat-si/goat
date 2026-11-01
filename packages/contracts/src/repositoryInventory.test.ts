import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  RepositoryInventoryKey,
  RepositoryInventorySnapshot,
  RepositoryLaunchSelection,
} from "./repositoryInventory.ts";

const isKey = Schema.is(RepositoryInventoryKey);
const isSelection = Schema.is(RepositoryLaunchSelection);
const isSnapshot = Schema.is(RepositoryInventorySnapshot);

it("rejects raw credentials, shell fragments, traversal, and noncanonical repository keys", () => {
  for (const key of [
    "https://user:password@example.test/owner/repo",
    "github.com/owner/../repo",
    "github.com/owner/repo;echo",
    "GitHub.com/Owner/Repo",
    "/tmp/repo",
    "github.com//repo",
  ]) {
    expect(isKey(key)).toBe(false);
  }
  expect(isKey("github.com/owner/repo")).toBe(true);
});

it("bounds candidate host discovery and inventory payloads", () => {
  expect(
    isSelection({
      key: "github.com/owner/repo",
      candidateHosts: Array(9).fill("host"),
    }),
  ).toBe(false);
  expect(isSnapshot({ sampledAt: 0, entries: [], truncated: true })).toBe(true);
  expect(isSnapshot({ sampledAt: -1, entries: [], truncated: false })).toBe(false);
});

import { MemorySpaceId, type MemoryPage, type RepositoryIdentity } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  memoryBrowseInput,
  memoryProjectScope,
  memorySearchInput,
  memoryPreview,
  presentMemoryPage,
} from "./memoryBrowsing.ts";
import { presentMemoryRunAccess } from "./memoryPresentation.ts";

const memorySpaceId = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const repository: RepositoryIdentity = {
  canonicalKey: "github.com/synthetic/fork",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/synthetic/fork.git",
  },
  origin: {
    canonicalKey: "github.com/synthetic/upstream",
  },
};
const page = {
  items: [],
  nextCursor: null,
  projectionWatermark: 1,
} satisfies MemoryPage;

describe("memory browsing", () => {
  it("uses an explicit shared id ahead of repository grouping, preserving scope in all requests", () => {
    const projectKey = { kind: "explicit", sharedProjectId: "synthetic-shared" } as const;
    const scope = memoryProjectScope({ projectKey, repositoryKey: null }, repository)!;
    const input = memoryBrowseInput({ memorySpaceId, limit: 40, scope, cursor: "next" });
    expect(input.scope).toEqual({ kind: "project", projectKey });
    expect(memorySearchInput(input, " hello ")).toMatchObject({
      scope,
      cursor: "next",
      query: "hello",
      mode: "fts",
    });
    expect(memoryBrowseInput({ memorySpaceId, limit: 40 }).scope).toEqual({ kind: "user" });
  });

  it("uses the server repository key or M3 grouping for unbound projects, never a path key", () => {
    expect(memoryProjectScope({ projectKey: null, repositoryKey: null }, repository)).toEqual({
      kind: "project",
      projectKey: { kind: "repository", groupingKey: "github.com/synthetic/upstream" },
    });
    expect(
      memoryProjectScope(
        { projectKey: null, repositoryKey: { kind: "repository", groupingKey: "server-observed" } },
        repository,
      ),
    ).toEqual({
      kind: "project",
      projectKey: { kind: "repository", groupingKey: "server-observed" },
    });
    expect(memoryProjectScope({ projectKey: null, repositoryKey: null }, null)).toBeNull();
  });

  it("always uses indexed search, including scopes beyond substring capacity", () => {
    // FTS does not attempt a substring scan, so 2,001 items or >8 MiB need no retry.
    expect(memorySearchInput({ memorySpaceId, limit: 40 }, "large scope").mode).toBe("fts");
  });

  it("distinguishes no memories, no search matches and an unmatched page with more to scan", () => {
    expect(presentMemoryPage(page, false)).toBe("No memories yet.");
    expect(presentMemoryPage(page, true)).toBe("No memories found");
    expect(presentMemoryPage({ ...page, nextCursor: "more" }, true)).toBe(
      "No matching memories on this page. Continue to the next page.",
    );
  });

  it.each(["partial", "unavailable"] as const)(
    "explains %s index coverage before claiming no results",
    (status) => {
      expect(
        presentMemoryPage(
          {
            ...page,
            indexCoverage: {
              status,
              eligibleItems: 2,
              indexedItems: status === "partial" ? 1 : 0,
              unindexedItems: status === "partial" ? 1 : 2,
              projectionWatermark: 1,
            },
          },
          true,
        ),
      ).toBe("Results are incomplete; memories may still be available");
    },
  );

  it("bounds list previews without cutting a Unicode character", () => {
    expect(memoryPreview("short")).toBe("short");
    expect(memoryPreview("가".repeat(121))).toBe("가".repeat(120));
    expect(memoryPreview("a".repeat(119) + "😀tail")).toBe("a".repeat(119) + "😀");
    expect(memoryPreview("")).toBe("");
  });

  it.each([
    [undefined, "none"],
    ["none", "none"],
    ["read", "read"],
    ["read_write", "read & write"],
  ] as const)(
    "labels saved ceiling %s without implying effective access",
    (memoryGrantCeiling, label) => {
      expect(
        presentMemoryRunAccess(memoryGrantCeiling ? { memoryGrantCeiling } : {}),
      ).toMatchObject({
        savedCeilingLabel: `Memory limit: ${label}`,
        effectiveAccess: "unknown",
      });
    },
  );
});

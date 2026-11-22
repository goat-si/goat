import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceBasenameMatch,
  pickWorkspaceLinkMatch,
  workspaceLinkLookupQuery,
} from "@goat/client-runtime/workspace-basename-lookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  // regression: #6297 a bare filename resolves to a file, never a same-named directory
  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("chat file links an agent shortened", () => {
  const cwd = "/home/user/acme";
  const entries = [
    { path: "packages/server/src/cloud/http.ts", kind: "file" as const },
    { path: "packages/server/src/cloud", kind: "directory" as const },
    { path: "packages/web/src/api/http.ts", kind: "file" as const },
    { path: "packages/server/src/index.ts", kind: "file" as const },
    { path: "packages/web/src/index.ts", kind: "file" as const },
  ];

  it("searches for package-relative paths and repeated prefixes, not exact ones", () => {
    expect(workspaceLinkLookupQuery("cloud/http.ts", cwd)).toBe("cloud/http.ts");
    expect(workspaceLinkLookupQuery("acme/packages/web/src/index.ts", cwd)).toBe(
      "packages/web/src/index.ts",
    );
    expect(workspaceLinkLookupQuery("./cloud/http.ts", cwd)).toBeNull();
    expect(workspaceLinkLookupQuery("~/acme/src/config.ts", cwd)).toBeNull();
    expect(workspaceLinkLookupQuery("packages/server/", cwd)).toBeNull();
  });

  it("opens the one file a package-relative path is the suffix of", () => {
    expect(pickWorkspaceLinkMatch("cloud/http.ts", cwd, entries)).toBe(
      "packages/server/src/cloud/http.ts",
    );
    expect(pickWorkspaceLinkMatch("acme/packages/web/src/index.ts", cwd, entries)).toBe(
      "packages/web/src/index.ts",
    );
  });

  it("opens nothing when the suffix names several files or splits a segment", () => {
    expect(pickWorkspaceLinkMatch("src/index.ts", cwd, entries)).toBeNull();
    expect(pickWorkspaceLinkMatch("ud/http.ts", cwd, entries)).toBeNull();
  });
});

describe("chat file links into another project", () => {
  const appB = {
    root: "/home/user/app-b",
    entries: [{ path: "src/api/rules/categories.ts", kind: "file" as const }],
  };

  // regression: #10553 a path the agent cited inside another registered project
  it("resolves to the absolute path in the one project that has the file", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [
        { root: "/home/user/app-c", entries: [] },
        appB,
      ]),
    ).toBe("/home/user/app-b/src/api/rules/categories.ts");
  });

  it.each([
    {
      outer: "/home/user/reports",
      inner: "/home/user/reports/docs",
      found: "/home/user/reports/docs/handoff.txt",
    },
    { outer: "C:\\Reports", inner: "C:/Reports/docs/", found: "C:\\Reports\\docs\\handoff.txt" },
  ])("resolves one file that a project nested in $outer also lists", ({ outer, inner, found }) => {
    expect(
      pickProjectLinkMatch("handoff.txt", [
        { root: outer, entries: [{ path: "docs/handoff.txt", kind: "file" }] },
        { root: inner, entries: [{ path: "handoff.txt", kind: "file" }] },
      ]),
    ).toBe(found);
  });

  it("opens nothing when several projects have the file", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [appB, { ...appB, root: "/home/user/app-c" }]),
    ).toBeNull();
  });

  it("opens nothing when a project left ambiguous by case also has the name", () => {
    expect(
      pickProjectLinkMatch("handoff.txt", [
        { root: "/reports", entries: [{ path: "notes/HANDOFF.txt", kind: "file" }] },
        {
          root: "/support",
          entries: [
            { path: "current/Handoff.txt", kind: "file" },
            { path: "archive/HANDOFF.txt", kind: "file" },
          ],
        },
      ]),
    ).toBeNull();
  });

  it("opens nothing when overlapping projects also list a second suffix match", () => {
    expect(
      pickProjectLinkMatch("docs/handoff.txt", [
        {
          root: "/home/user/reports",
          entries: [
            { path: "quarter/docs/handoff.txt", kind: "file" },
            { path: "archive/docs/handoff.txt", kind: "file" },
          ],
        },
        {
          root: "/home/user/reports/quarter",
          entries: [{ path: "docs/handoff.txt", kind: "file" }],
        },
        {
          root: "/home/user/reports/quarter/docs",
          entries: [{ path: "handoff.txt", kind: "file" }],
        },
      ]),
    ).toBeNull();
  });

  it.each([
    { cited: "handoff.txt", other: "archive/handoff.txt" },
    { cited: "HANDOFF.txt", other: "archive/Handoff.txt" },
  ])("opens nothing when overlapping projects also list $other", ({ cited, other }) => {
    expect(
      pickProjectLinkMatch("handoff.txt", [
        {
          root: "/home/user/reports",
          entries: [
            { path: `team/docs/${cited}`, kind: "file" },
            { path: other, kind: "file" },
          ],
        },
        { root: "/home/user/reports/team", entries: [{ path: `docs/${cited}`, kind: "file" }] },
        { root: "/home/user/reports/team/docs", entries: [{ path: cited, kind: "file" }] },
      ]),
    ).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});

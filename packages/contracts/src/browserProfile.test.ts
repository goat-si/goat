import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { BrowserImportInput } from "./browserImport.ts";

import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };

describe("resolveBrowserProfiles", () => {
  it("drops stored entries that collide with a built-in id", () => {
    const resolved = resolveBrowserProfiles([
      { id: DEFAULT_BROWSER_PROFILE_ID, name: "Hijacked", kind: "persistent" },
      { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Not incognito", kind: "persistent" },
      work,
    ]);

    expect(resolved).toEqual([...BUILT_IN_BROWSER_PROFILES, work]);
  });

  it("retains the default profile's import link without changing its identity", () => {
    const importSource = { sourceId: "chrome" as const, sourceProfileDirectory: "Default" };
    expect(
      resolveBrowserProfiles([
        { id: DEFAULT_BROWSER_PROFILE_ID, name: "Other", kind: "persistent", importSource },
      ])[0],
    ).toEqual({
      ...BUILT_IN_BROWSER_PROFILES[0],
      importSource,
    });
  });
});

describe("browser import origin contract", () => {
  it("accepts canonical HTTP origins and rejects paths and non-HTTP schemes", () => {
    const decode = Schema.decodeUnknownSync(BrowserImportInput);
    const base = {
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: "default",
    };
    expect(decode({ ...base, origins: ["https://example.com:8443"] }).origins).toEqual([
      "https://example.com:8443",
    ]);
    expect(() => decode({ ...base, origins: ["https://example.com/path"] })).toThrow();
    expect(() => decode({ ...base, origins: ["file:///tmp/example"] })).toThrow();
  });
});

describe("resolveBrowserProfiles normalization", () => {
  it("reports a custom incognito profile as persistent", () => {
    const resolved = resolveBrowserProfiles([
      { id: "throwaway", name: "Throwaway", kind: "incognito" },
    ]);

    expect(resolved.find((profile) => profile.id === "throwaway")).toEqual({
      id: "throwaway",
      name: "Throwaway",
      kind: "persistent",
    });
  });
});

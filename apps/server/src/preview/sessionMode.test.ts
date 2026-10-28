// @effect-diagnostics nodeBuiltinImport:off - pin files live in a temporary profiles folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PreviewSessionStore, PreviewTabSession } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import {
  assertReusable,
  openInSession,
  SessionProfiles,
  type RequestedSession,
} from "./sessionMode.ts";

const withProfiles = (names: ReadonlyArray<string>) => {
  const profiles = new SessionProfiles();
  profiles.report({
    profiles: names.map((name) => ({ id: name.toLowerCase(), name, kind: "persistent" as const })),
    defaultProfileId: "default",
  });
  return profiles;
};

const tagOf = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    return (cause as { readonly tag?: string }).tag;
  }
  return undefined;
};

describe("which session a new agent tab opens in", () => {
  const two = withProfiles(["Work"]);

  it("is isolated unless the request names a profile or profile mode, even with a client default", () => {
    expect(two.resolve({})).toEqual({ mode: "isolated" });
    expect(two.resolve({ session: "isolated" })).toEqual({ mode: "isolated" });
    expect(two.resolve({ profileId: "incognito" })).toEqual({ mode: "isolated" });
  });

  it("uses a named profile by id or name", () => {
    expect(two.resolve({ profileId: "Work" })).toEqual({ mode: "profile", profileId: "work" });
    expect(two.resolve({ session: "profile", profileId: "default" })).toEqual({
      mode: "profile",
      profileId: "default",
    });
  });

  it("reports ambiguity instead of picking when more than one profile could hold the account", () => {
    expect(tagOf(() => two.resolve({ session: "profile" }))).toBe(
      "PreviewAutomationAmbiguousProfileError",
    );
    expect(new SessionProfiles().resolve({ session: "profile" })).toEqual({
      mode: "profile",
      profileId: "default",
    });
  });

  it("refuses an unknown profile instead of falling back to isolated", () => {
    expect(tagOf(() => two.resolve({ profileId: "Personal" }))).toBe(
      "PreviewAutomationUnknownProfileError",
    );
  });

  it("refuses to reuse a tab for a different session and accepts the same one", () => {
    const isolated: PreviewTabSession = { mode: "isolated", store: "server" };
    expect(tagOf(() => assertReusable(isolated, { profileId: "Work" }, two))).toBe(
      "PreviewAutomationSessionMismatchError",
    );
    expect(tagOf(() => assertReusable(isolated, { session: "isolated" }, two))).toBeUndefined();
    expect(tagOf(() => assertReusable(isolated, {}, two))).toBeUndefined();
  });
});

interface FakeTab {
  readonly session: PreviewTabSession;
}

const scenario = async (options: {
  readonly session: RequestedSession;
  readonly desktopAvailable: boolean;
  readonly pin?: PreviewSessionStore;
  /** The store the created tab ended up in, or a failure from creating it. */
  readonly creates: PreviewSessionStore | Error;
  readonly hostedElsewhere?: boolean;
}) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-session-"));
  const contexts = new ServerBrowserContexts({
    profilesDir: directory,
    executable: () => Promise.reject(new Error("no browser in this test")),
  });
  if (options.pin && options.session.mode === "profile")
    await contexts.pinStore(options.session.profileId, options.pin);
  const opened: Array<{ readonly profileId: string; readonly serverRendered?: true }> = [];
  let discarded = 0;
  const result = await openInSession<string, FakeTab>(
    {
      profiles: new SessionProfiles(),
      contexts,
      desktopAvailable: options.desktopAvailable,
      open: async (fields) => {
        opened.push(fields);
        return "snapshot";
      },
      ensureTab: async () => {
        if (options.creates instanceof Error) throw options.creates;
        return {
          session:
            options.session.mode === "isolated"
              ? { mode: "isolated", store: "server" }
              : { mode: "profile", profileId: options.session.profileId, store: options.creates },
        };
      },
      hostedElsewhere: async () => options.hostedElsewhere === true,
      discard: async () => {
        discarded++;
      },
    },
    options.session,
  ).then(
    (tab) => ({ tab }),
    (cause: unknown) => ({ refused: (cause as { readonly tag?: string }).tag ?? String(cause) }),
  );
  const pin =
    options.session.mode === "profile"
      ? await contexts.storePin(options.session.profileId)
      : undefined;
  await NodeFSP.rm(directory, { recursive: true, force: true });
  return { result, opened, discarded, pin };
};

const profile: RequestedSession = { mode: "profile", profileId: "default" };

describe("the sign-in store a profile is pinned to", () => {
  it("never consults a store for an isolated tab, which the server renders", async () => {
    const run = await scenario({
      session: { mode: "isolated" },
      desktopAvailable: true,
      creates: "server",
    });
    expect(run.opened).toEqual([{ profileId: "incognito", serverRendered: true }]);
    expect(run.result).toHaveProperty("tab");
  });

  it("pins an unpinned profile to the store its first open used", async () => {
    const desktop = await scenario({
      session: profile,
      desktopAvailable: true,
      creates: "desktop",
    });
    expect(desktop.opened).toEqual([{ profileId: "default" }]);
    expect(desktop.pin).toBe("desktop");
    const server = await scenario({ session: profile, desktopAvailable: false, creates: "server" });
    expect(server.opened).toEqual([{ profileId: "default", serverRendered: true }]);
    expect(server.pin).toBe("server");
  });

  it("refuses a desktop-pinned profile where no desktop app can render it, opening nothing", async () => {
    const run = await scenario({
      session: profile,
      desktopAvailable: false,
      pin: "desktop",
      creates: "server",
    });
    expect(run.result).toEqual({ refused: "PreviewAutomationProfileStoreUnavailableError" });
    expect(run.opened).toEqual([]);
    expect(run.pin).toBe("desktop");
  });

  it("keeps a server-pinned profile on the server even when a desktop app is present", async () => {
    const run = await scenario({
      session: profile,
      desktopAvailable: true,
      pin: "server",
      creates: "server",
    });
    expect(run.opened).toEqual([{ profileId: "default", serverRendered: true }]);
    expect(run.pin).toBe("server");
  });

  it("closes a server-rendered tab an older desktop app hosted while it was created", async () => {
    const run = await scenario({
      session: { mode: "isolated" },
      desktopAvailable: true,
      creates: "server",
      hostedElsewhere: true,
    });
    expect(run.result).toEqual({ refused: "PreviewAutomationExecutionError" });
    expect(run.discarded).toBe(1);
  });

  it("pins nothing when the first open fails, and closes what it opened", async () => {
    const run = await scenario({
      session: profile,
      desktopAvailable: true,
      creates: new Error("the desktop app did not attach"),
    });
    expect(run.result).toEqual({ refused: "Error: the desktop app did not attach" });
    expect(run.discarded).toBe(1);
    expect(run.pin).toBeUndefined();
  });

  it("lets a clear requested during an open run after it, so no stale pin survives the clear", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-session-"));
    const contexts = new ServerBrowserContexts({
      profilesDir: directory,
      executable: () => Promise.reject(new Error("no browser in this test")),
    });
    let created!: () => void;
    const tabCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    const order: Array<string> = [];
    const open = openInSession<string, FakeTab>(
      {
        profiles: new SessionProfiles(),
        contexts,
        desktopAvailable: false,
        open: async () => "snapshot",
        ensureTab: async () => {
          await tabCreated;
          order.push("opened");
          return { session: { mode: "profile", profileId: "default", store: "server" } };
        },
        hostedElsewhere: async () => false,
        discard: async () => {},
      },
      profile,
    );
    const clear = contexts.clearProfile("default").then(() => void order.push("cleared"));
    created();
    await Promise.all([open, clear]);
    expect(order).toEqual(["opened", "cleared"]);
    expect(await contexts.storePin("default")).toBeUndefined();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
});

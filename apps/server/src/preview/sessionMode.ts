/**
 * Session modes for agent browser tabs (isolated by default, or a GOAT-owned profile) and the
 * profile sign-in store each one is pinned to. A request never falls back to another mode or store.
 */
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  findBrowserProfile,
  resolveBrowserProfiles,
  type BrowserProfile,
  type PreviewAutomationOpenInput,
  type PreviewReportProfilesInput,
  type PreviewSessionStore,
  type PreviewTabSession,
} from "@goat/contracts";

import type { Dialog } from "playwright-core";

import { ServerBrowserOperationError } from "./browserOperationError.ts";

/** What a new agent tab opens with: isolated, or one persistent profile. */
export type RequestedSession =
  | { readonly mode: "isolated" }
  | { readonly mode: "profile"; readonly profileId: string };

const refuse = (tag: string, message: string) =>
  new ServerBrowserOperationError(tag, message, { beforeInput: true });

const describe = (profile: BrowserProfile) => profile.name + " (id " + profile.id + ")";

export class SessionProfiles {
  private reported: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  } | null = null;

  report(input: PreviewReportProfilesInput) {
    const profiles = resolveBrowserProfiles(input.profiles);
    this.reported = {
      profiles,
      defaultProfileId:
        findBrowserProfile(profiles, input.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
    };
  }

  private get profiles() {
    return this.reported?.profiles ?? BUILT_IN_BROWSER_PROFILES;
  }

  status() {
    return {
      profiles: this.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(this.reported ? { defaultProfileId: this.reported.defaultProfileId } : {}),
    };
  }

  private find(requested: string) {
    const wanted = requested.toLowerCase();
    const match =
      findBrowserProfile(this.profiles, requested) ??
      this.profiles.find((profile) => profile.name.toLowerCase() === wanted);
    if (match) return match;
    throw refuse(
      "PreviewAutomationUnknownProfileError",
      'No browser profile is named "' +
        requested +
        '". Use one of: ' +
        this.profiles.map(describe).join(", ") +
        ".",
    );
  }

  /** Isolated unless the request names profile mode or a profile; never the client's default. */
  resolve(open: Pick<PreviewAutomationOpenInput, "profileId" | "session">): RequestedSession {
    if (open.profileId !== undefined) {
      const profile = this.find(open.profileId);
      return profile.kind === "incognito"
        ? { mode: "isolated" }
        : { mode: "profile", profileId: profile.id };
    }
    if (open.session !== "profile") return { mode: "isolated" };
    const persistent = this.profiles.filter((profile) => profile.kind === "persistent");
    const only = persistent.length === 1 ? persistent[0] : undefined;
    if (only) return { mode: "profile", profileId: only.id };
    throw refuse(
      "PreviewAutomationAmbiguousProfileError",
      "More than one GOAT profile could hold this sign-in, so GOAT did not pick one: " +
        persistent.map(describe).join(", ") +
        ". Pass profileId, or ask the person which account to use.",
    );
  }

  name(profileId: string) {
    return findBrowserProfile(this.profiles, profileId)?.name ?? profileId;
  }
}

/** The snapshot profile for a requested session: isolated tabs carry the ephemeral profile id. */
const snapshotProfileId = (session: RequestedSession) =>
  session.mode === "isolated" ? INCOGNITO_BROWSER_PROFILE_ID : session.profileId;

/**
 * Whether a profile tab renders on the server. A pinned store decides; an unpinned profile goes
 * where a desktop app can render it, and is pinned there once that open succeeds.
 */
const profileRendersOnServer = (
  name: string,
  pin: PreviewSessionStore | undefined,
  desktopAvailable: boolean,
) => {
  if (pin === "desktop" && !desktopAvailable) throw desktopStoreUnavailable(name);
  return pin === "server" || (pin === undefined && !desktopAvailable);
};

const desktopStoreUnavailable = (name: string) =>
  refuse(
    "PreviewAutomationProfileStoreUnavailableError",
    'Profile "' +
      name +
      '" keeps its sign-ins in the GOAT desktop app on this machine, and the desktop app did not open the tab. Open the desktop app here and retry, use session isolated, or choose another profile.',
  );

const storeConflict = (name: string, pinned: PreviewSessionStore) =>
  refuse(
    "PreviewAutomationProfileStoreUnavailableError",
    'Profile "' +
      name +
      '" was just pinned to its ' +
      (pinned === "desktop" ? "desktop app" : "server browser") +
      " sign-in store by another open, so this tab was closed. Retry the open.",
  );

const sameSession = (tab: PreviewTabSession, requested: RequestedSession) =>
  tab.mode === requested.mode &&
  (requested.mode === "isolated" || tab.profileId === requested.profileId);

/** A reused tab keeps its session; asking for a different one is refused, never switched. */
export const assertReusable = (
  tab: PreviewTabSession,
  open: Pick<PreviewAutomationOpenInput, "profileId" | "session">,
  profiles: SessionProfiles,
) => {
  if (open.profileId === undefined && open.session === undefined) return;
  const requested = profiles.resolve(open);
  if (sameSession(tab, requested)) return;
  throw refuse(
    "PreviewAutomationSessionMismatchError",
    "This tab uses " +
      (tab.mode === "isolated"
        ? "an isolated session"
        : 'profile "' + profiles.name(tab.profileId ?? "") + '"') +
      " and cannot switch. Open a new tab with reuseExistingTab=false for the other session.",
  );
};

/** The session a tab reports, from how it was created. */
export const tabSession = (tab: {
  readonly isolatedContext: boolean;
  readonly profileId: string | undefined;
  readonly desktop: unknown;
}): PreviewTabSession =>
  tab.isolatedContext
    ? { mode: "isolated", store: "server" }
    : {
        mode: "profile",
        profileId: tab.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
        store: tab.desktop === null ? "server" : "desktop",
      };

/** What opening a new agent tab needs from the browser. */
export interface SessionOpenDeps<Snapshot, Tab extends { readonly session: PreviewTabSession }> {
  readonly profiles: SessionProfiles;
  readonly contexts: {
    readonly storePin: (profileId: string) => Promise<PreviewSessionStore | undefined>;
    readonly pinStore: (
      profileId: string,
      store: PreviewSessionStore,
    ) => Promise<PreviewSessionStore>;
    readonly withProfile: <A>(profileId: string, run: () => Promise<A>) => Promise<A>;
  };
  readonly desktopAvailable: boolean;
  readonly open: (fields: {
    readonly profileId: string;
    readonly serverRendered?: true;
  }) => Promise<Snapshot>;
  readonly ensureTab: (snapshot: Snapshot) => Promise<Tab>;
  /** Closes a tab this open made, and its session record, before the open reports its failure. */
  readonly discard: (snapshot: Snapshot, tab?: Tab) => Promise<void>;
}

/**
 * Opens a new tab in exactly the requested session. A profile open runs alone for that profile,
 * reading its pin, opening, and pinning the store the tab used on its first success.
 */
export const openInSession = <Snapshot, Tab extends { readonly session: PreviewTabSession }>(
  deps: SessionOpenDeps<Snapshot, Tab>,
  session: RequestedSession,
): Promise<Tab> =>
  session.mode === "isolated"
    ? openTab(deps, session)
    : deps.contexts.withProfile(session.profileId, () => openTab(deps, session));

const openTab = async <Snapshot, Tab extends { readonly session: PreviewTabSession }>(
  deps: SessionOpenDeps<Snapshot, Tab>,
  session: RequestedSession,
): Promise<Tab> => {
  const profileId = snapshotProfileId(session);
  const name = deps.profiles.name(profileId);
  const serverRendered =
    session.mode === "isolated" ||
    profileRendersOnServer(name, await deps.contexts.storePin(profileId), deps.desktopAvailable);
  const snapshot = await deps.open({
    profileId,
    ...(serverRendered ? { serverRendered: true } : {}),
  });
  const tab = await deps.ensureTab(snapshot).catch(async (cause: unknown) => {
    await deps.discard(snapshot);
    throw cause;
  });
  if (session.mode === "isolated") return tab;
  const pinned = await deps.contexts
    .pinStore(profileId, tab.session.store)
    .catch(async (cause: unknown) => {
      await deps.discard(snapshot, tab);
      throw cause;
    });
  if (pinned === tab.session.store) return tab;
  await deps.discard(snapshot, tab);
  throw storeConflict(name, pinned);
};

/**
 * A desktop app attached its own copy of a tab the server renders: an older app that ignores
 * serverRendered, whose page uses its own sign-ins. The server closes the tab rather than let the
 * person and the agent see different pages.
 */
export const hostedTwice = (tab: {
  readonly desktop: unknown;
  readonly session: PreviewTabSession;
  readonly control: { readonly agentId: string | null };
}) => tab.desktop === null && tab.control.agentId !== null && tab.session.store === "server";

/** A pending dialog as status reports it. */
export const dialogStatus = (dialog: Dialog | null) =>
  dialog
    ? {
        type: dialog.type(),
        message: dialog.message().slice(0, 4000),
        defaultValue: dialog.defaultValue().slice(0, 4000),
      }
    : null;

/** An agent tab must render where its session's store is; it never falls back to the other. */
export const assertStoreUsed = (
  snapshot: {
    readonly automationOwner?: string | undefined;
    readonly serverRendered?: true | undefined;
    readonly profileId?: string | undefined;
  },
  desktop: unknown,
  profiles: SessionProfiles,
) => {
  if (
    desktop === null &&
    snapshot.automationOwner !== undefined &&
    snapshot.serverRendered !== true
  )
    throw desktopStoreUnavailable(profiles.name(snapshot.profileId ?? DEFAULT_BROWSER_PROFILE_ID));
};

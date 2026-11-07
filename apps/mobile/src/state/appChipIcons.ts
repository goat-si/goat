import { useAtomValue } from "@effect/atom-react";
import { appChipIcons } from "@goat/client-runtime/composerCapabilityItems";
import { assetUrlStateFromResult } from "@goat/client-runtime/state/assets";
import { AssetResource, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { cachedAppChipIcon, storedAppChipIcon } from "../lib/appChipIconCache";
import { assetEnvironment } from "./assets";
import { environmentSession } from "./session";

const ICON_IDLE_TTL_MS = 60 * 60_000;

// Native chips draw an icon only from a file they can read at once, so a chip gets one only
// once it is on disk; until then it keeps its computer use icon.
const storedIconAtom = Atom.family((key: string) =>
  Atom.make(Effect.promise(() => storedAppChipIcon(key).catch(() => null))).pipe(
    Atom.setIdleTTL(ICON_IDLE_TTL_MS),
    Atom.withLabel(`mobile-app-chip-icon-stored:${key}`),
  ),
);

const fetchedIconAtom = Atom.family((target: string) => {
  const [key, url] = decodeFetchTarget(JSON.parse(target));
  return Atom.make(Effect.promise(() => cachedAppChipIcon(key, url).catch(() => null))).pipe(
    Atom.setIdleTTL(ICON_IDLE_TTL_MS),
    Atom.withLabel(`mobile-app-chip-icon-fetched:${target}`),
  );
});

const decodeFetchTarget = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.String]));

const decodeIconKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, AssetResource]));

const appChipIconAtom = Atom.family((key: string) => {
  const [environmentId, resource] = decodeIconKey(JSON.parse(key));
  const query = assetEnvironment.createUrl({ environmentId, input: { resource } });
  // The signed URL is re-minted while the chip is on screen; keep the last one meanwhile.
  const url = Atom.make((get): string | null => {
    const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
    const state = assetUrlStateFromResult(
      get(query),
      Option.isSome(connection) ? connection.value.httpBaseUrl : null,
    );
    return state._tag === "Success" ? state.url : Option.getOrNull(get.self<string | null>());
  }).pipe(Atom.setIdleTTL(ICON_IDLE_TTL_MS));
  return Atom.make((get): string | null => {
    const current = get(url);
    if (current !== null) {
      const fetched = get(fetchedIconAtom(JSON.stringify([key, current])));
      if (AsyncResult.isSuccess(fetched) && fetched.value !== null) return fetched.value;
    }
    const stored = get(storedIconAtom(key));
    if (AsyncResult.isSuccess(stored) && stored.value !== null) return stored.value;
    return Option.getOrNull(get.self<string | null>());
  }).pipe(Atom.setIdleTTL(ICON_IDLE_TTL_MS), Atom.withLabel(`mobile-app-chip-icon:${key}`));
});

const decodeChipsKey = Schema.decodeUnknownSync(
  Schema.Tuple([
    EnvironmentId,
    Schema.Array(Schema.Struct({ contextId: Schema.String, resource: AssetResource })),
  ]),
);

const appChipIconsAtom = Atom.family((key: string) => {
  const [environmentId, chips] = decodeChipsKey(JSON.parse(key));
  return Atom.make((get) => {
    const icons = new Map<string, string>();
    for (const chip of chips) {
      const file = get(appChipIconAtom(JSON.stringify([environmentId, chip.resource])));
      if (file !== null) icons.set(chip.contextId, file);
    }
    return icons;
  }).pipe(Atom.withLabel(`mobile-app-chip-icons:${key}`));
});

const EMPTY_APP_CHIP_ICONS: ReadonlyMap<string, string> = new Map();
const EMPTY_APP_CHIP_ICONS_ATOM = Atom.make(EMPTY_APP_CHIP_ICONS).pipe(
  Atom.withLabel("mobile-app-chip-icons:empty"),
);

/**
 * The icon file of each `@Finder` chip in a draft or message, by context id, as the chip's
 * environment draws the app. A chip missing here keeps its computer use icon.
 */
export function useAppChipIcons(
  environmentId: EnvironmentId | null | undefined,
  text: string,
): ReadonlyMap<string, string> {
  const chips = environmentId ? appChipIcons(text) : [];
  return useAtomValue(
    chips.length === 0
      ? EMPTY_APP_CHIP_ICONS_ATOM
      : appChipIconsAtom(JSON.stringify([environmentId, chips])),
  );
}

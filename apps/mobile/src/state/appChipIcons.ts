import { useAtomValue } from "@effect/atom-react";
import { appChipIcons } from "@goat/client-runtime/composerCapabilityItems";
import { assetUrlStateFromResult } from "@goat/client-runtime/state/assets";
import { AssetResource, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { assetEnvironment } from "./assets";
import { environmentSession } from "./session";

const ICON_IDLE_TTL_MS = 60 * 60_000;

/**
 * Native chips draw an icon only from a file they can read at once; a URL they fetch themselves
 * draws nothing while it loads or when it fails. So the icon is fetched here, and a chip gets it
 * only once it sits in expo-image's disk cache.
 */
async function cachedIconFile(url: string): Promise<string | null> {
  const { Image } = await import("expo-image");
  if (!(await Image.prefetch(url, { cachePolicy: "disk" }))) return null;
  const path = await Image.getCachePathAsync(url);
  if (!path) return null;
  return path.startsWith("file:") ? path : `file://${path}`;
}

const iconFileAtom = Atom.family((url: string) =>
  Atom.make(Effect.promise(() => cachedIconFile(url).catch(() => null))).pipe(
    Atom.setIdleTTL(ICON_IDLE_TTL_MS),
    Atom.withLabel(`mobile-app-chip-icon-file:${url}`),
  ),
);

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
    if (current === null) return null;
    const file = get(iconFileAtom(current));
    // A new URL keeps the last file until its own fetch settles; a failed fetch drops it.
    return AsyncResult.isSuccess(file) ? file.value : Option.getOrNull(get.self<string | null>());
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

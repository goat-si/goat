/**
 * Names and icons for the apps computer use can reach, so a person picks `@Finder` by its icon
 * and sees which app each agent call touched. The ids are exactly the requestable ones, so
 * nothing here widens what an agent may use.
 *
 * @module appCatalog
 */
import { COMPUTER_USE_APP_ICON_LIMIT, type ComputerUseApp } from "@goat/contracts";
import { cuaRequestableApps, type CuaDriverListedApp } from "@goat/shared/cuaDriverManifest";

export interface CatalogApp {
  readonly id: string;
  readonly executable: string | undefined;
}

/**
 * Reads the icons of several apps at once, as PNG data URLs keyed by id; an app the OS has no
 * icon for is left out. Batched so a first listing costs one lookup, not one per app.
 */
export type AppIconReader = (
  apps: ReadonlyArray<CatalogApp>,
) => Promise<ReadonlyMap<string, string>>;

/**
 * The catalog for one listing: one entry per requestable id that names a running app, sorted by
 * name. An app's icon does not change while it runs, so each id is read once and kept, a miss
 * included; only the first COMPUTER_USE_APP_ICON_LIMIT entries get one.
 */
export function makeAppCatalog(readIcons: AppIconReader) {
  const icons = new Map<string, string | undefined>();
  return async (
    listed: ReadonlyArray<CuaDriverListedApp>,
    hostBundleIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<ComputerUseApp>> => {
    const requestable = new Set(cuaRequestableApps(listed, hostBundleIds));
    const entries = new Map<string, { name: string; executable: string | undefined }>();
    for (const app of listed) {
      const id = app.bundle_id?.trim() || app.executable?.trim() || "";
      if (!id || !requestable.has(id) || entries.has(id)) continue;
      entries.set(id, {
        name: app.name?.trim() || id,
        executable: app.executable?.trim() || undefined,
      });
    }
    const sorted = [...entries]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const unread = sorted.slice(0, COMPUTER_USE_APP_ICON_LIMIT).filter((app) => !icons.has(app.id));
    if (unread.length > 0) {
      const read = await readIcons(unread).catch(() => new Map<string, string>());
      for (const app of unread) icons.set(app.id, read.get(app.id));
    }
    return sorted.map(({ id, name }) => {
      const icon = icons.get(id);
      return icon === undefined ? { id, name } : { id, name, icon };
    });
  };
}

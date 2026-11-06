const ICON_DIRECTORY = "app-chip-icons";

const downloads = new Map<string, Promise<string | null>>();
let sweep: Promise<void> | undefined;
let tempSequence = 0;

async function iconFile(cacheKey: string) {
  const [{ Directory, File, Paths }, Crypto] = await Promise.all([
    import("expo-file-system"),
    import("expo-crypto"),
  ]);
  const name = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, cacheKey);
  const directory = new Directory(Paths.cache, ICON_DIRECTORY);
  return { File, directory, name, file: new File(directory, `${name}.png`) };
}

/**
 * Partial downloads a killed launch left behind. Every download waits for this first, so it
 * never meets a download of its own launch.
 */
function sweepPartialDownloads({ File, directory }: Awaited<ReturnType<typeof iconFile>>) {
  sweep ??= (async () => {
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(".tmp")) continue;
      try {
        entry.delete();
      } catch {}
    }
  })();
  return sweep;
}

/** The icon this device already keeps for an app, without asking its host. */
export async function storedAppChipIcon(cacheKey: string): Promise<string | null> {
  const { file } = await iconFile(cacheKey);
  return file.exists ? file.uri : null;
}

async function download(cacheKey: string, url: string): Promise<string | null> {
  const icon = await iconFile(cacheKey);
  const { File, directory, name, file } = icon;
  if (file.exists) return file.uri;
  await sweepPartialDownloads(icon);
  tempSequence += 1;
  const temp = new File(directory, `${name}.${tempSequence}.tmp`);
  try {
    directory.create({ intermediates: true, idempotent: true });
    await File.downloadFileAsync(url, temp, { idempotent: true });
    if (!file.exists) temp.moveSync(file);
    return file.uri;
  } catch {
    return file.exists ? file.uri : null;
  } finally {
    try {
      if (temp.exists) temp.delete();
    } catch {}
  }
}

/**
 * An app's icon as a file native chips can draw at once, kept under one name per app and host:
 * its signed URL changes each time it is re-minted, so caching by URL would store the same icon
 * again and again. A saved icon is never replaced, so a later change to the app's icon shows only
 * once the system clears its caches.
 */
export function cachedAppChipIcon(cacheKey: string, url: string): Promise<string | null> {
  const pending = downloads.get(cacheKey);
  if (pending) return pending;
  const next = download(cacheKey, url).finally(() => downloads.delete(cacheKey));
  downloads.set(cacheKey, next);
  return next;
}

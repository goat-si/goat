import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  files: new Set<string>(),
  directories: new Set<string>(),
  diskCache: new Map<string, string>(),
  fetches: [] as string[],
  failing: false,
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists(): boolean {
      return mocks.directories.has(this.uri);
    }
    create(): void {
      mocks.directories.add(this.uri);
    }
    list(): File[] {
      const prefix = `${this.uri}/`;
      return [...mocks.files]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new File(uri));
    }
  }
  class File {
    static downloadFileAsync = async (url: string, destination: File) => {
      mocks.fetches.push(url);
      if (mocks.failing) throw new Error("UnableToDownload: 404");
      mocks.files.add(destination.uri);
      return destination;
    };
    readonly uri: string;
    constructor(source: string | Directory, name?: string) {
      this.uri = typeof source === "string" ? source : `${source.uri}/${name}`;
    }
    get name(): string {
      return this.uri.split("/").at(-1) ?? "";
    }
    get exists(): boolean {
      return mocks.files.has(this.uri);
    }
    delete(): void {
      mocks.files.delete(this.uri);
    }
    moveSync(destination: File): void {
      if (mocks.files.has(destination.uri)) throw new Error("DestinationAlreadyExists");
      mocks.files.delete(this.uri);
      mocks.files.add(destination.uri);
    }
  }
  return { Directory, File, Paths: { cache: new Directory("file:///cache") } };
});

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => encodeURIComponent(value),
}));

vi.mock("expo-image", () => ({
  Image: {
    prefetch: async (url: string) => {
      mocks.fetches.push(url);
      if (mocks.failing) return false;
      mocks.diskCache.set(url, `/disk-cache/${mocks.diskCache.size}`);
      return true;
    },
    getCachePathAsync: async (key: string) => mocks.diskCache.get(key) ?? null,
  },
}));

const finder = JSON.stringify([
  "environment-1",
  { _tag: "native-app-icon", app: { _tag: "app-id", appId: "com.apple.finder" } },
]);
const signed = (token: number) => `https://host.example/api/assets/${token}/native-app-icon.png`;

/** A fresh module stands in for a new launch; the files on disk stay unless `wipe` is set. */
async function launch(options: { wipe?: boolean; failing?: boolean } = {}) {
  if (options.wipe ?? true) {
    mocks.files.clear();
    mocks.directories.clear();
    mocks.diskCache.clear();
    mocks.fetches.length = 0;
  }
  mocks.failing = options.failing ?? false;
  vi.resetModules();
  // Load the mocks once first: concurrent first imports of a mocked module race to the real one.
  await Promise.all([import("expo-file-system"), import("expo-crypto"), import("expo-image")]);
  return import("./appChipIconCache");
}

const tempFiles = () => [...mocks.files].filter((uri) => uri.endsWith(".tmp"));

describe("app chip icon cache", () => {
  it("keeps one icon file per app while its signed URL is re-minted", async () => {
    const cache = await launch();
    const first = await cache.cachedAppChipIcon(finder, signed(1));
    const second = await cache.cachedAppChipIcon(finder, signed(2));
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mocks.fetches).toHaveLength(1);
  });

  it("shares one download between concurrent requests for the same app", async () => {
    const cache = await launch();
    const [first, second] = await Promise.all([
      cache.cachedAppChipIcon(finder, signed(1)),
      cache.cachedAppChipIcon(finder, signed(2)),
    ]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mocks.fetches).toHaveLength(1);
  });

  it("gives no icon when the host has none, leaves no partial file, and tries again later", async () => {
    const cache = await launch({ failing: true });
    expect(await cache.cachedAppChipIcon(finder, signed(1))).toBeNull();
    expect(tempFiles()).toEqual([]);
    mocks.failing = false;
    expect(await cache.cachedAppChipIcon(finder, signed(2))).not.toBeNull();
    expect(mocks.fetches).toHaveLength(2);
  });

  it("shows the saved icon on the next launch without asking the host again", async () => {
    const first = await (await launch()).cachedAppChipIcon(finder, signed(1));
    const next = await launch({ wipe: false });
    expect(await next.storedAppChipIcon(finder)).toBe(first);
    expect(await next.cachedAppChipIcon(finder, signed(2))).toBe(first);
    expect(mocks.fetches).toHaveLength(1);
  });

  it("clears partial downloads an earlier launch left behind, keeping finished icons", async () => {
    await launch();
    mocks.directories.add("file:///cache/app-chip-icons");
    mocks.files.add("file:///cache/app-chip-icons/other.png");
    mocks.files.add("file:///cache/app-chip-icons/other.7.tmp");
    const cache = await launch({ wipe: false });
    await cache.cachedAppChipIcon(finder, signed(1));
    expect(tempFiles()).toEqual([]);
    expect(mocks.files.has("file:///cache/app-chip-icons/other.png")).toBe(true);
  });
});

/**
 * Page scripts the renderer origin migration runs with `executeJavaScript`: an exporter installed
 * on the legacy renderer origin and an importer installed on the current one. Main then relays
 * one bounded chunk at a time between them, so it never holds a whole origin (a large profile
 * holds 100+ MB of IndexedDB blobs, and building that as one string aborts main with a V8 OOM).
 * They are plain source strings so the bundler cannot rewrite them; `STORAGE_VALUE_CODEC` is
 * exported for tests.
 *
 * IndexedDB values are structured-clone data, and the relay DPoP key is a `CryptoKey`, so values
 * travel as tagged JSON: CryptoKeys as JWK (they are extractable), binary data as base64.
 */

export interface OriginChunkLimits {
  /** Estimated stored bytes per chunk; a single larger value is skipped. */
  readonly bytes: number;
  readonly records: number;
}

export const ORIGIN_CHUNK_LIMITS: OriginChunkLimits = { bytes: 8 * 1024 * 1024, records: 1000 };

export const STORAGE_VALUE_CODEC = String.raw`
const TAG = "$goat";
const VIEWS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}
function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
/** Synchronous upper-bound guess of a value's encoded size, without reading blob contents. */
function estimateSize(value) {
  if (value === null || value === undefined || typeof value === "boolean") return 8;
  if (typeof value === "number" || typeof value === "bigint") return 24;
  if (typeof value === "string") return value.length * 2;
  if (value instanceof Date || value instanceof RegExp) return 64;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return 1024;
  let total = 16;
  if (value instanceof Map) {
    for (const [key, item] of value) total += estimateSize(key) + estimateSize(item);
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) total += estimateSize(item);
  } else {
    for (const [key, item] of Object.entries(value)) total += key.length * 2 + estimateSize(item);
  }
  return total;
}
async function encodeEntries(object) {
  const entries = await Promise.all(
    Object.entries(object).map(async ([key, item]) => [key, await encode(item)]),
  );
  return Object.fromEntries(entries);
}
async function encode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { [TAG]: "number", v: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (value === undefined) return { [TAG]: "undefined" };
  if (typeof value === "bigint") return { [TAG]: "bigint", v: String(value) };
  if (Array.isArray(value)) return Promise.all(Array.from(value, encode));
  if (value instanceof Date) return { [TAG]: "date", v: value.getTime() };
  if (value instanceof ArrayBuffer) return { [TAG]: "bytes", v: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: "view", type: value.constructor.name, v: toBase64(bytes) };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    return { [TAG]: "blob", type: value.type, v: toBase64(bytes) };
  }
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) {
    return {
      [TAG]: "cryptokey",
      jwk: await crypto.subtle.exportKey("jwk", value),
      algorithm: await encode(value.algorithm),
      extractable: value.extractable,
      usages: value.usages,
    };
  }
  if (value instanceof Map) {
    const entries = await Promise.all(
      Array.from(value, ([key, item]) => Promise.all([encode(key), encode(item)])),
    );
    return { [TAG]: "map", v: entries };
  }
  if (value instanceof Set) return { [TAG]: "set", v: await Promise.all(Array.from(value, encode)) };
  if (value instanceof RegExp) return { [TAG]: "regexp", source: value.source, flags: value.flags };
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const object = await encodeEntries(value);
    return TAG in value ? { [TAG]: "object", v: object } : object;
  }
  throw new TypeError("Unsupported stored value " + Object.prototype.toString.call(value));
}
async function decodeEntries(object) {
  const entries = await Promise.all(
    Object.entries(object).map(async ([key, item]) => [key, await decode(item)]),
  );
  return Object.fromEntries(entries);
}
async function decode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (!(TAG in value)) return decodeEntries(value);
  switch (value[TAG]) {
    case "object": return decodeEntries(value.v);
    case "number": return Number(value.v);
    case "undefined": return undefined;
    case "bigint": return BigInt(value.v);
    case "date": return new Date(value.v);
    case "bytes": return fromBase64(value.v).buffer;
    case "view": {
      const View = VIEWS[value.type];
      if (View === undefined) break;
      return new View(fromBase64(value.v).buffer);
    }
    case "blob": return new Blob([fromBase64(value.v)], { type: value.type });
    case "cryptokey":
      return crypto.subtle.importKey(
        "jwk", value.jwk, await decode(value.algorithm), value.extractable, value.usages,
      );
    case "map":
      return new Map(await Promise.all(value.v.map((pair) => Promise.all(pair.map(decode)))));
    case "set": return new Set(await Promise.all(value.v.map(decode)));
    case "regexp": return new RegExp(value.source, value.flags);
  }
  throw new TypeError("Unknown stored value tag " + value[TAG]);
}
function request(pending) {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}
function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted."));
  });
}
/** Opens an existing database, or resolves null without creating one. */
function openExisting(name) {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(name);
    let absent = false;
    pending.onupgradeneeded = () => {
      absent = true;
      pending.transaction.abort();
    };
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => (absent ? resolve(null) : reject(pending.error));
    pending.onblocked = () => reject(new Error("Storage is blocked."));
  });
}
function openVersion(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(name, version);
    pending.onupgradeneeded = () => upgrade(pending.result);
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
    pending.onblocked = () => reject(new Error("Storage upgrade is blocked."));
  });
}
`;

/**
 * Installs `globalThis.__goatOriginExport` and resolves to the size of this origin's storage.
 * Each call of the installed function resolves to the next chunk, `{ done: false, database,
 * store, records, bytes, chunk }`, and finally to `{ done: true, skipped, oversized }`. `chunk` is
 * the chunk's JSON already quoted as a JS string literal, so main can splice it into the import
 * script without making another copy of its own.
 */
export function originStorageExporterScript(limits: OriginChunkLimits = ORIGIN_CHUNK_LIMITS) {
  return `(async (limits) => {
${STORAGE_VALUE_CODEC}
let skipped = 0;
let oversized = 0;
function describeStores(database) {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) return [];
  const transaction = database.transaction(names, "readonly");
  return names.map((name) => {
    const store = transaction.objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames, (indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }),
    };
  });
}
/**
 * Reads the records after \`after\` until the chunk budget is spent. Values are only collected
 * here: a transaction commits as soon as it waits on anything but its own requests, so encoding
 * (which reads blobs) happens after it ends, and the next page resumes from the last key.
 */
function readPage(database, storeName, after) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], "readonly");
    const range = after === undefined ? null : IDBKeyRange.lowerBound(after.key, true);
    const pending = transaction.objectStore(storeName).openCursor(range);
    const page = { records: [], bytes: 0, last: after, more: false };
    pending.onsuccess = () => {
      const cursor = pending.result;
      if (cursor === null) return;
      let size;
      try {
        size = estimateSize(cursor.value);
      } catch {
        size = Infinity;
      }
      if (size > limits.bytes) {
        oversized++;
        page.last = { key: cursor.primaryKey };
        cursor.continue();
        return;
      }
      if (page.records.length > 0 && (page.records.length >= limits.records || page.bytes + size > limits.bytes)) {
        page.more = true;
        return;
      }
      page.records.push([cursor.primaryKey, cursor.value]);
      page.bytes += size;
      page.last = { key: cursor.primaryKey };
      cursor.continue();
    };
    pending.onerror = () => reject(pending.error);
    transaction.oncomplete = () => resolve(page);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted."));
  });
}
const quote = (data) => JSON.stringify(JSON.stringify(data));
async function* chunks() {
  const items = {};
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    items[key] = localStorage.getItem(key);
    bytes += (key.length + items[key].length) * 2;
  }
  yield { database: null, store: null, records: Object.keys(items).length, bytes, chunk: quote({ localStorage: items }) };
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const database = await openExisting(info.name);
    if (database === null) continue;
    try {
      const schema = { name: info.name, version: database.version, stores: describeStores(database) };
      if (schema.stores.length === 0) {
        yield { database: info.name, store: null, records: 0, bytes: 0, chunk: quote({ database: schema, store: null, records: [] }) };
        continue;
      }
      for (const store of schema.stores) {
        let after;
        let first = true;
        for (;;) {
          const page = await readPage(database, store.name, after);
          const records = [];
          for (const [key, value] of page.records) {
            try {
              records.push([await encode(key), await encode(value)]);
            } catch {
              skipped++;
            }
          }
          page.records.length = 0;
          if (first || records.length > 0) {
            const chunk = quote({ database: schema, store: store.name, records });
            yield { database: info.name, store: store.name, records: records.length, bytes: page.bytes, chunk };
          }
          first = false;
          if (!page.more) break;
          after = page.last;
        }
      }
    } finally {
      database.close();
    }
  }
}
const iterator = chunks();
globalThis.__goatOriginExport = async () => {
  const step = await iterator.next();
  return step.done ? { done: true, skipped, oversized } : { done: false, ...step.value };
};
let usageBytes = null;
try {
  const estimate = await navigator.storage.estimate();
  usageBytes = typeof estimate.usage === "number" ? estimate.usage : null;
} catch {}
let databases = 0;
let stores = 0;
let records = 0;
for (const info of await indexedDB.databases()) {
  if (!info.name) continue;
  const database = await openExisting(info.name);
  if (database === null) continue;
  try {
    databases++;
    const names = Array.from(database.objectStoreNames);
    stores += names.length;
    if (names.length === 0) continue;
    const transaction = database.transaction(names, "readonly");
    const counts = names.map((name) => request(transaction.objectStore(name).count()));
    for (const count of counts) records += await count;
  } finally {
    database.close();
  }
}
return { usageBytes, localStorageItems: localStorage.length, databases, stores, records };
})(${JSON.stringify(limits)})`;
}

export const ORIGIN_STORAGE_EXPORT_NEXT_SCRIPT = "globalThis.__goatOriginExport()";

/**
 * Installs `globalThis.__goatOriginImport`, which imports one exporter chunk without replacing
 * anything this origin already holds: a localStorage key or IndexedDB record that exists here
 * keeps its value. It resolves to `{ localStorageItems, records, skipped }` for that chunk.
 */
export const ORIGIN_STORAGE_IMPORTER_SCRIPT = `(() => {
${STORAGE_VALUE_CODEC}
const createStores = (target, stores) => {
  for (const source of stores) {
    if (target.objectStoreNames.contains(source.name)) continue;
    const store = target.createObjectStore(source.name, { keyPath: source.keyPath, autoIncrement: source.autoIncrement });
    for (const index of source.indexes) {
      store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
    }
  }
};
async function openTarget(source) {
  const database = await openExisting(source.name);
  if (database === null) {
    return openVersion(source.name, Math.max(1, source.version), (target) => createStores(target, source.stores));
  }
  const missing = source.stores.filter((store) => !database.objectStoreNames.contains(store.name));
  if (missing.length === 0) return database;
  const version = database.version + 1;
  database.close();
  return openVersion(source.name, version, (target) => createStores(target, missing));
}
globalThis.__goatOriginImport = async (data) => {
  if (data.localStorage !== undefined) {
    let localStorageItems = 0;
    for (const [key, value] of Object.entries(data.localStorage)) {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
        localStorageItems++;
      }
    }
    return { localStorageItems, records: 0, skipped: 0 };
  }
  // Decode first: a transaction commits as soon as it waits on anything but its own requests.
  const decoded = [];
  let skipped = 0;
  for (const [key, value] of data.records) {
    try {
      decoded.push([await decode(key), await decode(value)]);
    } catch {
      skipped++;
    }
  }
  data.records.length = 0;
  const database = await openTarget(data.database);
  let records = 0;
  try {
    if (data.store !== null && decoded.length > 0) {
      const transaction = database.transaction([data.store], "readwrite");
      const done = finished(transaction);
      const target = transaction.objectStore(data.store);
      for (const [key, value] of decoded) {
        const added = target.keyPath === null ? target.add(value, key) : target.add(value);
        added.onsuccess = () => records++;
        // An existing record wins; keep the transaction alive.
        added.onerror = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };
      }
      await done;
    }
  } finally {
    database.close();
  }
  return { localStorageItems: 0, records, skipped };
};
return true;
})()`;

/** Imports one quoted exporter chunk on a page where `ORIGIN_STORAGE_IMPORTER_SCRIPT` ran. */
export function originStorageImportChunkScript(chunk: string): string {
  // Parsed rather than inlined as an object literal: there a "__proto__" key sets the prototype.
  return `globalThis.__goatOriginImport(JSON.parse(${chunk}))`;
}

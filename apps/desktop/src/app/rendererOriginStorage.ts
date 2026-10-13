/**
 * Page scripts the renderer origin migration runs with `executeJavaScript`, first on the legacy
 * renderer origin to export its storage, then on the current one to import it. They are plain
 * source strings so the bundler cannot rewrite them; `STORAGE_VALUE_CODEC` is exported for tests.
 *
 * IndexedDB values are structured-clone data, and the relay DPoP key is a `CryptoKey`, so values
 * travel as tagged JSON: CryptoKeys as JWK (they are extractable), binary data as base64.
 */

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

/** Resolves to a JSON string: this origin's localStorage items and every IndexedDB database. */
export const ORIGIN_STORAGE_EXPORT_SCRIPT = `(async () => {
${STORAGE_VALUE_CODEC}
const items = {};
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i);
  if (key !== null) items[key] = localStorage.getItem(key);
}
const databases = [];
let skipped = 0;
for (const info of await indexedDB.databases()) {
  if (!info.name) continue;
  const database = await openExisting(info.name);
  if (database === null) continue;
  try {
    const names = Array.from(database.objectStoreNames);
    const pending = [];
    if (names.length > 0) {
      const transaction = database.transaction(names, "readonly");
      for (const name of names) {
        const store = transaction.objectStore(name);
        pending.push({
          name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames, (indexName) => {
            const index = store.index(indexName);
            return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          }),
          keys: request(store.getAllKeys()),
          values: request(store.getAll()),
        });
      }
    }
    const stores = [];
    for (const store of pending) {
      const keys = await store.keys;
      const values = await store.values;
      const records = [];
      for (let i = 0; i < keys.length; i++) {
        try {
          records.push([await encode(keys[i]), await encode(values[i])]);
        } catch {
          skipped++;
        }
      }
      stores.push({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes, records });
    }
    databases.push({ name: info.name, version: database.version, stores });
  } finally {
    database.close();
  }
}
return JSON.stringify({ localStorage: items, databases, skipped });
})()`;

/**
 * Imports an export into this origin without replacing anything it already holds: a localStorage
 * key or IndexedDB record that exists here keeps its value. Resolves to a JSON summary.
 */
export function originStorageImportScript(payload: string): string {
  return `(async (payload) => {
${STORAGE_VALUE_CODEC}
const data = JSON.parse(payload);
let localStorageItems = 0;
for (const [key, value] of Object.entries(data.localStorage)) {
  if (localStorage.getItem(key) === null) {
    localStorage.setItem(key, value);
    localStorageItems++;
  }
}
const createStores = (target, stores) => {
  for (const source of stores) {
    if (target.objectStoreNames.contains(source.name)) continue;
    const store = target.createObjectStore(source.name, { keyPath: source.keyPath, autoIncrement: source.autoIncrement });
    for (const index of source.indexes) {
      store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
    }
  }
};
let records = 0;
let skipped = data.skipped;
for (const source of data.databases) {
  // Decode first: a transaction commits as soon as it waits on anything but its own requests.
  const stores = [];
  for (const store of source.stores) {
    const decoded = [];
    for (const [key, value] of store.records) {
      try {
        decoded.push([await decode(key), await decode(value)]);
      } catch {
        skipped++;
      }
    }
    stores.push({ name: store.name, records: decoded });
  }
  let database = await openExisting(source.name);
  if (database === null) {
    database = await openVersion(source.name, Math.max(1, source.version), (target) => createStores(target, source.stores));
  } else {
    const missing = source.stores.filter((store) => !database.objectStoreNames.contains(store.name));
    if (missing.length > 0) {
      const version = database.version + 1;
      database.close();
      database = await openVersion(source.name, version, (target) => createStores(target, missing));
    }
  }
  try {
    if (stores.length === 0) continue;
    const transaction = database.transaction(stores.map((store) => store.name), "readwrite");
    const done = finished(transaction);
    for (const store of stores) {
      const target = transaction.objectStore(store.name);
      for (const [key, value] of store.records) {
        const added = target.keyPath === null ? target.add(value, key) : target.add(value);
        added.onsuccess = () => records++;
        // An existing record wins; keep the transaction alive.
        added.onerror = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };
      }
    }
    await done;
  } finally {
    database.close();
  }
}
return JSON.stringify({ localStorageItems, databases: data.databases.length, records, skipped });
})(${JSON.stringify(payload)})`;
}

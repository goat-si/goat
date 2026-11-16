import * as NodeUtil from "node:util";

// SQLite retains text/blob bindings until rebind or finalization; node:sqlite cannot clear them.
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

// Node 24.20's `node:sqlite` (SQLite 3.53.4) binds a raw ArrayBuffer parameter as
// NULL. A Uint8Array of the same bytes binds on that build and on later ones.
const sqliteBlob = (value: ArrayBufferLike): Uint8Array | ArrayBufferLike => {
  try {
    return new Uint8Array(value);
  } catch {
    return value;
  }
};

const sqliteParameter = (value: unknown): unknown => {
  if (NodeUtil.types.isAnyArrayBuffer(value)) return sqliteBlob(value);
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable &&
      "value" in descriptor &&
      NodeUtil.types.isAnyArrayBuffer(descriptor.value)
    ) {
      changed = true;
      break;
    }
  }
  if (!changed) return value;
  const copy = typeof value === "function" ? function namedBinding() {} : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if ("value" in descriptor && NodeUtil.types.isAnyArrayBuffer(descriptor.value)) {
      Object.defineProperty(copy, key, { ...descriptor, value: sqliteBlob(descriptor.value) });
    } else {
      Object.defineProperty(copy, key, descriptor);
    }
  }
  return copy;
};

export const sqliteParameters = (params: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  let changed = false;
  const next = params.map((param) => {
    const normalized = sqliteParameter(param);
    if (normalized !== param) changed = true;
    return normalized;
  });
  return changed ? next : params;
};

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

export const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // Named parameters may be callable objects; read data properties only to avoid invoking getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

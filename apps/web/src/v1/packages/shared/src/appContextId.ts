import type { ComposerContextId, CapabilityContextApp } from "@goat/contracts";

const APP_CONTEXT_PREFIX = "app_";
/**
 * Longest app id, in UTF-8 bytes, a chip carries; context ids hold at most 128 characters. One
 * byte short of the full width, because older builds cut longer ids to exactly that width.
 */
export const APP_CONTEXT_ID_MAX_BYTES = (128 - APP_CONTEXT_PREFIX.length) / 2 - 1;

/** Whether an app id fits in a chip's context id, so the app can be mentioned. */
export function appIdFitsContextId(id: string): boolean {
  return new TextEncoder().encode(id).length <= APP_CONTEXT_ID_MAX_BYTES;
}

/** The chip id that carries an app id; throws for one that does not fit, since cutting it would name a different app. */
export function appContextId(id: string): ComposerContextId {
  const bytes = new TextEncoder().encode(id);
  if (bytes.length > APP_CONTEXT_ID_MAX_BYTES)
    throw new Error(`App id is longer than ${APP_CONTEXT_ID_MAX_BYTES} bytes.`);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${APP_CONTEXT_PREFIX}${hex}` as ComposerContextId;
}

/** The app id an app chip's context id carries, or undefined for any other id. */
export function appIdForContextId(contextId: string): string | undefined {
  if (!contextId.startsWith(APP_CONTEXT_PREFIX)) return undefined;
  const hex = contextId.slice(APP_CONTEXT_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || hex.length > APP_CONTEXT_ID_MAX_BYTES * 2)
    return undefined;
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A capability record's app, only when its chip id carries exactly that id. A record saved by an
 * older build can hold another app's id under a cut chip id.
 */
export function capabilityRecordApp(record: {
  readonly contextId: string;
  readonly app?: CapabilityContextApp | undefined;
}): CapabilityContextApp | undefined {
  return record.app !== undefined && appIdForContextId(record.contextId) === record.app.id
    ? record.app
    : undefined;
}

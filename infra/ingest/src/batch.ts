// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
import {
  ANALYTICS_COMMON_PROPERTIES,
  ANALYTICS_EVENT_PROPERTIES,
} from "@goat/shared/analyticsAllowlist";

export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_EVENTS = 100;
const MAX_STRING_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every GOAT build sends hashTelemetryId output (packages/shared/src/telemetryId.ts).
const TELEMETRY_HASH = /^[0-9a-f]{64}$/;

type PropertyValue = string | number | boolean;
type Properties = Record<string, PropertyValue>;

export interface StoredEvent {
  readonly uuid: string;
  readonly event: string;
  readonly distinct_id?: string;
  readonly timestamp?: string;
  readonly properties?: Properties;
}

/**
 * One stored row. The server repeats its own properties and the install's id on every
 * event of a batch, so values shared by every event are kept once in `distinct_id` and
 * `common`; an event's own `properties` win over `common` when read back.
 */
export interface StoredBatch {
  readonly distinct_id?: string;
  readonly common?: Properties;
  readonly events: ReadonlyArray<StoredEvent>;
}

export type ParsedBatch =
  | { readonly ok: true; readonly batch: StoredBatch; readonly eventCount: number }
  | { readonly ok: false; readonly status: 400 | 401 | 413 };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function propertyValue(value: unknown): PropertyValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH ? value : undefined;
  return undefined;
}

/**
 * Reads only the allowlisted keys, one level deep. Anything else, including nested
 * objects under an allowed key, is never read or serialized.
 */
function allowedProperties(event: string, input: unknown): Properties {
  const kept: Properties = {};
  if (!isRecord(input)) return kept;
  for (const key of [
    ...ANALYTICS_COMMON_PROPERTIES,
    ...(ANALYTICS_EVENT_PROPERTIES[event] ?? []),
  ]) {
    if (!Object.hasOwn(input, key)) continue;
    const value = propertyValue(input[key]);
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

function timestampOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

interface ReadEvent {
  readonly uuid: string;
  readonly event: string;
  readonly distinctId: string;
  readonly timestamp: string | undefined;
  readonly properties: Properties;
}

/** `undefined` drops an event the ingest does not store; `null` rejects the batch. */
function readEvent(input: unknown): ReadEvent | null | undefined {
  if (!isRecord(input)) return null;
  const { uuid, event, distinct_id: distinctId } = input;
  if (typeof uuid !== "string" || !UUID.test(uuid)) return null;
  if (typeof event !== "string" || event.length === 0 || event.length > MAX_STRING_LENGTH) {
    return null;
  }
  if (typeof distinctId !== "string" || !TELEMETRY_HASH.test(distinctId)) return null;
  if (!Object.hasOwn(ANALYTICS_EVENT_PROPERTIES, event)) return undefined;
  return {
    uuid: uuid.toLowerCase(),
    event,
    distinctId,
    timestamp: timestampOf(input.timestamp),
    properties: allowedProperties(event, input.properties),
  };
}

function sharedProperties(events: ReadonlyArray<ReadEvent>): Properties {
  const [first, ...rest] = events;
  if (first === undefined || rest.length === 0) return {};
  const shared: Properties = {};
  for (const [key, value] of Object.entries(first.properties)) {
    if (rest.every((event) => event.properties[key] === value)) shared[key] = value;
  }
  return shared;
}

function storedBatch(events: ReadonlyArray<ReadEvent>): StoredBatch {
  const distinctIds = new Set(events.map((event) => event.distinctId));
  const sharedDistinctId = distinctIds.size === 1 ? events[0]?.distinctId : undefined;
  const common = sharedProperties(events);
  const stored = events.map((event): StoredEvent => {
    const own = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) => !Object.hasOwn(common, key)),
    );
    return {
      uuid: event.uuid,
      event: event.event,
      ...(sharedDistinctId === undefined ? { distinct_id: event.distinctId } : {}),
      ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
      ...(Object.keys(own).length === 0 ? {} : { properties: own }),
    };
  });
  return {
    ...(sharedDistinctId === undefined ? {} : { distinct_id: sharedDistinctId }),
    ...(Object.keys(common).length === 0 ? {} : { common }),
    events: stored,
  };
}

/**
 * Validates a PostHog `/batch/` body. Status codes follow the GOAT server's delivery
 * contract (apps/server/src/telemetry/AnalyticsService.ts): 400, 401 and 413 drop the
 * batch for good, so they are only for a batch that can never be accepted.
 */
export function parseBatch(body: unknown, acceptedKeys: ReadonlySet<string>): ParsedBatch {
  if (!isRecord(body)) return { ok: false, status: 400 };
  if (typeof body.api_key !== "string" || !acceptedKeys.has(body.api_key)) {
    return { ok: false, status: 401 };
  }
  const { batch } = body;
  if (!Array.isArray(batch) || batch.length === 0) return { ok: false, status: 400 };
  if (batch.length > MAX_EVENTS) return { ok: false, status: 413 };
  const events: Array<ReadEvent> = [];
  for (const input of batch) {
    const event = readEvent(input);
    if (event === null) return { ok: false, status: 400 };
    if (event !== undefined) events.push(event);
  }
  if (events.length === 0) return { ok: false, status: 400 };
  return { ok: true, batch: storedBatch(events), eventCount: events.length };
}

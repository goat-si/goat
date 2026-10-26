import {
  ANALYTICS_COMMON_PROPERTIES,
  ANALYTICS_EVENT_PROPERTIES,
} from "@goat/shared/analyticsAllowlist";

export interface Recorded {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The events and `event.property` keys GOAT's ingest would drop, judged by the reviewed
 * allowlist it stores against. A producer test asserts this is empty so a new event or
 * property cannot be lost silently.
 */
export function ingestDrops(recorded: ReadonlyArray<Recorded>): ReadonlyArray<string> {
  return recorded.flatMap(({ event, properties }) => {
    if (!Object.hasOwn(ANALYTICS_EVENT_PROPERTIES, event)) return [event];
    const allowed = new Set([
      ...ANALYTICS_COMMON_PROPERTIES,
      ...(ANALYTICS_EVENT_PROPERTIES[event] ?? []),
    ]);
    return Object.keys(properties ?? {})
      .filter((key) => !allowed.has(key))
      .map((key) => `${event}.${key}`);
  });
}

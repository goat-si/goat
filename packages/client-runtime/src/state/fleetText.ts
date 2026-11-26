/** Fleet data is shared with clients that render its English source directly. */
export type FleetText = (source: string, values?: Record<string, string | number>) => string;

export const englishFleetText: FleetText = (source, values) =>
  values === undefined
    ? source
    : source.replace(/\{(\w+)\}/g, (token, key: string) => String(values[key] ?? token));

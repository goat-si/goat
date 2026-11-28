import type { ProviderInstanceEnvironmentVariable, SecretReference } from "@goat/contracts";

export type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
  readonly secret?: SecretReference;
};

const DRAFT_ROW_ID_PREFIX = "provider-env-";
let environmentVariableDraftId = 0;

export const nextEnvironmentVariableDraftId = () =>
  `${DRAFT_ROW_ID_PREFIX}${environmentVariableDraftId++}`;

export function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
    ...(variable.secret !== undefined ? { secret: variable.secret } : {}),
  };
}

/**
 * Keeps rows typed since the last delivery. Names repeat, so typed rows match by count,
 * oldest first: one is accounted for when the previous delivery held it (an echoed publish
 * leaves typed rows in place) or this delivery gained another variable of its name.
 */
export function reseedEnvironmentRows(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): (currentRows: ReadonlyArray<EnvironmentDraftRow>) => ReadonlyArray<EnvironmentDraftRow> {
  return (currentRows) => {
    const reseeded = environment.map(makeEnvironmentDraftRow);
    const count = (names: ReadonlyArray<string>) => {
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      return counts;
    };
    const incoming = count(environment.map((variable) => variable.name));
    const previous = count(previousEnvironment.map((variable) => variable.name));
    const delivered = count(
      currentRows.filter((row) => !row.id.startsWith(DRAFT_ROW_ID_PREFIX)).map((row) => row.name),
    );
    const accountedFor = new Map<string, number>();
    for (const name of new Set([...incoming.keys(), ...previous.keys()])) {
      const previousCount = previous.get(name) ?? 0;
      const acknowledged = Math.max(0, previousCount - (delivered.get(name) ?? 0));
      const added = Math.max(0, (incoming.get(name) ?? 0) - previousCount);
      accountedFor.set(name, acknowledged + added);
    }
    const unpublished = currentRows.filter((row) => {
      if (!row.id.startsWith(DRAFT_ROW_ID_PREFIX)) return false;
      const remaining = accountedFor.get(row.name) ?? 0;
      if (remaining <= 0) return true;
      accountedFor.set(row.name, remaining - 1);
      return false;
    });
    return unpublished.length > 0 ? [...reseeded, ...unpublished] : reseeded;
  };
}

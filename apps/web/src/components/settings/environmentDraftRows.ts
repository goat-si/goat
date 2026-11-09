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
 * Rows typed since the last delivery are not in the incoming environment, so a
 * reseed keeps them instead of dropping the user's unpublished input.
 */
export function reseedEnvironmentRows(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): (currentRows: ReadonlyArray<EnvironmentDraftRow>) => ReadonlyArray<EnvironmentDraftRow> {
  return (currentRows) => {
    const reseeded = environment.map(makeEnvironmentDraftRow);
    const acknowledged = new Set(previousEnvironment.map((variable) => variable.name));
    const unpublished = currentRows.filter(
      (row) =>
        row.id.startsWith(DRAFT_ROW_ID_PREFIX) &&
        !acknowledged.has(row.name) &&
        !reseeded.some((incoming) => incoming.name === row.name),
    );
    return unpublished.length > 0 ? [...reseeded, ...unpublished] : reseeded;
  };
}

import type { PullRequestLabel } from "@goat/contracts";

export interface LabelFields {
  readonly name: string;
  readonly color?: string | null | undefined;
  readonly description?: string | null | undefined;
}

export function toLabels(
  raw: ReadonlyArray<LabelFields> | undefined,
): ReadonlyArray<PullRequestLabel> {
  const trimmed = (value: string | null | undefined) => value?.trim() || null;
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null
      ? []
      : [{ name, color: trimmed(label.color), description: trimmed(label.description) }];
  });
}

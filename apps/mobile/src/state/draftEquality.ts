import type { ComposerDraft } from "./use-composer-drafts";

export function sameDrafts(
  a: Readonly<Record<string, ComposerDraft>>,
  b: Readonly<Record<string, ComposerDraft>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

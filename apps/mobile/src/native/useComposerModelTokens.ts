import { useState } from "react";
import { collectComposerModelTokens } from "../lib/composerModelTokens";

export function useComposerModelTokens(value: string) {
  const [confirmed, setConfirmed] = useState(() => ({
    value,
    tokens: collectComposerModelTokens(value),
  }));
  if (confirmed.value === value) return confirmed.tokens;
  const tokens = collectComposerModelTokens(value, confirmed.tokens);
  setConfirmed({ value, tokens });
  return tokens;
}

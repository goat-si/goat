import { useState } from "react";

export function useWordWrap(defaultWrapped: boolean) {
  const [override, setOverride] = useState<boolean | null>(null);
  return [override ?? defaultWrapped, setOverride] as const;
}

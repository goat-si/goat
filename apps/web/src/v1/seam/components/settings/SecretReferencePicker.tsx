// Seam for v1 apps/web/src/components/settings/SecretReferencePicker.tsx (goat 916b5ccc1b2): v1 secret references are
// behind GOAT_FEATURE_SECRETS (off), and GOAT 2 has no secret store, so the picker is not shown. Props are v1's (:25-35).
import type { EnvironmentId, SecretReference } from "@goat/contracts";

export function SecretReferencePicker(_props: {
  readonly environmentId: EnvironmentId;
  readonly value: SecretReference | undefined;
  readonly onChange: (value: SecretReference | undefined) => void;
  readonly disabled?: boolean;
}): null {
  return null;
}

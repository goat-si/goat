import {
  SecretProviderId,
  SecretReference,
  isOnePasswordReference,
  type EnvironmentId,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { isSecretsFeatureEnabled } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { classifySecretProvider } from "./SecretProviderDialog.logic";

const isReference = Schema.is(SecretReference);
const stored = "__stored__";

export function SecretReferencePicker({
  environmentId,
  value,
  onChange,
  disabled = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: SecretReference | undefined;
  readonly onChange: (value: SecretReference | undefined) => void;
  readonly disabled?: boolean;
}) {
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [pending, setPending] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const choices = Object.entries(providers).filter(
    ([, provider]) => classifySecretProvider(provider).kind === "one_password",
  );
  if (
    !isSecretsFeatureEnabled ||
    config?.secretReferences !== true ||
    (choices.length === 0 && !value)
  )
    return null;
  const selected = pending ?? value?.provider ?? stored;
  const label =
    selected === stored
      ? "Stored value"
      : (providers[selected as SecretProviderId]?.label ?? selected);
  const missingProvider = value !== undefined && providers[value.provider] === undefined;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select
        disabled={disabled}
        value={selected}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          setPending(next);
          setInvalid(false);
          if (next === stored) {
            setPending(null);
            onChange(undefined);
          }
        }}
      >
        <SelectTrigger size="sm" aria-label="Secret source">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          <SelectItem value={stored}>Stored value</SelectItem>
          {choices.map(([id, provider]) => (
            <SelectItem key={id} value={id}>
              {provider.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {selected !== stored ? (
        <DraftInput
          size="sm"
          font="mono"
          aria-label="Secret reference"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          placeholder="op://vault/item/field"
          value={value?.provider === selected ? value.reference : ""}
          onCommit={(reference) => {
            const candidate = { provider: selected, reference: reference.trim() };
            if (isReference(candidate) && isOnePasswordReference(candidate.reference)) {
              setInvalid(false);
              onChange(candidate);
              setPending(null);
            } else setInvalid(true);
          }}
        />
      ) : null}
      {invalid ? <span role="alert">Use a reference like op://vault/item/field.</span> : null}
      {missingProvider ? (
        <span role="alert">
          Secret provider ID {value.provider} was removed. Add a provider with this ID, or choose
          another source.
        </span>
      ) : null}
    </div>
  );
}

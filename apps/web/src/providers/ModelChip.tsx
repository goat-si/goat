// The composer model chip (boards 1QM8-2 / 1QYE-2): v1's ProviderModelPicker over the host's providers inside a
// display:contents [data-v1] boundary. The choice applies from the thread's next turn through change_thread
// (docs/part2/provider-wire.md); a composer without a thread yet (a new thread) keeps the choice for start_thread.
import { useState } from "react";
import { ModelPicker, V1Boundary } from "@v1/surfaces";
import { useClient } from "../host/HostProvider.tsx";

export interface Selection { instanceId: string; model: string }

/** What a thread without a card runs until the person picks (the GOAT 2 default since Part 1). */
export const DEFAULT_SELECTION: Selection = { instanceId: "codex", model: "gpt-6.1-sol" };

/** change_thread on a thread, or null when there is no thread to change. */
export function useThreadModelChange(threadId: string | null) {
  const client = useClient();
  const [error, setError] = useState<string | null>(null);
  const change = threadId === null ? null : (selection: Selection) => {
    setError(null);
    void client.command({ type: "change_thread", threadId, modelSelection: { instanceId: selection.instanceId, model: selection.model } }).then((r) => {
      if (!r.ok) setError(r.error?.message ?? "Could not change the model.");
    });
  };
  return { change, error };
}

export function ModelChip({ selection, onChange, label, disabled, error }: {
  selection: Selection;
  onChange: ((selection: Selection) => void) | null;
  /** Whose model it is, for the trigger's accessible name ("Reviewer", "Thread"). */
  label: string;
  disabled?: boolean;
  error?: string | null;
}) {
  return (
    <V1Boundary style={{ display: "contents" }} title={error ?? undefined}>
      <ModelPicker composer instanceId={selection.instanceId} model={selection.model} popupAlign="end"
        ariaLabel={`${label} model: ${selection.model}`} disabled={disabled === true || onChange === null} onChange={(s) => onChange?.(s)} />
    </V1Boundary>
  );
}

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ProviderHostMatrixResult } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomCommand } from "~/state/use-atom-command";
import { readProviderHostMatrix } from "./ProviderHostMatrix.commands";

export function providerHostCommandError(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The request failed. Try again.";
}

export function useProviderHostMatrix(environmentId: EnvironmentId) {
  const read = useAtomCommand(readProviderHostMatrix, { reportFailure: false });
  const [data, setData] = useState<ProviderHostMatrixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const generation = useRef(0);
  const refresh = useStableCallback(async (targetEnvironment: EnvironmentId) => {
    const request = ++generation.current;
    setPending(true);
    const result = await read({ environmentId: targetEnvironment, input: {} });
    if (request !== generation.current) return;
    setPending(false);
    setError(providerHostCommandError(result));
    if (result._tag === "Success") setData(result.value);
  });
  useEffect(() => {
    void refresh(environmentId);
    return () => {
      generation.current++;
    };
  }, [environmentId, refresh]);
  return { data, error, pending, refresh: () => refresh(environmentId) };
}

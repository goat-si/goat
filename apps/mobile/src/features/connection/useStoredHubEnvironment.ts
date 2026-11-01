import type { EnvironmentId } from "@goat/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { createRuntimeCommand } from "@goat/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { loadHubEnvironmentId, rememberHubEnvironment } from "./hubEnvironment";

const loadHub = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:hub:load",
  execute: loadHubEnvironmentId,
});
const rememberHub = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:hub:remember",
  execute: rememberHubEnvironment,
});

export function useStoredHubEnvironment() {
  const load = useAtomCommand(loadHub, { reportFailure: false });
  const remember = useAtomCommand(rememberHub, { reportFailure: false });
  const [storedHubId, setStoredHubId] = useState<EnvironmentId | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoaded(false);
      void load(undefined).then((result) => {
        if (!active) return;
        if (AsyncResult.isSuccess(result)) {
          setStoredHubId(result.value);
          setError(null);
          setLoaded(true);
        } else {
          setError("Couldn't load the saved hub. Reopen this screen to try again.");
        }
      });
      return () => {
        active = false;
      };
    }, [load]),
  );

  const rememberEnvironment = useCallback(
    async (input: Parameters<typeof rememberHubEnvironment>[0]) => {
      const result = await remember(input);
      if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
    },
    [remember],
  );

  return { storedHubId, loaded, error, rememberHubEnvironment: rememberEnvironment };
}

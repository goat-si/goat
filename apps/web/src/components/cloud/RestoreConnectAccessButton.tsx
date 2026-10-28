import { useState } from "react";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useConnectReverification } from "~/cloud/useConnectReverification";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { Button } from "../ui/button";

export function RestoreConnectAccessButton() {
  const restoreAccess = useConnectReverification();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await restoreAccess();
            const result = await runAtomCommand(
              appAtomRegistry,
              relayEnvironmentDiscovery.refresh,
              undefined,
              { reportFailure: false },
            );
            if (result._tag !== "Success") {
              const cause = squashAtomCommandFailure(result);
              setError(
                cause instanceof Error ? cause.message : "Could not restore Connect access.",
              );
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not restore Connect access.");
          }
          setPending(false);
        }}
      >
        Restore Connect access
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

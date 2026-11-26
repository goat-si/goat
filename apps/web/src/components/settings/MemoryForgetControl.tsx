import { useGT } from "gt-react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AuthMemoryReadScope, type EnvironmentId, type MemoryItem } from "@goat/contracts";
import { presentMemoryItem } from "@goat/client-runtime/memory-presentation";
import * as Option from "effect/Option";
import { useContext, useEffect, useRef, useState } from "react";
import {
  usePreparedConnection,
  readPreparedConnection,
  readEnvironmentScope,
} from "../../state/session";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { memoryForgetIntent } from "./MemorySettings.logic";

export function MemoryForgetControl({
  label,
  environmentId,
  item,
  onForgotten,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem | null;
  label?: string;
  onForgotten?: ((message: string) => void) | undefined;
}) {
  const gt = useGT();
  const canForget = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId));
  return (
    <MemoryForgetRequest
      key={String(canForget)}
      environmentId={environmentId}
      item={item}
      canForget={canForget}
      label={label ?? gt("Forget memory")}
      onForgotten={onForgotten}
    />
  );
}

function MemoryForgetRequest({
  label,
  environmentId,
  item,
  canForget,
  onForgotten,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem | null;
  canForget: boolean;
  label: string;
  onForgotten?: ((message: string) => void) | undefined;
}) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const [intent, setIntent] = useState<ReturnType<typeof memoryForgetIntent>>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  // oxlint-disable-next-line goat/react-effect-budget -- Fence the in-flight receipt when this destination unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const imported = useRef(false);
  const available = item !== null && presentMemoryItem(item).canForget;
  function liveDestination() {
    return (
      mounted.current &&
      connection !== null &&
      readPreparedConnection(environmentId) === connection &&
      readEnvironmentScope(environmentId, AuthMemoryReadScope) &&
      registry.get(memoryEnvironment.forget.permissionAtom(environmentId))
    );
  }
  async function submit() {
    if (!intent || busy || !liveDestination()) return;
    setBusy(true);
    const result = await forget({ environmentId, input: intent });
    if (!liveDestination()) return;
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.outcome === "rejected") {
        setMessage(gt("Could not forget this memory. Review the record before trying again."));
        setIntent(null);
        return;
      }
      const notice = imported.current
        ? gt(
            "Forgotten. Other devices remove it when they sync. The provider's original conversation stays, but forgotten content is never imported again.",
          )
        : gt("Forgotten. Other devices remove it when they sync.");
      setMessage(notice);
      onForgotten?.(notice);
      setIntent(null);
    } else setMessage(gt("Forget request failed. Try again to continue this request."));
  }
  return (
    <div>
      {message ? <p role="status">{message}</p> : null}
      {available || intent ? (
        intent && canForget ? (
          <div role="group" aria-label={gt("Forget confirmation")}>
            <p>{gt("Forget this memory? This cannot be undone.")}</p>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void submit()}>
              {gt("Confirm forget")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setIntent(null);
                setMessage(null);
              }}
            >
              {gt("Cancel")}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canForget}
            onClick={() => {
              if (item && liveDestination()) {
                imported.current =
                  item.status === "active" &&
                  item.payload.evidence.some((e) => e.origin === "import");
                setIntent(memoryForgetIntent(item));
              }
            }}
          >
            {label}
          </Button>
        )
      ) : null}
    </div>
  );
}

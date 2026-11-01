import { presentMemoryRunAccess } from "@goat/client-runtime/memory-presentation";
import type { MemoryCurrentAccess, MemoryTaskGrantCeiling } from "@goat/contracts";

const accessLabels = { none: "None", read: "Read only", read_write: "Read and write" };
const reasonLabels = {
  policy_unready: "Policy is not ready",
  environment_off: "Agent memory access is off",
  legacy_none: "No saved permission",
  ceiling: "Within the saved limit",
  read_only_destination: "Destination allows reads only",
  dispatch_scope: "Limited by this dispatch",
};

export function MemoryRunAccessLabel(props: {
  memoryGrantCeiling?: MemoryTaskGrantCeiling | undefined;
  currentMemoryAccess?: MemoryCurrentAccess | undefined;
}) {
  const view = presentMemoryRunAccess({
    ...(props.memoryGrantCeiling === undefined
      ? {}
      : { memoryGrantCeiling: props.memoryGrantCeiling }),
    ...(props.currentMemoryAccess === undefined
      ? {}
      : { currentMemoryAccess: props.currentMemoryAccess }),
  });
  return (
    <span className="text-xs text-muted-foreground">
      {view.savedCeilingLabel}
      {view.effectiveAccess !== "unknown" ? (
        <>
          {" "}
          · Allowed now: {accessLabels[view.effectiveAccess]}
          {view.effectiveReason ? ` (${reasonLabels[view.effectiveReason]})` : null}
        </>
      ) : null}
    </span>
  );
}

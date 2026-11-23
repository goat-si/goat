import type { ProviderInstanceId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { InlineButton } from "../ui/button";
import { ComboboxEmpty } from "../ui/combobox";
import { getProviderStatusMessage } from "./ProviderStatusBanner";
export function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  emptyLabel,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  emptyLabel: string;
  updateRequiredNotices: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    notice: string;
    canUpdateInSettings: boolean;
  }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1 ? `Set up ${entry.displayName}` : "Open provider setup"}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">{emptyLabel}</ComboboxEmpty>
      )}
      {updateRequiredNotices.map(({ instanceId, notice, canUpdateInSettings }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}
          {canUpdateInSettings ? (
            <>
              {" "}
              <InlineButton
                onClick={() => {
                  onRequestClose?.();
                  void navigate({ to: "/settings/providers" });
                }}
              >
                Provider settings
              </InlineButton>
            </>
          ) : null}
        </p>
      ))}
    </>
  );
}

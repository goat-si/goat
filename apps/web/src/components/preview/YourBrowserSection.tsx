import { useEffect, useEffectEvent, useRef, useState } from "react";
import { scopedThreadKey } from "@goat/client-runtime/environment";
import { useBrowserClaimRequest } from "./browserClaimRequest";
import { toastManager } from "~/components/ui/toast";
import { BrowserClaimPicker } from "./BrowserClaimPicker";
import { useAtomValue } from "@effect/atom-react";
import type { BrowserClaimWindows, ScopedThreadRef } from "@goat/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export function YourBrowserSection({
  threadRef,
  available = true,
}: {
  threadRef: ScopedThreadRef;
  available?: boolean;
}) {
  const { environmentId, threadId } = threadRef;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listing, setListing] = useState<typeof BrowserClaimWindows.Type | null>(null);
  const [listError, setListError] = useState(false);
  const serial = useRef(0);
  const canList = useAtomValue(previewEnvironment.claimWindows.permissionAtom(environmentId));
  const list = useAtomCommand(previewEnvironment.claimWindows, { reportFailure: false });
  async function openPicker() {
    const current = ++serial.current;
    setListing(null);
    setListError(false);
    setPickerOpen(true);
    const answer = await list({ environmentId, input: {} });
    if (current !== serial.current) return;
    if (answer._tag === "Success") setListing(answer.value);
    else setListError(true);
  }
  function closePicker() {
    ++serial.current;
    setPickerOpen(false);
  }
  const canClaim = useAtomValue(previewEnvironment.claim.permissionAtom(environmentId));
  const result = useEnvironmentQuery(previewEnvironment.claimChanges({ environmentId, input: {} }));
  const pendingRequest = useBrowserClaimRequest((state) => state.pending);
  const handleRequest = useEffectEvent(() => {
    if (!pendingRequest || pendingRequest.threadKey !== scopedThreadKey(threadRef)) return;
    if (available && canClaim && canList && !result.isSuccess && !result.error) return;
    if (!useBrowserClaimRequest.getState().consume(pendingRequest)) return;
    if (!canClaim || !canList) {
      toastManager.add({
        type: "info",
        title: "This client does not have permission to let an agent use a browser tab.",
      });
    } else if (!available || !result.isSuccess || result.data?.supported !== true) {
      toastManager.add({
        type: "info",
        title: "Browser tab claims are unavailable in this environment.",
      });
    } else {
      void openPicker();
    }
  });
  // oxlint-disable-next-line goat/react-effect-budget -- consume a menu request after the panel and capability query are ready
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A queued menu request opens the picker once its panel is ready.
    handleRequest();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry the queued request when permissions or the capability query change.
  }, [pendingRequest, available, canClaim, canList, result.isSuccess, result.error, result.data]);
  const canEnd = useAtomValue(previewEnvironment.claimEnd.permissionAtom(environmentId));
  const canRevoke = useAtomValue(previewEnvironment.claimRevoke.permissionAtom(environmentId));
  const end = useAtomCommand(previewEnvironment.claimEnd, "end browser claim");
  const revoke = useAtomCommand(previewEnvironment.claimRevoke, "revoke browser grant");
  if (!available || !result.isSuccess || !result.data || result.data.supported === false)
    return null;
  const claims = result.data.claims.filter((claim) => claim.threadId === threadId);
  const grants = result.data.grants.filter((grant) => grant.threadId === threadId);
  const pending = result.data.pending.filter((request) => request.threadId === threadId);
  return (
    <section
      aria-label="Your browser"
      className="flex max-h-48 shrink-0 flex-col gap-2 overflow-auto border-b p-3 text-sm"
    >
      <h2 className="font-medium">Your browser</h2>
      {result.data.supported === true && (
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={!canClaim || !canList}
            onClick={() => void openPicker()}
          >
            Let GOAT use a tab
          </Button>
        </div>
      )}
      {pickerOpen && (
        <BrowserClaimPicker
          threadRef={threadRef}
          onClose={closePicker}
          listing={listing}
          listError={listError}
        />
      )}
      {claims.map((claim) => (
        <div key={claim.claimId} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate">{claim.windowTitle ?? claim.title}</div>
            <div className="truncate text-muted-foreground">{claim.origin}</div>
          </div>
          <Badge variant="secondary">Agent attached</Badge>
          <Button
            size="xs"
            variant="outline"
            disabled={!canEnd}
            onClick={() => void end({ environmentId, input: { claimId: claim.claimId } })}
          >
            End
          </Button>
        </div>
      ))}
      {grants.map((grant) => (
        <div key={grant.origin} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{grant.origin}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={!canRevoke}
            onClick={() =>
              void revoke({ environmentId, input: { threadId, origin: grant.origin } })
            }
          >
            Revoke
          </Button>
        </div>
      ))}
      {pending.map((request) => (
        <p key={request.claimId} className="text-muted-foreground">
          {request.windowTitle} · {request.origin}. See the thread's approval card.
        </p>
      ))}
    </section>
  );
}

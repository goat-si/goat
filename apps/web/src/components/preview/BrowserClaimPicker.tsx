import { useAtomValue } from "@effect/atom-react";
import { BrowserOrigin, type ScopedThreadRef, type BrowserClaimWindows } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

const isOrigin = Schema.is(BrowserOrigin);
type Windows = typeof BrowserClaimWindows.Type;
export function BrowserClaimPicker({
  threadRef,
  onClose,
  listing,
  listError,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
  listing: Windows | null;
  listError: boolean;
}) {
  const { environmentId, threadId } = threadRef;
  const canClaim = useAtomValue(previewEnvironment.claim.permissionAtom(environmentId));
  const claim = useAtomCommand(previewEnvironment.claim, { reportFailure: false });
  const [selected, setSelected] = useState<Windows["windows"][number] | null>(null);
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!selected || !canClaim || !isOrigin(origin) || !origin.startsWith("https://")) return;
    setBusy(true);
    setError(null);
    const result = await claim({
      environmentId,
      input: { threadId, pid: selected.pid, windowId: selected.windowId, origin },
    });
    setBusy(false);
    if (result._tag === "Failure") setError("Could not attach the browser tab.");
    else if (result.value.agentResult.status === "attached") onClose();
    else
      setError(
        result.value.personMessage ??
          (result.value.agentResult.status === "refused"
            ? result.value.agentResult.message
            : "The request is pending."),
      );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Let GOAT use a tab</DialogTitle>
          <DialogDescription>
            Choose a browser window and enter the active tab's site origin.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!listing && !listError && <p>Loading browser windows…</p>}
          {listError && <p role="alert">Browser windows are unavailable.</p>}
          <RadioGroup
            aria-label="Browser windows"
            value={selected ? `${selected.pid}:${selected.windowId}` : ""}
            onValueChange={(value) =>
              setSelected(
                listing?.windows.find((window) => `${window.pid}:${window.windowId}` === value) ??
                  null,
              )
            }
          >
            {listing?.windows.map((window) => (
              <label key={`${window.pid}:${window.windowId}`} className="flex items-center gap-2">
                <Radio value={`${window.pid}:${window.windowId}`} />
                {window.title} ({window.app})
              </label>
            ))}
          </RadioGroup>
          {listing?.refused.map((entry) => (
            <p key={entry.pid}>
              {entry.reason === "browser_process_protected"
                ? `${entry.app} already has a tab in use by an agent. End that claim to pick another window.`
                : `Allow ${entry.app} under computer use to list its windows.`}
            </p>
          ))}
          <label className="grid gap-1">
            Site origin
            <Input
              value={origin}
              placeholder="https://example.com"
              onChange={(event) => setOrigin(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !selected || !canClaim || busy || !isOrigin(origin) || !origin.startsWith("https://")
            }
            onClick={() => void submit()}
          >
            Allow
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

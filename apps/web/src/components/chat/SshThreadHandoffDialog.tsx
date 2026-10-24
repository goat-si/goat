import { useId, useRef, useState } from "react";
import type { SavedSshWorktreeOption } from "../../lib/sshWorktree";
import { findSavedSshWorktreeOption } from "../../lib/sshWorktree";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function SshThreadHandoffDialog(props: {
  options: ReadonlyArray<SavedSshWorktreeOption>;
  blockReason: string | null;
  onClose: () => void;
  onSubmit: (option: SavedSshWorktreeOption, instructions: string) => Promise<boolean>;
}) {
  const hostId = useId();
  const instructionsId = useId();
  const [destination, setDestination] = useState(
    () =>
      (props.options.find((option) => option.disabledReason === null) ?? props.options[0])
        ?.destination ?? null,
  );
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const option = findSavedSshWorktreeOption(props.options, destination);
  const reason =
    props.blockReason ??
    option?.disabledReason ??
    (option === null ? "Choose an available saved SSH host." : null);
  const submit = async () => {
    if (pendingRef.current || reason !== null || option === null) return;
    pendingRef.current = true;
    setPending(true);
    const submitHandoff = async () => {
      if (await props.onSubmit(option, instructions)) props.onClose();
    };
    await submitHandoff().finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pendingRef.current) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Continue on SSH host</DialogTitle>
          <DialogDescription>
            Copy this thread's workspace, including uncommitted changes, and continue with its
            conversation summary on a saved SSH host.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <Label htmlFor={hostId}>SSH host</Label>
            <Select
              value={option ? JSON.stringify(option.destination) : null}
              disabled={pending || props.options.length === 0}
              onValueChange={(value) =>
                setDestination(
                  props.options.find((candidate) => JSON.stringify(candidate.destination) === value)
                    ?.destination ?? null,
                )
              }
            >
              <SelectTrigger id={hostId}>
                <SelectValue placeholder="Choose a saved SSH host">{option?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.options.map((candidate) => (
                  <SelectItem
                    key={JSON.stringify(candidate.destination)}
                    value={JSON.stringify(candidate.destination)}
                    disabled={candidate.disabledReason !== null}
                  >
                    {candidate.label}
                    {candidate.disabledReason ? ` (${candidate.disabledReason})` : ""}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={instructionsId}>Instructions (optional)</Label>
            <Textarea
              id={instructionsId}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={pending}
              placeholder="What should the agent do next?"
            />
          </div>
          {reason ? (
            <p role="status" className="text-sm text-muted-foreground">
              {reason}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || reason !== null}
            onClick={() => {
              void submit();
            }}
          >
            {pending ? "Continuing on SSH host…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

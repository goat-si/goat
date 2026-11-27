import { useGT } from "gt-react";
import { useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string, gt: ReturnType<typeof useGT>): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => /[?？]$/u.test(line.trim()));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.search(/[?？]/u);
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: gt("Confirm action"),
    description: normalizedMessage || gt("This action requires your confirmation."),
  };
}

export function ConfirmDialogHost() {
  const gt = useGT();
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message, gt);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const focusConfirm = state.status !== "idle" && state.initialFocus === "confirm";
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
          {focusConfirm && confirmVariant === "default" ? (
            <AlertDialogAction onClick={onConfirm}>{gt("Confirm")}</AlertDialogAction>
          ) : (
            <Button variant={confirmVariant} onClick={onConfirm}>
              {gt("Confirm")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

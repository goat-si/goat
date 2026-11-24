import type { EnvironmentId, TerminalCloseInput, ThreadId } from "@goat/contracts";
import * as Dialog from "../../components/ui/Dialog";

export function confirmTerminalClose(options: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly label: string;
  readonly canClose: () => boolean;
  readonly close: (request: {
    environmentId: EnvironmentId;
    input: TerminalCloseInput;
  }) => Promise<boolean>;
  readonly onClosed: () => void;
}) {
  Dialog.confirm({
    title: `Close terminal "${options.label}"?`,
    message: "This stops the running process and clears its history.",
    confirmText: "Confirm",
    destructive: true,
    onConfirm: async () => {
      if (!options.canClose()) return;
      const closed = await options.close({
        environmentId: options.environmentId,
        input: { threadId: options.threadId, terminalId: options.terminalId, deleteHistory: true },
      });
      if (closed) options.onClosed();
      else Dialog.alert("Couldn't close terminal", "Check the connection and try again.");
    },
  });
}

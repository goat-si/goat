import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/Dialog", () => ({ confirm: vi.fn(), alert: vi.fn() }));
import * as Dialog from "../../components/ui/Dialog";
import { confirmTerminalClose } from "./terminalClose";

it("closes the chosen terminal only after confirmation and an execution-time grant", async () => {
  const close = vi.fn().mockResolvedValue(true);
  const onClosed = vi.fn();
  let granted = false;
  confirmTerminalClose({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    terminalId: "shell",
    label: "Shell",
    canClose: () => granted,
    close,
    onClosed,
  });
  expect(close).not.toHaveBeenCalled();
  const confirm = vi.mocked(Dialog.confirm).mock.calls.at(-1)?.[0].onConfirm;
  if (!confirm) throw new Error("Missing confirmation");
  await confirm();
  expect(close).not.toHaveBeenCalled();
  granted = true;
  await confirm();
  expect(close).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread", terminalId: "shell", deleteHistory: true },
  });
  expect(onClosed).toHaveBeenCalledOnce();
});

it("keeps the screen open and reports a failed close", async () => {
  const onClosed = vi.fn();
  confirmTerminalClose({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    terminalId: "shell",
    label: "Shell",
    canClose: () => true,
    close: async () => false,
    onClosed,
  });
  const confirm = vi.mocked(Dialog.confirm).mock.calls.at(-1)?.[0].onConfirm;
  if (!confirm) throw new Error("Missing confirmation");
  await confirm();
  expect(onClosed).not.toHaveBeenCalled();
  expect(Dialog.alert).toHaveBeenCalledWith(
    "Couldn't close terminal",
    "Check the connection and try again.",
  );
});

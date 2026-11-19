import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { GlobalVoiceRecording } from "./GlobalVoiceRecording";
import { voiceSession } from "./voiceSession";

vi.mock("../state/environments", () => ({ useEnvironment: () => null }));

it("shows background stop and cancel controls and retains an unattached transcript", async () => {
  let state: { phase: string; unattachedTranscript?: string } = { phase: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: async () => publish({ phase: "recording" }),
    confirm: async () => {
      publish({ phase: "error", unattachedTranscript: "saved words" });
      return false;
    },
    cancel: () => publish({ phase: "idle" }),
  };
  await using screen = await render(<GlobalVoiceRecording />, { router: false }); // Global indicator has no routing dependency.
  await voiceSession.start({ ownerKey: "thread-a", persistent: true, controller });
  await expect.element(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await expect.element(screen.getByText("saved words")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await expect.element(screen.getByText("saved words")).not.toBeInTheDocument();
});

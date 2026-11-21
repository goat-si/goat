import { expect, it, vi } from "vite-plus/test";
import { VoiceSessionRegistry } from "./voiceSession";

type State = { phase: "idle" | "recording" | "error"; unattachedTranscript?: string };
function controller() {
  let state: State = { phase: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn(async () => publish({ phase: "recording" })),
    confirm: vi.fn(async () => {
      publish({ phase: "idle" });
      return true;
    }),
    cancel: vi.fn(() => publish({ phase: "idle" })),
    publish,
  };
}

it("keeps a persistent recording across navigation and prevents a second recording", async () => {
  const registry = new VoiceSessionRegistry();
  const first = controller();
  const second = controller();
  await registry.start({ ownerKey: "thread-a", persistent: true, controller: first });
  registry.ownerUnmounted(first);
  await registry.start({ ownerKey: "thread-b", persistent: true, controller: second });
  expect(first.cancel).not.toHaveBeenCalled();
  expect(second.start).not.toHaveBeenCalled();
  expect(registry.getSnapshot().active?.ownerKey).toBe("thread-a");
  await registry.stop();
  expect(first.confirm).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().active).toBeNull();
});

it("retains an unattached transcript across later recordings and releases on disconnect", async () => {
  const registry = new VoiceSessionRegistry();
  const first = controller();
  await registry.start({ ownerKey: "thread-a", persistent: true, controller: first });
  first.publish({ phase: "error", unattachedTranscript: "kept words" });
  expect(registry.getSnapshot().unattached).toEqual([{ ownerKey: "thread-a", text: "kept words" }]);
  const second = controller();
  await registry.start({ ownerKey: "thread-b", persistent: true, controller: second });
  registry.disconnect();
  expect(second.cancel).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().active).toBeNull();
  expect(registry.getSnapshot().unattached[0]?.text).toBe("kept words");
});

it("cancels nonpersistent owners when they unmount", async () => {
  const registry = new VoiceSessionRegistry();
  const first = controller();
  await registry.start({ ownerKey: "comment", persistent: false, controller: first });
  registry.ownerUnmounted(first);
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().active).toBeNull();
});

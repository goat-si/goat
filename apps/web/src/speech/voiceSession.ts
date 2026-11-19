import type { EnvironmentId } from "@goat/contracts";
import type { BrowserVoiceRecorder } from "../lib/voiceRecorder";

export const MAX_UNATTACHED_VOICE_TRANSCRIPTS = 32;

interface VoiceSessionController {
  getSnapshot(): { readonly phase: string; readonly unattachedTranscript?: string };
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  confirm(): Promise<boolean>;
  cancel(): void;
}

interface VoiceSessionOwner {
  readonly ownerKey: string;
  readonly persistent: boolean;
  readonly environmentId?: EnvironmentId;
  readonly controller: VoiceSessionController;
  readonly recorder?: BrowserVoiceRecorder;
  readonly dispose?: () => void;
}

interface VoiceSessionSnapshot {
  readonly active: VoiceSessionOwner | null;
  readonly unattached: readonly { readonly ownerKey: string; readonly text: string }[];
}

export class VoiceSessionRegistry {
  private snapshot: VoiceSessionSnapshot = { active: null, unattached: [] };
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: VoiceSessionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  async start(owner: VoiceSessionOwner) {
    if (this.snapshot.active || this.snapshot.unattached.length >= MAX_UNATTACHED_VOICE_TRANSCRIPTS)
      return;
    this.publish({ ...this.snapshot, active: owner });
    this.unsubscribe = owner.controller.subscribe(() => {
      if (this.snapshot.active !== owner) return;
      const state = owner.controller.getSnapshot();
      if (state.phase === "idle" || state.phase === "error") {
        const unattached = state.unattachedTranscript
          ? [
              ...this.snapshot.unattached,
              { ownerKey: owner.ownerKey, text: state.unattachedTranscript },
            ]
          : this.snapshot.unattached;
        this.unsubscribe?.();
        this.unsubscribe = null;
        owner.dispose?.();
        this.publish({ active: null, unattached });
      } else this.publish({ ...this.snapshot });
    });
    await owner.controller.start();
    if (this.getSnapshot().active === owner && owner.controller.getSnapshot().phase === "idle") {
      this.unsubscribe?.();
      this.unsubscribe = null;
      owner.dispose?.();
      this.publish({ ...this.snapshot, active: null });
    }
  }
  ownerUnmounted(controller: VoiceSessionController) {
    if (this.snapshot.active?.controller === controller && !this.snapshot.active.persistent)
      this.disconnect();
  }
  async stop() {
    await this.snapshot.active?.controller.confirm();
  }
  disconnect() {
    this.snapshot.active?.controller.cancel();
  }
  dismiss(index: number) {
    this.publish({
      ...this.snapshot,
      unattached: this.snapshot.unattached.filter((_, i) => i !== index),
    });
  }
}

export const voiceSession = new VoiceSessionRegistry();

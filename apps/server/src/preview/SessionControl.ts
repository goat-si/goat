import type { PreviewAutomationControlReason } from "@goat/contracts";

import { PREVIEW_ADMISSION_REASONS } from "./actionOutcomeSafety.ts";

export class BrowserControlInterrupted extends Error {
  readonly reason: PreviewAutomationControlReason;
  /** GOAT refused before any input left; a cut of work under way leaves this false. */
  readonly beforeInput: boolean;
  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewAutomationControlReason = "interrupted",
    beforeInput = PREVIEW_ADMISSION_REASONS.has(reason),
  ) {
    super(message);
    this.reason = reason;
    this.beforeInput = beforeInput;
  }
}

/** A refusal raised while admitting a request or at its dispatch gate. */
const refused = (message?: string, reason?: PreviewAutomationControlReason) =>
  new BrowserControlInterrupted(message, reason, true);

const settle = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

const PRIVATE_MESSAGE =
  "A password, one-time code or passkey prompt has focus, so this tab is private until a person leaves it.";
const STOPPED_MESSAGE = "A person stopped agent control of this browser tab.";
const HUMAN_MESSAGE = "A human controls this tab.";
const HANDOFF_MESSAGE =
  "This tab waits for the person you asked to finish a step; act again once they hand it back.";

/** What a person did with an agent's request on the tab: took it, handed it back, stopped it, or closed the tab. */
export type HandoffChange = "taken" | "handedBack" | "stopped" | "ended";
/** Why a person's hand back did not complete the request: not recorded yet, too late, or answered. */
export type HandBackNotice = "unsaved" | "expired" | "answered";

/** What a secret fill may do from inside its queued turn. */
export interface SecretFence {
  readonly signal: AbortSignal;
  /** Throws once a person took control or stopped agents since the fill was requested. */
  readonly assertMayDispatch: () => void;
  /** Keeps the tab private, for observers and recordings, until the fill ends. */
  readonly hold: () => void;
}

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private latestHuman: {
    entry: { viewerId: string; key: string; run: () => Promise<void> };
    result: Promise<void>;
  } | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly handoff = new Set<Promise<void>>();
  private owner: string | null = null;
  private epoch = 0;
  private closed = false;
  private privateMode = false;
  /** Private mode is on while the page reports a secret field or a secret fill holds it. */
  private watcherPrivate = false;
  private privateHolds = 0;
  /** Counts takeovers, Stops and closing; a secret fill's permit ends at the next one. */
  private authorityEpoch = 0;
  /** Counts private periods, so a read that overlapped one is withheld even after it ended. */
  private privateEpoch = 0;
  private agentStopped = false;
  /** The step an agent asked a person to finish here, until they hand the tab back. */
  private requested: string | null = null;
  /** Which request the hold belongs to, so a late end never settles a newer one. */
  private requestId = "";
  private notice: HandBackNotice | null = null;
  private readonly handoffListeners = new Set<(end: HandoffChange, requestId: string) => void>();
  private activeAgentAction: AbortController | undefined;
  /** Stop and a secret answer the running action at once; a takeover still lets it drain. */
  private activeAgentCut: AbortController | undefined;
  private activeSecretAction: AbortController | undefined;
  /** The running agent action's work, and whether its input already passed the gate. */
  private activeAgentWork: Promise<unknown> | undefined;
  private activeAgentDispatching = false;
  private readonly dispatchCutListeners = new Set<(work: Promise<unknown>) => void>();
  /** Input an earlier action left running, such as a click that opened a dialog. */
  private readonly lingering = new Set<Promise<unknown>>();

  constructor(agentId: string | null, onGenerationChange: () => void = () => {}) {
    this.agentId = agentId;
    this.onGenerationChange = onGenerationChange;
  }

  get controller() {
    return this.owner;
  }

  get generation() {
    return this.epoch;
  }

  get authority() {
    return this.authorityEpoch;
  }

  get isClosed() {
    return this.closed;
  }

  /** A secret field or passkey prompt has focus: agents neither act nor look, viewers see nothing. */
  get isPrivate() {
    return this.privateMode;
  }

  /** A person stopped agents here until they hand the tab back. */
  get isAgentStopped() {
    return this.agentStopped;
  }

  /** What the agent asked a person to do here, while the tab waits for them. */
  get handoffReason() {
    return this.requested;
  }

  /** Why the person's last hand back here did not complete the request, until they act again. */
  get handBackNotice() {
    return this.notice;
  }

  /** Tells viewers how a hand back ended; an unrecorded one only while the request still holds. */
  noteHandBack(notice: HandBackNotice) {
    if ((notice === "unsaved" && this.requested === null) || this.notice === notice) return;
    this.notice = notice;
    this.changed();
  }

  /** Calls back after any change of owner, privacy or stop, for status readers. */
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Calls back when a person takes the tab, hands it back, stops it or closes it. */
  onHandoffChange(listener: (end: HandoffChange, requestId: string) => void) {
    this.handoffListeners.add(listener);
    return () => void this.handoffListeners.delete(listener);
  }

  /** The agent hands the tab to a person: its actions stop, as at a takeover, until hand back. */
  requestHandoff(reason: string, requestId = "") {
    if (this.closed || this.agentStopped) return false;
    if (this.requested === null) {
      this.authorityEpoch++;
      this.epoch++;
      this.requested = reason;
      this.notice = null;
      this.requestId = requestId;
      this.onGenerationChange();
      this.cut(new BrowserControlInterrupted(HANDOFF_MESSAGE, "humanControl"));
      this.changed();
    }
    return true;
  }

  /**
   * Ends the request. A person's end tells the listeners; the request's own record ending
   * (answered in the thread, or expired) does not. Refs taken during it expire either way.
   */
  endHandoff(end: Exclude<HandoffChange, "taken"> | null) {
    if (!this.clearRequest(end)) return;
    this.epoch++;
    this.onGenerationChange();
    this.changed();
  }

  /** Clears the request without moving the generation, for callers that move it themselves. */
  private clearRequest(end: Exclude<HandoffChange, "taken"> | null) {
    if (this.requested === null) return false;
    this.requested = null;
    this.notice = null;
    if (end !== null) for (const listener of this.handoffListeners) listener(end, this.requestId);
    return true;
  }

  /** Entering private mode ends whatever an agent is doing and expires every ref it holds. */
  setPrivate(on: boolean) {
    this.watcherPrivate = on;
    this.applyPrivate();
  }

  private applyPrivate() {
    const on = this.watcherPrivate || this.privateHolds > 0;
    if (this.closed || on === this.privateMode) return;
    this.privateMode = on;
    if (on) this.privateEpoch++;
    this.epoch++;
    this.onGenerationChange();
    if (on) this.cut(new BrowserControlInterrupted(PRIVATE_MESSAGE, "privateMode"));
    this.changed();
  }

  stopAgents() {
    if (this.closed || this.agentStopped) return;
    this.agentStopped = true;
    this.authorityEpoch++;
    this.epoch++;
    this.onGenerationChange();
    this.cut(new BrowserControlInterrupted(STOPPED_MESSAGE, "stopped"));
    this.clearRequest("stopped");
    this.changed();
  }

  cutBlockedUrl() {
    this.cut(
      new BrowserControlInterrupted(
        "This browser host is blocked.",
        "blocked_url",
        !this.activeAgentDispatching,
      ),
    );
  }

  private cut(reason: BrowserControlInterrupted) {
    // Input already past its gate cannot be recalled, so the page must ignore it until it ends.
    const held = [...this.lingering];
    if (this.activeAgentDispatching && this.activeAgentWork) held.push(this.activeAgentWork);
    for (const work of held) for (const listener of this.dispatchCutListeners) listener(work);
    this.activeAgentAction?.abort(reason);
    this.activeAgentCut?.abort(reason);
    if (reason.reason !== "privateMode") this.activeSecretAction?.abort(reason);
  }

  /** Calls back when Stop or a secret cuts an action whose input already passed its gate. */
  onDispatchCut(listener: (work: Promise<unknown>) => void) {
    this.dispatchCutListeners.add(listener);
    return () => void this.dispatchCutListeners.delete(listener);
  }

  resumeAgents() {
    // Hand back from the card, when the person never took the stream's control.
    this.endHandoff("handedBack");
    if (!this.agentStopped) return;
    this.agentStopped = false;
    this.changed();
  }

  /**
   * Called just before input leaves for the page, after any wait such as the agent cursor: an
   * action that started before Stop, a takeover or a secret field must not land after it.
   */
  assertAgentMayDispatch() {
    this.assertOpen();
    const blocked = this.agentBlocked();
    if (blocked) throw blocked;
    if (this.owner !== null) throw refused("A human controls this tab.", "humanControl");
  }

  /**
   * The gate for one agent action, taken when it starts. Any change of control since then shuts it
   * for good: an input cancelled by a secret field or a takeover stays cancelled after it ends.
   */
  dispatchGate(expectedGeneration?: number) {
    const epoch = this.epoch;
    // Clicks and scroll collection reuse one gate; once input went out, a later refusal is not
    // "before input" for the action as a whole.
    let passed = false;
    const check = () => {
      this.assertAgentMayDispatch();
      if (expectedGeneration !== undefined && this.epoch !== expectedGeneration)
        throw refused("Browser control changed; refresh the tab snapshot.");
      if (this.epoch !== epoch) throw refused();
    };
    const gate = () => {
      try {
        check();
      } catch (cause) {
        if (passed && cause instanceof BrowserControlInterrupted && cause.beforeInput)
          throw new BrowserControlInterrupted(cause.message, cause.reason, false);
        throw cause;
      }
      passed = true;
      this.activeAgentDispatching = true;
    };
    const linger = (work: Promise<unknown>) => {
      this.lingering.add(work);
      const done = () => void this.lingering.delete(work);
      work.then(done, done);
    };
    return Object.assign(gate, { linger, check });
  }

  assertObservedGeneration(expectedGeneration: number) {
    this.assertOpen();
    if (this.privateMode || this.epoch !== expectedGeneration)
      throw new BrowserControlInterrupted("Browser observation changed; refresh the tab snapshot.");
  }

  private agentBlocked() {
    if (this.privateMode) return refused(PRIVATE_MESSAGE, "privateMode");
    if (this.agentStopped) return refused(STOPPED_MESSAGE, "stopped");
    if (this.requested !== null) return refused(HANDOFF_MESSAGE, "humanControl");
    return undefined;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    this.latestHuman = null;
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work: Promise<unknown>) {
    this.pending = Promise.all([this.pending, settle(work)]).then(() => undefined);
  }

  /** Viewer input stays responsive, but control handoffs still drain its navigations. */
  trackUntilHandoff(work: Promise<unknown>) {
    const settled = settle(work).finally(() => {
      this.handoff.delete(settled);
    });
    this.handoff.add(settled);
  }

  private assertOpen() {
    if (this.closed) throw refused("This browser tab is closed.", "closed");
  }

  private changeOwner(owner: string | null) {
    this.latestHuman = null;
    this.owner = owner;
    this.authorityEpoch++;
    this.epoch++;
    this.onGenerationChange();
    const interrupted = new BrowserControlInterrupted(
      this.closed ? "This browser tab is closed." : "Browser control changed during the wait.",
      this.closed ? "closed" : owner !== null ? "humanControl" : "interrupted",
    );
    this.activeAgentAction?.abort(interrupted);
    this.activeSecretAction?.abort(interrupted);
    this.changed();
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>, deadlineMs?: number) {
    this.assertOpen();
    if (!allowed()) throw refused("You do not control this browser tab.");
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw refused();
      if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
        throw new DOMException(
          "This browser request expired before it could start.",
          "TimeoutError",
        );
      }
      return run();
    });
  }

  agentMayAct(agentId: string) {
    return this.agentId === null || this.agentId === agentId;
  }

  /**
   * An agent action. It may act on its own tab or on one a human opened, but
   * never while a human controls the tab; taking control interrupts it.
   */
  agent<A>(agentId: string, run: (signal: AbortSignal) => Promise<A>, deadlineMs?: number) {
    if (!this.agentMayAct(agentId))
      return Promise.reject(
        new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch"),
      );
    if (this.owner !== null)
      return Promise.reject(refused("A human controls this tab.", "humanControl"));
    const blocked = this.agentBlocked();
    if (blocked) return Promise.reject(blocked);
    return this.action(
      () => this.agentMayAct(agentId) && this.owner === null && !this.agentBlocked(),
      async () => {
        const action = new AbortController();
        const cut = new AbortController();
        this.activeAgentAction = action;
        this.activeAgentCut = cut;
        // Reset first: run() can pass its gate before it returns.
        this.activeAgentDispatching = false;
        const aborted = new Promise<never>((_, reject) =>
          cut.signal.addEventListener("abort", () => reject(cut.signal.reason), { once: true }),
        );
        const work = Promise.resolve().then(() => {
          action.signal.throwIfAborted();
          return run(action.signal);
        });
        this.activeAgentWork = work;
        // Later actions still wait for it, even after its caller has been answered.
        this.track(work);
        try {
          // Work that ignores the signal still never hands its result to the agent.
          return await Promise.race([work, aborted]);
        } finally {
          this.activeAgentAction = undefined;
          this.activeAgentCut = undefined;
          this.activeAgentWork = undefined;
          this.activeAgentDispatching = false;
          void aborted.catch(() => undefined);
        }
      },
      deadlineMs,
    );
  }

  agentCanActNow(agentId: string) {
    return this.agentMayAct(agentId) && this.owner === null && !this.agentBlocked();
  }

  /** Narrows a request whose agent session the broker should always have supplied. */
  static requireAgentSession<R extends { readonly agentSessionId?: string | undefined }>(
    request: R,
  ): asserts request is R & { readonly agentSessionId: string } {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted("The agent session is missing. Reconnect the provider.");
  }

  /** Agent work outside the queue (a dialog answer, closing): not while a person has the tab. */
  assertNoHumanControl() {
    if (this.owner !== null) throw refused(HUMAN_MESSAGE, "humanControl");
    if (this.requested !== null) throw refused(HANDOFF_MESSAGE, "humanControl");
  }

  /**
   * Host work that types a secret the agent never sees. Unlike `agent`, it may run while the tab
   * is private, because a focused password field is what it fills; a person's control or Stop
   * still refuses it, and a cut from private mode does not end it.
   */
  secret<A>(agentId: string, run: (fence: SecretFence) => Promise<A>, deadlineMs?: number) {
    if (!this.agentMayAct(agentId))
      return Promise.reject(
        new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch"),
      );
    if (this.owner !== null) return Promise.reject(refused(HUMAN_MESSAGE, "humanControl"));
    if (this.agentStopped) return Promise.reject(refused(STOPPED_MESSAGE, "stopped"));
    if (this.requested !== null) return Promise.reject(refused(HANDOFF_MESSAGE, "humanControl"));
    const authority = this.authority;
    const cut = new AbortController();
    const assertMayDispatch = () => {
      cut.signal.throwIfAborted();
      this.assertOpen();
      if (this.agentStopped) throw new BrowserControlInterrupted(STOPPED_MESSAGE, "stopped");
      if (this.owner !== null || this.authority !== authority)
        throw new BrowserControlInterrupted(
          "A person took control of this tab, so nothing was filled.",
          "humanControl",
        );
    };
    return this.action(
      () =>
        this.agentMayAct(agentId) &&
        this.owner === null &&
        !this.agentStopped &&
        this.requested === null,
      async () => {
        this.activeSecretAction = cut;
        let held = false;
        const hold = () => {
          if (held) return;
          held = true;
          this.privateHolds++;
          this.applyPrivate();
        };
        try {
          assertMayDispatch();
          return await run({ assertMayDispatch, hold, signal: cut.signal });
        } finally {
          this.activeSecretAction = undefined;
          if (held) {
            this.privateHolds--;
            this.applyPrivate();
          }
        }
      },
      deadlineMs,
    );
  }

  /**
   * A read that needs no control and does not queue, so an agent can look at
   * a page while a human drives it without holding up the human's input. A
   * private tab refuses it: a person typing a secret is not shared with agents.
   */
  observe<A>(run: () => Promise<A>) {
    this.assertOpen();
    if (this.privateMode)
      return Promise.reject(new BrowserControlInterrupted(PRIVATE_MESSAGE, "privateMode"));
    // A secret that appeared while it read, even briefly, keeps what it saw from the agent.
    const privateEpoch = this.privateEpoch;
    return run().then((result) => {
      if (this.privateMode || this.privateEpoch !== privateEpoch)
        throw new BrowserControlInterrupted(PRIVATE_MESSAGE, "privateMode");
      return result;
    });
  }

  system<A>(run: () => Promise<A>) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.action(() => this.owner === viewerId, run);
  }

  /** Replace only adjacent waiting work; the running action and intervening actions keep their order. */
  humanLatest(viewerId: string, key: string, run: () => Promise<void>): Promise<void> {
    if (this.closed || this.owner !== viewerId) return this.human(viewerId, run);
    const latest = this.latestHuman;
    if (latest?.entry.viewerId === viewerId && latest.entry.key === key) {
      latest.entry.run = run;
      return latest.result;
    }
    const entry = { viewerId, key, run };
    const result = this.human(viewerId, async () => {
      if (this.latestHuman?.entry === entry) this.latestHuman = null;
      await entry.run();
    });
    this.latestHuman = { entry, result };
    return result;
  }

  async take(viewerId: string) {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlInterrupted("Another viewer controls this browser tab.");
    }
    if (this.owner !== viewerId) {
      this.notice = null;
      this.changeOwner(viewerId);
      if (this.requested !== null)
        for (const listener of this.handoffListeners) listener("taken", this.requestId);
    }
    return this.human(viewerId, async () => {});
  }

  /** A person's Hand back: it also completes an agent's request for them. */
  async release(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    await this.releaseOwner(viewerId, afterDrain, true);
  }

  private async releaseOwner(
    viewerId: string,
    afterDrain: () => Promise<void>,
    handedBack: boolean,
  ) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted(
        "Only the controlling viewer can release this browser tab.",
      );
    }
    // The request stays held until its record takes the hand back, which then ends it here.
    if (handedBack && this.requested !== null) {
      this.notice = null;
      for (const listener of this.handoffListeners) listener("handedBack", this.requestId);
    }
    this.changeOwner(null);
    await this.enqueue(async () => {
      await Promise.all(this.handoff);
      await afterDrain();
    });
  }

  async disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    // A dropped connection gives control back but has not finished the person's step.
    if (!this.closed && this.owner === viewerId)
      await this.releaseOwner(viewerId, afterDrain ?? (async () => {}), false);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.clearRequest("ended");
      this.changeOwner(null);
    }
    await this.tail;
  }
}

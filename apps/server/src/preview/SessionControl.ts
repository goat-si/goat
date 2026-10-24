import type { PreviewAutomationControlReason } from "@goat/contracts";

export class BrowserControlInterrupted extends Error {
  readonly reason: PreviewAutomationControlReason;
  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewAutomationControlReason = "interrupted",
  ) {
    super(message);
    this.reason = reason;
  }
}

const settle = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

const PRIVATE_MESSAGE =
  "A password, one-time code or passkey prompt has focus, so this tab is private until a person leaves it.";
const STOPPED_MESSAGE = "A person stopped agent control of this browser tab.";

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  private readonly handoff = new Set<Promise<void>>();
  private owner: string | null = null;
  private epoch = 0;
  private closed = false;
  private privateMode = false;
  /** Counts private periods, so a read that overlapped one is withheld even after it ended. */
  private privateEpoch = 0;
  private agentStopped = false;
  private activeAgentAction: AbortController | undefined;
  /** Stop and a secret answer the running action at once; a takeover still lets it drain. */
  private activeAgentCut: AbortController | undefined;
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

  /** A secret field or passkey prompt has focus: agents neither act nor look, viewers see nothing. */
  get isPrivate() {
    return this.privateMode;
  }

  /** A person stopped agents here until they hand the tab back. */
  get isAgentStopped() {
    return this.agentStopped;
  }

  /** Calls back after any change of owner, privacy or stop, for status readers. */
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Entering private mode ends whatever an agent is doing and expires every ref it holds. */
  setPrivate(on: boolean) {
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
    this.epoch++;
    this.onGenerationChange();
    this.cut(new BrowserControlInterrupted(STOPPED_MESSAGE, "stopped"));
    this.changed();
  }

  private cut(reason: BrowserControlInterrupted) {
    // Input already past its gate cannot be recalled, so the page must ignore it until it ends.
    const held = [...this.lingering];
    if (this.activeAgentDispatching && this.activeAgentWork) held.push(this.activeAgentWork);
    for (const work of held) for (const listener of this.dispatchCutListeners) listener(work);
    this.activeAgentAction?.abort(reason);
    this.activeAgentCut?.abort(reason);
  }

  /** Calls back when Stop or a secret cuts an action whose input already passed its gate. */
  onDispatchCut(listener: (work: Promise<unknown>) => void) {
    this.dispatchCutListeners.add(listener);
    return () => void this.dispatchCutListeners.delete(listener);
  }

  resumeAgents() {
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
    if (this.owner !== null)
      throw new BrowserControlInterrupted("A human controls this tab.", "humanControl");
  }

  /**
   * The gate for one agent action, taken when it starts. Any change of control since then shuts it
   * for good: an input cancelled by a secret field or a takeover stays cancelled after it ends.
   */
  dispatchGate() {
    const epoch = this.epoch;
    const gate = () => {
      this.assertAgentMayDispatch();
      if (this.epoch !== epoch) throw new BrowserControlInterrupted();
      this.activeAgentDispatching = true;
    };
    const linger = (work: Promise<unknown>) => {
      this.lingering.add(work);
      const done = () => void this.lingering.delete(work);
      work.then(done, done);
    };
    return Object.assign(gate, { linger });
  }

  private agentBlocked() {
    if (this.privateMode) return new BrowserControlInterrupted(PRIVATE_MESSAGE, "privateMode");
    if (this.agentStopped) return new BrowserControlInterrupted(STOPPED_MESSAGE, "stopped");
    return undefined;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
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
    if (this.closed) throw new BrowserControlInterrupted("This browser tab is closed.", "closed");
  }

  private changeOwner(owner: string | null) {
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
    this.activeAgentAction?.abort(
      new BrowserControlInterrupted(
        this.closed ? "This browser tab is closed." : "Browser control changed during the wait.",
        this.closed ? "closed" : owner !== null ? "humanControl" : "interrupted",
      ),
    );
    this.changed();
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>, deadlineMs?: number) {
    this.assertOpen();
    if (!allowed()) throw new BrowserControlInterrupted("You do not control this browser tab.");
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
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
      return Promise.reject(
        new BrowserControlInterrupted("A human controls this tab.", "humanControl"),
      );
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
        const work = run(action.signal);
        this.activeAgentWork = work;
        // Later actions still wait for it, even after its caller has been answered.
        this.track(work);
        const aborted = new Promise<never>((_, reject) =>
          cut.signal.addEventListener("abort", () => reject(cut.signal.reason), { once: true }),
        );
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

  async take(viewerId: string) {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlInterrupted("Another viewer controls this browser tab.");
    }
    if (this.owner !== viewerId) this.changeOwner(viewerId);
    return this.human(viewerId, async () => {});
  }

  async release(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted(
        "Only the controlling viewer can release this browser tab.",
      );
    }
    this.changeOwner(null);
    await this.enqueue(async () => {
      await Promise.all(this.handoff);
      await afterDrain();
    });
  }

  async disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId, afterDrain);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}

// Scripted engine for driver tests. Input text picks the behaviour:
//   "crash"   emits one delta, then the process exits 70 (a real crash, no exited event)
//   "hang"    never finishes until interrupted
//   "ask"     opens a question; the answer text is echoed
//   "approve" opens an approval; the outcome is echoed
//   "fail"    the turn fails
//   anything else echoes "echo: <text>" in two deltas
// A steer during a turn is accepted and appended to the final message. When the turn ends, its
// steers are reported with steer_updated: completed if the turn finished, cancelled otherwise.
// session.set_config is supported unless launch.env GOAT2_FAKE_NO_SET_CONFIG=1; after it, echoes
// end with " [model: <model>, mode: <runtimeMode>]".
import type { EngineHost, EngineModule, EngineSession } from "../engine.ts";
import { assistantMessage, item } from "../items.ts";
import {
  HelperError,
  type EngineInput,
  type InitializeParams,
  type RequestAnswer,
  type SteerResult,
  type TurnSettings,
  type TurnStartResult,
} from "../protocol.ts";

const DRIVER = "fake";

interface ActiveTurn {
  readonly turnId: string;
  readonly steered: string[];
  readonly steeredIds: string[];
  interrupted: boolean;
  wake: (() => void) | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSession implements EngineSession {
  readonly engineRef: string;
  readonly #host: EngineHost;
  #turns = 0;
  #active: ActiveTurn | undefined;
  readonly #requests = new Map<string, (answer: RequestAnswer) => void>();
  #config: TurnSettings | undefined;
  readonly setConfig?: (settings: TurnSettings) => Promise<void>;

  constructor(engineRef: string, host: EngineHost, allowSetConfig: boolean) {
    this.engineRef = engineRef;
    this.#host = host;
    if (allowSetConfig) {
      this.setConfig = async (settings) => {
        this.#config = settings;
      };
    }
  }

  async startTurn(inputs: ReadonlyArray<EngineInput>): Promise<TurnStartResult> {
    if (this.#active !== undefined) {
      return { status: "declined", reason: "a turn is already running" };
    }
    this.#turns += 1;
    const turn: ActiveTurn = {
      turnId: `turn-${this.#turns}`,
      steered: [],
      steeredIds: [],
      interrupted: false,
      wake: undefined,
    };
    this.#active = turn;
    const files = inputs.flatMap((input) => input.attachments.map((attachment) => attachment.path ?? "missing"));
    const text = inputs.map((input) => input.text).join("\n") + (files.length === 0 ? "" : ` [files: ${files.join(", ")}]`);
    setImmediate(() => {
      void this.#run(turn, text).catch((cause) => this.#host.fail(String(cause)));
    });
    return { status: "accepted", turnId: turn.turnId };
  }

  async steer(turnId: string, inputs: ReadonlyArray<EngineInput>): Promise<SteerResult> {
    const turn = this.#active;
    if (turn === undefined || turn.turnId !== turnId) {
      return { status: "declined", reason: "no running turn with that id" };
    }
    turn.steered.push(...inputs.map((input) => input.text));
    turn.steeredIds.push(...inputs.map((input) => input.inputId));
    return { status: "accepted" };
  }

  async interrupt(turnId: string): Promise<void> {
    const turn = this.#active;
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.interrupted = true;
    turn.wake?.();
  }

  async answerRequest(key: string, answer: RequestAnswer): Promise<void> {
    const resolve = this.#requests.get(key);
    if (resolve === undefined) throw new HelperError("bad_request", `no open request ${key}`);
    this.#requests.delete(key);
    resolve(answer);
  }

  async shutdown(): Promise<void> {
    const turn = this.#active;
    if (turn !== undefined) {
      turn.interrupted = true;
      turn.wake?.();
    }
  }

  async #run(turn: ActiveTurn, text: string): Promise<void> {
    const host = this.#host;
    const base = (id: string) => ({ id, turnId: turn.turnId, driver: DRIVER, nativeId: id, now: host.now() });
    const messageId = `${turn.turnId}:message`;
    const finish = (outcome: { type: "done" } | { type: "failed"; reason: string } | { type: "interrupted" }) => {
      this.#active = undefined;
      if (turn.steeredIds.length > 0) {
        host.emit({
          type: "steer_updated",
          turnId: turn.turnId,
          inputIds: [...turn.steeredIds],
          status:
            outcome.type === "done"
              ? { type: "completed" }
              : { type: "cancelled", reason: `the turn ended (${outcome.type}) before the steer was read` },
        });
      }
      host.emit({ type: "turn_finished", turnId: turn.turnId, outcome });
    };
    const waitForInterrupt = () =>
      new Promise<void>((resolve) => {
        if (turn.interrupted) return resolve();
        turn.wake = resolve;
      });

    let reply: string;
    switch (text.trim()) {
      case "crash":
        host.emit({ type: "text_delta", turnId: turn.turnId, itemId: messageId, text: "about to crash" });
        await sleep(20);
        process.exit(70);
        return;
      case "hang":
        await waitForInterrupt();
        return finish({ type: "interrupted" });
      case "fail":
        return finish({ type: "failed", reason: "fake failure" });
      case "ask":
      case "approve": {
        const key = `${turn.turnId}:request`;
        const question = text.trim() === "ask";
        const answered = new Promise<RequestAnswer>((resolve) => this.#requests.set(key, resolve));
        host.emit({
          type: "request_opened",
          turnId: turn.turnId,
          key,
          itemId: key,
          kind: question ? "question" : "approval",
          summary: question ? "Pick a color" : "Run ls?",
          item: question
            ? item({ ...base(key), status: "waiting", completedAt: null }, "user_input_request", {
                requestId: key,
                questions: [{ id: "color", header: "Color", question: "Pick a color", options: [] }],
              } as never)
            : item({ ...base(key), status: "waiting", completedAt: null }, "approval_request", {
                requestId: key,
                requestKind: "command",
                prompt: "ls",
              } as never),
        });
        const outcome = await Promise.race([answered, waitForInterrupt().then(() => undefined)]);
        if (outcome === undefined) {
          this.#requests.delete(key);
          host.emit({ type: "request_closed", key });
          return finish({ type: "interrupted" });
        }
        reply = question ? `answer: ${outcome.text ?? JSON.stringify(outcome.answers ?? {})}` : `approval: ${outcome.outcome}`;
        break;
      }
      default: {
        const config = this.#config;
        reply =
          `echo: ${text}` +
          (config === undefined ? "" : ` [model: ${config.modelSelection.model}, mode: ${config.runtimeMode}]`);
        const half = Math.ceil(reply.length / 2);
        host.emit({ type: "text_delta", turnId: turn.turnId, itemId: messageId, text: reply.slice(0, half) });
        await sleep(5);
        host.emit({ type: "text_delta", turnId: turn.turnId, itemId: messageId, text: reply.slice(half) });
        host.emit({
          type: "token_usage",
          turnId: turn.turnId,
          usage: { usedTokens: reply.length, inputTokens: text.length, outputTokens: reply.length },
        });
      }
    }
    await sleep(5);
    if (turn.interrupted) return finish({ type: "interrupted" });
    const steered = turn.steered.length === 0 ? "" : `\nsteered: ${turn.steered.join(" | ")}`;
    host.emit({
      type: "item_completed",
      turnId: turn.turnId,
      item: assistantMessage(base(messageId), reply + steered),
      locator: { turnId: turn.turnId, itemId: messageId },
    });
    finish({ type: "done" });
  }
}

export const fakeEngine: EngineModule = {
  async probe(_params, host) {
    const capabilities = process.env["GOAT2_FAKE_PROBE_CAPABILITIES"];
    return {
      installed: true,
      version: "0.0.0-fake",
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "fake-model", name: "Fake", isCustom: false, capabilities: null }],
      checkedAt: host.now(),
      ...(capabilities === undefined ? {} : { capabilities: JSON.parse(capabilities) }),
    };
  },
  async start(params: InitializeParams, host: EngineHost): Promise<EngineSession> {
    if (params.launch?.env?.["GOAT2_FAKE_START_FAIL"] === "1") {
      throw new HelperError("start_failed", "fake start failure");
    }
    const allowSetConfig = params.launch?.env?.["GOAT2_FAKE_NO_SET_CONFIG"] !== "1";
    return new FakeSession(params.resume ?? `fake-${params.threadId}`, host, allowSetConfig);
  },
};

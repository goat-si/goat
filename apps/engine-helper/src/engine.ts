// The seam every SDK engine implements inside the helper.
import type {
  EngineEvent,
  EngineInput,
  InitializeParams,
  LogLevel,
  ProbeParams,
  ProbeResult,
  RequestAnswer,
  SteerResult,
  TurnSettings,
  TurnStartResult,
} from "./protocol.ts";

/** What an engine may do towards the host. */
export interface EngineHost {
  emit(event: EngineEvent): void;
  log(level: LogLevel, message: string): void;
  /** The engine is gone for good (process died, SDK closed). Emits `exited` and ends the helper. */
  fail(reason: string): void;
  /** ISO-8601 now; injectable for tests. */
  now(): string;
}

/** One live engine session for one GOAT thread. */
export interface EngineSession {
  /** The engine's own session id (Cursor agent id, OpenCode session id, Muse thread id). */
  readonly engineRef: string;
  startTurn(inputs: ReadonlyArray<EngineInput>, settings: TurnSettings): Promise<TurnStartResult>;
  steer(turnId: string, inputs: ReadonlyArray<EngineInput>): Promise<SteerResult>;
  interrupt(turnId: string): Promise<void>;
  answerRequest(key: string, answer: RequestAnswer): Promise<void>;
  /**
   * Change model or runtime mode inside the running session. The host calls it only when the
   * engine's capabilities allow an in-session switch. Engines without it answer `unsupported`.
   */
  setConfig?(settings: TurnSettings): Promise<void>;
  shutdown(): Promise<void>;
}

export interface EngineModule {
  start(params: InitializeParams, host: EngineHost): Promise<EngineSession>;
  /** Install, version, sign-in and models without starting a session (v1 provider status probe). */
  probe?(params: ProbeParams, host: EngineHost): Promise<ProbeResult>;
}

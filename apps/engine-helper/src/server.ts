// The helper's request loop: one engine session per process (see ../PROTOCOL.md).
import type { EngineHost, EngineModule, EngineSession } from "./engine.ts";
import {
  ENGINE_KINDS,
  HelperError,
  PROTOCOL_VERSION,
  type EngineEvent,
  type EngineKind,
  type InitializeParams,
  type LogLevel,
  type ProbeParams,
} from "./protocol.ts";

export type EngineLoaders = Readonly<Record<EngineKind, () => Promise<EngineModule>>>;

export interface ServerOptions {
  readonly engines: EngineLoaders;
  /** Writes one protocol line (without the trailing LF). `done` runs once it is flushed. */
  readonly write: (line: string, done?: () => void) => void;
  /** Ends the process. */
  readonly exit: (code: number) => void;
  readonly now?: () => string;
  /** How long `shutdown` waits for the engine before exiting anyway. */
  readonly shutdownGraceMs?: number;
}

export interface HelperServer {
  handleLine(line: string): void;
  /** stdin closed: stop the engine and exit 0. */
  close(): Promise<void>;
  /** The engine or the process failed for good. */
  fail(reason: string): void;
  log(level: LogLevel, message: string): void;
}

type RequestFrame = { readonly id: number; readonly method: string; readonly params?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "unknown error";
}

export function createServer(options: ServerOptions): HelperServer {
  const now = options.now ?? (() => new Date().toISOString());
  let session: EngineSession | undefined;
  let starting = false;
  let ended = false;

  const send = (frame: unknown, done?: () => void) => {
    options.write(JSON.stringify(frame), done);
  };

  const log = (level: LogLevel, message: string) => {
    if (!ended) send({ log: { level, message } });
  };

  const emit = (event: EngineEvent) => {
    if (!ended) send({ event });
  };

  const fail = (reason: string) => {
    if (ended) return;
    ended = true;
    send({ event: { type: "exited", reason } }, () => options.exit(1));
  };

  const host: EngineHost = { emit, log, fail, now };

  const respond = (id: number, result: unknown) => {
    if (!ended) send({ id, result });
  };

  const respondError = (id: number, cause: unknown) => {
    const code = cause instanceof HelperError ? cause.code : "transport";
    if (!ended) send({ id, error: { code, message: errorMessage(cause) } });
  };

  const requireSession = (): EngineSession => {
    if (session === undefined) throw new HelperError("bad_request", "initialize first");
    return session;
  };

  const initialize = async (params: unknown) => {
    if (session !== undefined || starting) {
      throw new HelperError("bad_request", "already initialized");
    }
    starting = true;
    try {
      const [, module] = await loadEngine(params);
      try {
        session = await module.start(params as unknown as InitializeParams, host);
      } catch (cause) {
        if (cause instanceof HelperError) throw cause;
        throw new HelperError("start_failed", errorMessage(cause));
      }
      return { engineRef: session.engineRef };
    } finally {
      starting = false;
    }
  };

  const loadEngine = async (params: unknown): Promise<[EngineKind, EngineModule]> => {
    if (!isObject(params)) throw new HelperError("bad_request", "missing params");
    if (params.protocol !== PROTOCOL_VERSION) {
      throw new HelperError("bad_request", `unsupported protocol ${String(params.protocol)}`);
    }
    const engine = params.engine;
    if (typeof engine !== "string" || !(ENGINE_KINDS as ReadonlyArray<string>).includes(engine)) {
      throw new HelperError("bad_request", `unknown engine ${String(engine)}`);
    }
    try {
      return [engine as EngineKind, await options.engines[engine as EngineKind]()];
    } catch (cause) {
      throw new HelperError("unavailable", `${engine} SDK could not be loaded: ${errorMessage(cause)}`);
    }
  };

  const probe = async (params: unknown) => {
    const [engine, module] = await loadEngine(params);
    if (module.probe === undefined) throw new HelperError("unavailable", `${engine} has no probe`);
    return module.probe(params as unknown as ProbeParams, host);
  };

  const dispatch = async (frame: RequestFrame): Promise<unknown> => {
    const params = isObject(frame.params) ? frame.params : {};
    switch (frame.method) {
      case "initialize":
        return initialize(frame.params);
      case "probe":
        return probe(frame.params);
      case "turn.start":
        return requireSession().startTurn(
          (params.inputs ?? []) as never,
          params.settings as never,
        );
      case "turn.steer":
        return requireSession().steer(String(params.turnId ?? ""), (params.inputs ?? []) as never);
      case "turn.continue": {
        const current = requireSession();
        if (current.startContinuation === undefined) {
          return { status: "declined", reason: "this engine does not offer continuations" };
        }
        return current.startContinuation(String(params.key ?? ""), (params.inputs ?? []) as never, params.settings as never);
      }
      case "turn.interrupt":
        await requireSession().interrupt(String(params.turnId ?? ""));
        return {};
      case "request.answer":
        await requireSession().answerRequest(String(params.key ?? ""), params.answer as never);
        return {};
      case "session.set_config": {
        const current = requireSession();
        if (current.setConfig === undefined) {
          throw new HelperError("unsupported", "this engine cannot change model or runtime mode inside a session");
        }
        if (!isObject(params.settings)) throw new HelperError("bad_request", "missing settings");
        await current.setConfig(params.settings as never);
        return {};
      }
      case "shutdown":
        await stopSession();
        return {};
      default:
        throw new HelperError("bad_request", `unknown method ${frame.method}`);
    }
  };

  const stopSession = async () => {
    const current = session;
    if (current === undefined) return;
    const grace = options.shutdownGraceMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      current.shutdown().catch((cause) => log("warn", `engine shutdown failed: ${errorMessage(cause)}`)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };

  const handleLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || ended) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      log("warn", `dropping non-JSON line (${line.length} chars)`);
      return;
    }
    if (!isObject(frame) || typeof frame.id !== "number" || typeof frame.method !== "string") {
      log("warn", `dropping frame without id/method (${line.length} chars)`);
      return;
    }
    const request = frame as RequestFrame;
    dispatch(request).then(
      (result) => {
        if (request.method === "shutdown") {
          if (ended) return;
          ended = true;
          send({ id: request.id, result }, () => options.exit(0));
          return;
        }
        respond(request.id, result);
      },
      (cause) => respondError(request.id, cause),
    );
  };

  const close = async () => {
    if (ended) return;
    await stopSession();
    if (ended) return;
    ended = true;
    options.exit(0);
  };

  return { handleLine, close, fail, log };
}

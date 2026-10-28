// @effect-diagnostics globalDate:off globalTimers:off preferSchemaOverJson:off - This isolated child uses a hard wall deadline and JSON pipe frames.
import * as NodeReadline from "node:readline";
import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";
import {
  ScreenRunBoot,
  ScreenRunCell,
  ScreenHostReply,
  type ScreenHostCall,
  type ScreenRunResult,
  ScreenRunError,
} from "@goat/contracts";
import { checkedScreenWasm } from "./ScreenRuntimeAsset.ts";
import { cellProgram } from "./ScreenCellScope.ts";
import { screenBytes, screenRunLimits } from "./ScreenRunLimits.ts";

// Both packages stay external; a single-executable resolves them from disk only through require.
const requireForQuickJS = NodeModule.createRequire(import.meta.url);
const { newQuickJSWASMModuleFromVariant, newVariant } = requireForQuickJS(
  "quickjs-emscripten-core",
) as typeof import("quickjs-emscripten-core");
const BellardSync = (
  requireForQuickJS("@jitl/quickjs-wasmfile-release-sync") as {
    default: typeof import("@jitl/quickjs-wasmfile-release-sync").default;
  }
).default;
const isScreenRunError = Schema.is(ScreenRunError);

const decodeUnknownScreenRunCell = Schema.decodeUnknownSync(ScreenRunCell);
const decodeUnknownScreenHostReply = Schema.decodeUnknownSync(ScreenHostReply);

const decodeUnknownScreenRunBoot = Schema.decodeUnknownSync(ScreenRunBoot);

const BOOT_MAX = 16 * 1024;
const FRAME_MAX = 96 * 1024;
const methods = [
  "list_apps",
  "list_windows",
  "bind_app",
  "get_window_state",
  "get_accessibility_tree",
  "verify_state",
  "screenshot",
  "click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "launch_app",
  "end_foreground",
  "list_tabs",
  "select_tab",
  "open_tab",
  "claim_tab",
  "keep_tab",
  "navigate_tab",
  "reload_tab",
  "back_tab",
  "forward_tab",
  "close_tab",
  "observe",
  "tab_status",
  "read_page",
  "select",
  "select_text",
  "wait_for",
] as const;

type ChildResult = Pick<
  ScreenRunResult,
  "cellId" | "status" | "value" | "console" | "truncated"
> & {
  t: "result";
  error?: ScreenRunResult["error"];
  unawaitedCallIds?: number[];
};

/** This entry accepts only parent-authenticated pipe frames and holds no GOAT credentials. */
export async function runScreenChild(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || screenBytes(first.value) > BOOT_MAX)
    throw new Error("Invalid screen child boot");
  const boot = decodeUnknownScreenRunBoot(JSON.parse(first.value));
  const limits = screenRunLimits(boot.limits);
  const { bytes } = await checkedScreenWasm(boot.wasmPath, boot.wasmSha256);
  const Wasm = Reflect.get(globalThis, "WebAssembly") as {
    Memory: new (input: { initial: number; maximum: number }) => { readonly buffer: ArrayBuffer };
  };
  const wasmMemory = new Wasm.Memory({
    initial: 256,
    maximum: Math.floor(limits.turnWasmBytes / (64 * 1024)),
  });
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(BellardSync as unknown as Parameters<typeof newVariant>[0], {
      wasmMemory: wasmMemory as Parameters<typeof newVariant>[1]["wasmMemory"],
      wasmBinary: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    }) as Parameters<typeof newQuickJSWASMModuleFromVariant>[0],
  );
  if (module.getWasmMemory() !== wasmMemory) throw new Error("QuickJS ignored fixed WASM memory");
  let currentLimits = limits;
  let runtime = module.newRuntime();
  let vm = runtime.newContext();
  runtime.setMemoryLimit(limits.heapBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let runId = "";
  let turnId = "";
  let cellId = "";
  let deadline = 0;
  let nextCallId = 0;
  let admitted = false;
  let callCount = 0;
  let consoleBytes = 0;
  let linesOut: string[] = [];
  let truncated: string[] = [];
  const pending = new Map<number, ReturnType<typeof vm.newPromise>>();
  const boundedMessage = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return bytes.length <= 1024 ? value : new TextDecoder().decode(bytes.slice(0, 1021));
  };
  const emit = (frame: unknown) => output.write(`${JSON.stringify(frame)}\n`);
  const initialize = () => {
    const host = vm.newFunction("__host", (methodHandle, argsHandle) => {
      const promise = vm.newPromise();
      const method = vm.getString(methodHandle);
      const argsJson = vm.getString(argsHandle);
      if (
        !admitted ||
        !methods.includes(method as (typeof methods)[number]) ||
        ++callCount > currentLimits.callsPerCell ||
        pending.size >= currentLimits.pendingCalls ||
        screenBytes(argsJson) > currentLimits.argBytes
      ) {
        const error = vm.newString("screen call refused");
        promise.reject(error);
        error.dispose();
        return promise.handle;
      }
      const callId = ++nextCallId;
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        args = null;
      }
      const firstArg = Array.isArray(args) ? (args[0] as unknown) : undefined;
      const targetRef =
        typeof firstArg === "object" && firstArg !== null && "targetRef" in firstArg
          ? (firstArg.targetRef as ScreenHostCall["targetRef"])
          : undefined;
      const call: ScreenHostCall = {
        t: "call",
        runId,
        turnId,
        cellId,
        callId,
        ...(targetRef === undefined ? {} : { targetRef }),
        method: method as ScreenHostCall["method"],
        args: args as ScreenHostCall["args"],
        deadlineMillis: deadline,
      };
      pending.set(callId, promise);
      emit(call);
      return promise.handle;
    });
    vm.setProp(vm.global, "__host", host);
    host.dispose();
    const log = vm.newFunction("__log", (valueHandle) => {
      const line = vm.getString(valueHandle);
      const size = screenBytes(line);
      if (consoleBytes + size <= currentLimits.consoleBytes && linesOut.length < 64) {
        linesOut.push(line);
        consoleBytes += size;
      } else if (!truncated.includes("console")) truncated.push("console");
    });
    vm.setProp(vm.global, "__log", log);
    log.dispose();
    const setup = `var __screenValues = Object.create(null);
      const __values = new Proxy(__screenValues, {
        set(target, key, value) {
          const json = JSON.stringify(value);
          if (typeof key !== 'string' || json === undefined || json.length > 65536)
            throw new TypeError('screen.values accepts bounded JSON only');
          target[key] = JSON.parse(json);
          return true;
        }
      });
      const __call = async (method, arg) => JSON.parse(await __host(method, JSON.stringify([arg])));
      const __target = (binding) => {
        const ref = binding.targetRef ?? binding;
        const call = (method, arg = {}) => __call(method, { ...arg, targetRef: ref });
        const common = {
          targetRef: ref,
          observe: (arg = {}) => call(ref.kind === 'tab' ? 'observe' : 'get_accessibility_tree', arg),
          click: (arg = {}) => call('click', arg),
          rightClick: (arg = {}) => call('right_click', arg),
          drag: (arg = {}) => call('drag', arg),
          scroll: (arg = {}) => call('scroll', arg),
          selectText: (arg = {}) => call('select_text', arg),
          setValue: (arg = {}) => call('set_value', arg),
          pressKey: (arg = {}) => call('press_key', arg),
          typeText: (arg = {}) => call('type_text', arg),
          waitFor: (arg = {}) => call('wait_for', arg),
        };
        return Object.freeze(ref.kind === 'tab' ? {
          ...common,
          status: () => call('tab_status'),
          read: (arg = {}) => call('read_page', arg),
          claim: () => call('claim_tab'),
          keep: (reason = 'deliverable') => call('keep_tab', { reason }),
          navigate: (url) => call('navigate_tab', { url }),
          reload: () => call('reload_tab'),
          back: () => call('back_tab'),
          forward: () => call('forward_tab'),
          close: () => call('close_tab'),
          select: (arg = {}) => call('select', arg),
        } : {
          ...common,
          getWindowState: () => call('get_window_state'),
          verifyState: (arg = {}) => call('verify_state', arg),
          screenshot: (arg = {}) => call('screenshot', arg),
          bringToFront: () => call('bring_to_front'),
          endForeground: () => call('end_foreground'),
        });
      };
      globalThis.screen = Object.freeze({ values: __values, state: {},
        discover: async () => {
          const result = { apps: [], windows: [], tabs: [], unavailable: {} };
          try { result.apps = await __call('list_apps', {}); result.windows = await __call('list_windows', {}); }
          catch (error) { result.unavailable.desktop = String(error); }
          try { result.tabs = await __call('list_tabs', {}); }
          catch (error) { result.unavailable.browser = String(error); }
          return result;
        },
        app: async (query = {}) => __target(await __call('bind_app', query)),
        tab: async (query = {}) => __target(await __call('select_tab', query)),
        openTab: async (arg = {}) => __target(await __call('open_tab', arg)),
        listTabs: () => __call('list_tabs', {}),
        ${methods
          .map(
            (method) =>
              `${method}: async (...args) => JSON.parse(await __host(${JSON.stringify(method)}, JSON.stringify(args)))`,
          )
          .join(
            ",",
          )} }); globalThis.console = Object.freeze({log: (...args) => __log(args.map(String).join(" "))});
      {
        const own = new Set(Object.getOwnPropertyNames(globalThis));
        own.add('__screenKeep');
        // A kept name reads and writes the cell's own binding, so its closures and later cells
        // share one value. The probe runs under a throwing stand-in for the global, so a name that
        // is not a binding of the cell reaches neither a getter nor an inherited property.
        Object.defineProperty(globalThis, '__screenKeep', {
          value: (name, read, write) => {
            if (own.has(name)) return;
            const previous = Object.getOwnPropertyDescriptor(globalThis, name);
            if (previous && !previous.configurable) return;
            const absent = {};
            Object.defineProperty(globalThis, name, {
              get() { throw absent; }, set() { throw absent; }, configurable: true,
            });
            try { read(); } catch {
              delete globalThis[name];
              if (previous) Object.defineProperty(globalThis, name, previous);
              return;
            }
            Object.defineProperty(globalThis, name, {
              get: read,
              set: write ?? (() => { throw new TypeError('Assignment to constant variable.'); }),
              configurable: true,
              enumerable: true,
            });
          },
        });
      }`;
    const evaluated = vm.evalCode(setup);
    vm.unwrapResult(evaluated).dispose();
  };
  initialize();
  const reset = () => {
    for (const promise of pending.values()) promise.dispose();
    pending.clear();
    vm.dispose();
    runtime.dispose();
    runtime = module.newRuntime();
    vm = runtime.newContext();
    runtime.setMemoryLimit(limits.heapBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    initialize();
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: ChildResult) => {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    admitted = false;
    for (const promise of pending.values()) promise.dispose();
    pending.clear();
    emit(result);
    cellId = "";
  };
  try {
    for await (const raw of { [Symbol.asyncIterator]: () => iterator }) {
      if (screenBytes(raw) > FRAME_MAX) throw new Error("Screen child frame exceeds cap");
      const frame: unknown = JSON.parse(raw);
      if (typeof frame !== "object" || frame === null || !("t" in frame))
        throw new Error("Invalid frame");
      if (frame.t === "reply") {
        const reply = decodeUnknownScreenHostReply(frame);
        if (reply.runId !== runId || reply.cellId !== cellId) continue;
        const promise = pending.get(reply.callId);
        if (!promise) continue;
        pending.delete(reply.callId);
        const value = vm.newString(
          JSON.stringify(reply.outcome === "ok" ? reply.value : reply.error),
        );
        if (reply.outcome === "ok") promise.resolve(value);
        else promise.reject(value);
        value.dispose();
        promise.dispose();
        runtime.executePendingJobs();
        continue;
      }
      if (frame.t === "cancel") {
        admitted = false;
        continue;
      }
      if (frame.t !== "cell" || cellId) throw new Error("Unexpected child frame");
      const cell = decodeUnknownScreenRunCell(frame);
      currentLimits = screenRunLimits(cell.limits);
      if (screenBytes(cell.source) > currentLimits.sourceBytes)
        throw new Error("Source cap exceeded");
      if (cell.resetValues) reset();
      runtime.setMemoryLimit(currentLimits.heapBytes);
      runtime.setMaxStackSize(currentLimits.stackBytes);
      runId = cell.runId;
      turnId = cell.turnId;
      cellId = cell.cellId;
      nextCallId = 0;
      callCount = 0;
      consoleBytes = 0;
      linesOut = [];
      truncated = [];
      deadline = cell.deadlineMillis;
      // Starting the child can use up a short cell's wall time; such a cell never runs.
      if (Date.now() >= deadline) {
        finish({ t: "result", cellId, status: "deadline", console: linesOut, truncated });
        continue;
      }
      admitted = true;
      runtime.setInterruptHandler(() => Date.now() >= deadline);
      deadlineTimer = setTimeout(
        () => {
          if (cellId === cell.cellId)
            finish({
              t: "result",
              cellId,
              status: "deadline",
              console: linesOut,
              truncated,
              unawaitedCallIds: [...pending.keys()],
            });
        },
        Math.max(0, deadline - Date.now()),
      );
      try {
        const evaluation = vm.evalCode(cellProgram(cell.source));
        const handle = vm.unwrapResult(evaluation);
        const settled = vm.resolvePromise(handle);
        handle.dispose();
        runtime.executePendingJobs();
        void settled
          .then(
            (outcome) => {
              if (cellId !== cell.cellId) {
                (outcome.error ?? outcome.value)?.dispose();
                return;
              }
              if (outcome.error) {
                const dumped = vm.dump(outcome.error);
                outcome.error.dispose();
                let error: ScreenRunResult["error"];
                if (typeof dumped === "string" && screenBytes(dumped) <= 16 * 1024) {
                  try {
                    const candidate: unknown = JSON.parse(dumped);
                    if (isScreenRunError(candidate)) error = candidate;
                  } catch {
                    /* An ordinary guest exception has no host error receipt. */
                  }
                }
                if (!error) {
                  const guest =
                    typeof dumped === "object" && dumped !== null
                      ? (dumped as Record<string, unknown>)
                      : {};
                  error = {
                    name: typeof guest.name === "string" ? guest.name.slice(0, 80) : "Error",
                    message:
                      typeof guest.message === "string"
                        ? boundedMessage(guest.message)
                        : boundedMessage(String(dumped)),
                  };
                }
                finish({
                  t: "result",
                  cellId,
                  status:
                    Date.now() >= deadline
                      ? "deadline"
                      : "message" in error && /out of memory|allocation failed/i.test(error.message)
                        ? "resource_exhausted"
                        : "failed",
                  ...(error ? { error } : {}),
                  ...(pending.size ? { unawaitedCallIds: [...pending.keys()] } : {}),
                  console: linesOut,
                  truncated,
                });
                return;
              }
              const resultHandle = vm.unwrapResult(outcome);
              const value = vm.dump(resultHandle) as unknown;
              resultHandle.dispose();
              const json = JSON.stringify(value);
              const bounded =
                json === undefined || screenBytes(json) > currentLimits.returnBytes
                  ? undefined
                  : value;
              if (json !== undefined && bounded === undefined) truncated.push("value");
              finish({
                t: "result",
                cellId,
                status: pending.size ? "failed" : "completed",
                ...(pending.size ? { unawaitedCallIds: [...pending.keys()] } : {}),
                ...(bounded === undefined
                  ? {}
                  : { value: bounded as NonNullable<ScreenRunResult["value"]> }),
                console: linesOut,
                truncated,
              });
            },
            () => finish({ t: "result", cellId, status: "failed", console: linesOut, truncated }),
          )
          .catch(() => {
            if (cellId === cell.cellId)
              finish({
                t: "result",
                cellId,
                status: Date.now() >= deadline ? "deadline" : "failed",
                console: linesOut,
                truncated,
              });
          });
      } catch {
        finish({
          t: "result",
          cellId,
          status: Date.now() >= deadline ? "deadline" : "failed",
          console: linesOut,
          truncated,
        });
      }
    }
  } finally {
    lines.close();
    for (const promise of pending.values()) promise.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

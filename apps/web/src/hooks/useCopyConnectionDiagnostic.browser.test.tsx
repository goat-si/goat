import { EnvironmentId, type SshHostResult, type SshHostStatus } from "@goat/contracts";
import { SshConnectionProfile, SshConnectionTarget } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const copied = vi.hoisted(() => vi.fn());
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: copied }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));
vi.mock("../state/sshRuntime", async () => {
  const { Atom } = await import("effect/reactivity");
  const status = Atom.make<SshHostResult | null>(null).pipe(Atom.keepAlive);
  return { sshRuntime: { statusAtom: () => status } };
});

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { sshRuntime } from "../state/sshRuntime";
import type { EnvironmentPresentation } from "../state/environments";
import { useCopyConnectionDiagnostic } from "./useCopyConnectionDiagnostic";

const environmentId = EnvironmentId.make("diagnostic-host");
const target = { alias: "test-host", hostname: "host.example.test", username: null, port: null };
const runtimeAtom = sshRuntime.statusAtom({ environmentId, target });
const environment: EnvironmentPresentation = {
  environmentId,
  label: "Test host",
  displayUrl: null,
  relayManaged: false,
  serverConfig: null,
  entry: {
    enabled: true,
    target: new SshConnectionTarget({ environmentId, label: "Test host", connectionId: "ssh" }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId,
        label: "Test host",
        connectionId: "ssh",
        target,
      }),
    ),
  },
  connection: {
    phase: "error",
    error: "Connection error evidence",
    traceId: null,
    failure: { kind: "retrying", reason: "transport", detail: "Connection failure evidence" },
  },
};

function status(state: SshHostStatus["state"], detail = "Runtime status evidence"): SshHostStatus {
  return { host: target.alias, state, detail, runtimeVersion: "1.0.0", requestedVersion: "1.0.0" };
}

let root: Root;
let container: HTMLDivElement;
let renders: number;
function CopyButton({ value }: { value: EnvironmentPresentation }) {
  useLayoutEffect(() => {
    renders += 1;
  });
  const copy = useCopyConnectionDiagnostic(value);
  return <button onClick={copy}>Copy</button>;
}
function render(value = environment) {
  act(() =>
    root.render(
      <AppAtomRegistryProvider>
        <CopyButton value={value} />
      </AppAtomRegistryProvider>,
    ),
  );
}
function copy() {
  act(() => container.querySelector("button")!.click());
  return copied.mock.calls.at(-1)?.[0] as string;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  appAtomRegistry.set(runtimeAtom, null);
  copied.mockClear();
  renders = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("copy connection diagnostic", () => {
  it("does not rerender its consumer when the runtime cache changes", () => {
    render();
    const initialRenders = renders;
    act(() => appAtomRegistry.set(runtimeAtom, { kind: "ok", status: status("failed") }));
    expect(renders).toBe(initialRenders);
  });

  it("reads current runtime evidence when a retained copy action is clicked", () => {
    render();
    act(() =>
      appAtomRegistry.set(runtimeAtom, {
        kind: "error",
        code: "operation_failed",
        message: "Latest runtime error",
      }),
    );
    expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Latest runtime error");
  });

  it("prefers the runtime error message over its stale status detail", () => {
    appAtomRegistry.set(runtimeAtom, {
      kind: "error",
      code: "operation_failed",
      message: "Current operation error",
      status: status("failed"),
    });
    render();
    expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Current operation error");
  });

  it.each(["failed", "auth_failed", "untrusted"] as const)(
    "prefers %s runtime failure evidence",
    (state) => {
      appAtomRegistry.set(runtimeAtom, { kind: "ok", status: status(state) });
      render();
      expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Runtime status evidence");
    },
  );

  it.each([
    "ready",
    "preparing",
    "stopped",
    "trust_pending",
    "update_waiting",
    "update_blocked",
    "providers_not_ready",
  ] as const)("prefers connection failure evidence over %s runtime details", (state) => {
    appAtomRegistry.set(runtimeAtom, { kind: "ok", status: status(state) });
    render();
    expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Connection failure evidence");
  });

  it("falls back to connection error, then runtime detail", () => {
    appAtomRegistry.set(runtimeAtom, { kind: "ok", status: status("ready") });
    render({
      ...environment,
      connection: { phase: "error", error: "Connection error evidence", traceId: null },
    });
    expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Connection error evidence");
    render({ ...environment, connection: { phase: "connected", error: null, traceId: null } });
    expect(copy().split("Public diagnostic tail:\n")[1]).toBe("Runtime status evidence");
  });
});

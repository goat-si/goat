import { AuthMcpApprovalDecisionRequest, type AuthMcpApprovalDetails } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const calls = vi.hoisted(() => ({
  details: {} as AuthMcpApprovalDetails,
  requests: [] as Array<typeof AuthMcpApprovalDecisionRequest.Type>,
}));
vi.mock("~/environments/primary/httpClient", () => ({
  PrimaryEnvironmentHttpClient: Context.Service("test/oauth-client"),
}));
vi.mock("~/lib/runtime", async () => {
  const { PrimaryEnvironmentHttpClient } = await import("~/environments/primary/httpClient");
  const decodeDecision = Schema.decodeUnknownEffect(AuthMcpApprovalDecisionRequest);
  return {
    runPrimaryHttp: (effect: Effect.Effect<unknown, Error, never>) =>
      // eslint-disable-next-line goat/no-manual-effect-runtime-in-tests -- Mock the production Promise bridge; React drives the actual consent state machine.
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(PrimaryEnvironmentHttpClient, {
            mcpOAuth: {
              approval: () => Effect.succeed(calls.details),
              decision: ({ payload }: { payload: unknown }) =>
                decodeDecision(payload).pipe(
                  Effect.map((decoded) => {
                    calls.requests.push(decoded);
                    return { redirectTo: "https://agent.example/callback" };
                  }),
                ),
            },
          } as unknown as Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>),
        ),
      ),
  };
});

import { ConnectAgentSurface } from "./ConnectAgentSurface";

let root: Root;
let container: HTMLDivElement;
const redirect = vi.fn<(url: string) => void>();

const memoryCheckbox = (name: "Read memory" | "Write memory") =>
  page.getByRole("checkbox", { name });
const pairingCode = () => page.getByRole("textbox", { name: "Pairing code" });
const approveButton = () => page.getByRole("button", { name: "Approve" });

async function mount() {
  await act(async () => root.render(<ConnectAgentSurface redirect={redirect} />));
  await expect.element(approveButton()).toBeInTheDocument();
}
async function pair() {
  await userEvent.fill(pairingCode(), "synthetic-pairing-code");
}
async function chooseFullAccess() {
  await userEvent.click(page.getByRole("radio", { name: /^Full access/ }));
}
async function approve() {
  await userEvent.click(approveButton());
  await vi.waitFor(() => expect(calls.requests).toHaveLength(1));
}

beforeEach(() => {
  calls.requests = [];
  calls.details = {
    clientName: "Synthetic agent",
    redirectHost: "agent.example",
    environmentHost: "host",
  };
  redirect.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ConnectAgentSurface memory consent", () => {
  it.each([false, true])(
    "keeps default memory scopes empty (browser-session=%s)",
    async (browser) => {
      if (browser)
        calls.details = {
          ...calls.details,
          csrfToken: "synthetic-csrf",
          oneClickAccess: ["read-only", "full-access"],
          oneClickMemoryScopes: ["memory:read", "memory:write"],
        };
      await mount();
      await chooseFullAccess();
      await expect.element(memoryCheckbox("Read memory")).not.toBeChecked();
      await expect.element(memoryCheckbox("Write memory")).not.toBeChecked();
      if (!browser) await pair();
      await approve();
      expect(calls.requests[0]?.decision).toMatchObject({
        _tag: browser ? "browser-session" : "pairing-code",
        access: "full-access",
        memoryScopes: [],
      });
      await vi.waitFor(() =>
        expect(redirect).toHaveBeenCalledWith("https://agent.example/callback"),
      );
    },
  );

  it.each([false, true])(
    "grants only explicit final selection (browser-session=%s)",
    async (browser) => {
      if (browser)
        calls.details = {
          ...calls.details,
          csrfToken: "synthetic-csrf",
          oneClickAccess: ["read-only"],
          oneClickMemoryScopes: ["memory:read", "memory:write"],
        };
      await mount();
      await userEvent.click(memoryCheckbox("Read memory"));
      await userEvent.click(memoryCheckbox("Write memory"));
      await userEvent.click(memoryCheckbox("Read memory"));
      if (!browser) await pair();
      await approve();
      expect(calls.requests[0]?.decision).toMatchObject({
        _tag: browser ? "browser-session" : "pairing-code",
        memoryScopes: ["memory:write"],
      });
    },
  );

  it("requires pairing when any selected scope is outside the browser's full union", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
      oneClickMemoryScopes: ["memory:read"],
    };
    await mount();
    await userEvent.click(memoryCheckbox("Read memory"));
    await userEvent.click(memoryCheckbox("Write memory"));
    await expect.element(approveButton()).toBeDisabled();
    await pair();
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "pairing-code",
      memoryScopes: ["memory:read", "memory:write"],
    });
  });

  it("restores one-click eligibility when an ungrantable selection is cleared", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
    };
    await mount();
    await userEvent.click(memoryCheckbox("Write memory"));
    await expect.element(pairingCode()).toBeInTheDocument();
    await userEvent.click(memoryCheckbox("Write memory"));
    await expect.element(pairingCode()).not.toBeInTheDocument();
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "browser-session",
      memoryScopes: [],
    });
  });

  it("requires pairing when thread access is outside the full union even if memory scopes are held", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
      oneClickMemoryScopes: ["memory:read", "memory:write"],
    };
    await mount();
    await userEvent.click(memoryCheckbox("Read memory"));
    await chooseFullAccess();
    await expect.element(approveButton()).toBeDisabled();
    await pair();
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "pairing-code",
      access: "full-access",
      memoryScopes: ["memory:read"],
    });
  });

  it("denies without granting selected scopes", async () => {
    await mount();
    await userEvent.click(memoryCheckbox("Read memory"));
    await userEvent.click(page.getByRole("button", { name: "Deny" }));
    await vi.waitFor(() => expect(calls.requests).toHaveLength(1));
    expect(calls.requests[0]?.decision).toEqual({ _tag: "deny" });
  });
});

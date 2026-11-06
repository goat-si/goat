import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  allowed: true,
  writable: { remote: true, other: true } as Record<string, boolean>,
  calls: [] as Array<{ kind: string; environmentId: string; input: unknown }>,
  createGate: null as Promise<void> | null,
  newLinkInSnapshot: false,
}));
vi.mock(import("../../state/session"), async (original) => {
  const Option = await import("effect/Option");
  return {
    ...(await original()),
    useEnvironmentScope: (() => state.allowed) as never,
    readEnvironmentScope: ((id: string, scope: string) =>
      scope === "access:write" ? state.writable[id] === true : state.allowed) as never,
    useEnvironmentSessionState: (() => ({
      isPending: false,
      hasError: false,
      data: {
        authenticated: true,
        scopes: state.allowed ? ["orchestration:read", "access:write"] : ["access:write"],
        permissions: state.allowed
          ? ["orchestration:read", "filesystem:read", "access:write"]
          : ["access:write"],
      },
    })) as never,
    usePreparedConnection: (() => Option.none()) as never,
  };
});
vi.mock(import("../../state/auth"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const command = (kind: string) => ({
    kind,
    permissionAtom: (id: string) => Atom.make(state.writable[id] === true),
  });
  return {
    ...(await original()),
    authEnvironment: {
      accessChanges: (target: unknown) => target,
      createPairing: command("create"),
      revokePairing: command("pair"),
      revokeClient: command("client"),
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { AsyncResult } = await import("effect/reactivity");
  const DateTime = await import("effect/DateTime");
  return {
    ...(await original()),
    useAtomCommand: ((command: { kind: string }) =>
      async (target: { environmentId: string; input: unknown }) => {
        state.calls.push({ kind: command.kind, ...target });
        if (command.kind === "create" && state.createGate) await state.createGate;
        return AsyncResult.success(
          command.kind === "create"
            ? {
                id: "new-link",
                label: "Created link",
                credential: "test-pairing-code",
                expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
              }
            : { revoked: true },
        );
      }) as never,
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const DateTime = await import("effect/DateTime");
  const issuedAt = DateTime.makeUnsafe("2025-01-01T00:00:00Z");
  const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00Z");
  return {
    ...(await original()),
    useEnvironmentQuery: ((query: unknown) => ({
      data:
        query === null
          ? null
          : {
              type: "snapshot",
              payload: {
                pairingLinks: [
                  {
                    id: "pair",
                    label: "Laptop link",
                    subject: "one-time-token",
                    scopes: ["orchestration:read"],
                    createdAt: issuedAt,
                    expiresAt,
                  },
                  ...(state.newLinkInSnapshot
                    ? [
                        {
                          id: "new-link",
                          label: "Created link",
                          subject: "one-time-token",
                          scopes: ["orchestration:read"],
                          createdAt: issuedAt,
                          expiresAt,
                        },
                      ]
                    : []),
                ],
                clientSessions: [
                  {
                    sessionId: "session",
                    subject: "client",
                    scopes: ["orchestration:read"],
                    client: {
                      label:
                        (query as { environmentId: string }).environmentId === "other"
                          ? "Other browser"
                          : "Office browser",
                      deviceType: "desktop",
                    },
                    connected: true,
                    current: false,
                    issuedAt,
                    expiresAt,
                    lastConnectedAt: null,
                  },
                ],
              },
            },
      isPending: false,
      error: null,
    })) as never,
  };
});
vi.mock(import("../../localEnvironment"), async (original) => ({
  ...(await original()),
  isLocalEnvironmentDisabled: () => true,
}));
vi.mock("./LocalEnvironmentSetting", () => ({ LocalEnvironmentSetting: () => null }));
vi.mock("./HeadlessServerSetting", () => ({ HeadlessServerSetting: () => null }));
import { NoLocalEnvironmentSettings, SavedEnvironmentAccess } from "./SavedEnvironmentAccess";

function setup() {
  state.allowed = true;
  state.writable = { remote: true, other: true };
  state.calls = [];
  state.createGate = null;
  state.newLinkInSnapshot = false;
}
const environments = ["remote", "other"].map((id) => ({
  environmentId: EnvironmentId.make(id),
  label: id === "remote" ? "Remote" : "Other",
  entry: { enabled: true },
  connection: { phase: "connected" },
}));

it("shows a connected saved environment's service access with read permission", async () => {
  setup();
  await using screen = await render(
    <SavedEnvironmentAccess
      environmentId={EnvironmentId.make("remote")}
      label="Remote"
      connected
    />,
  );
  await expect.element(screen.getByText("Laptop link")).toBeVisible();
  await expect.element(screen.getByText("Office browser")).toBeVisible();
});

it("does not expose access records without the environment's read permission", async () => {
  setup();
  state.allowed = false;
  await using screen = await render(
    <SavedEnvironmentAccess
      environmentId={EnvironmentId.make("remote")}
      label="Remote"
      connected
    />,
  );
  await expect.element(screen.getByText(/does not have permission/)).toBeVisible();
  await expect.element(screen.getByText("Office browser")).not.toBeInTheDocument();
});

it("shows saved server access when Local is disabled", async () => {
  setup();
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={environments as never}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  await expect.element(screen.getByText("Local environment is off")).toBeVisible();
  await expect.element(screen.getByText("Office browser")).toBeVisible();
});

it("routes create and revocations to the selected saved environment", async () => {
  setup();
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={environments as never}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  await screen.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Other" }).click();
  await expect.element(screen.getByText("Other browser")).toBeVisible();
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Revoke", exact: true }).nth(0).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).nth(1).click();
  await screen.getByRole("button", { name: "Create link" }).click();
  page.getByRole("dialog").getByRole("button", { name: "Create link" }).element().focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(state.calls.map(({ kind, environmentId }) => [kind, environmentId])).toEqual([
      ["pair", "other"],
      ["client", "other"],
      ["create", "other"],
    ]),
  );
  expect(state.calls.find((call) => call.kind === "create")?.input).toEqual({
    scopes: ["orchestration:read", "filesystem:read", "access:write"],
  });
});

it("does not offer mutations without the selected environment's access-write grant", async () => {
  setup();
  state.writable.other = false;
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={environments as never}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  await screen.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Other" }).click();
  await expect.element(screen.getByRole("button", { name: "Create link" })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Revoke", exact: true }).nth(0))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Revoke", exact: true }).nth(1))
    .toBeDisabled();
  expect(state.calls).toEqual([]);
});

it("keeps the newly created code available with write-only access", async () => {
  setup();
  state.allowed = false;
  await using screen = await render(
    <SavedEnvironmentAccess
      environmentId={EnvironmentId.make("remote")}
      label="Remote"
      connected
    />,
  );
  await screen.getByRole("button", { name: "Create link" }).click();
  page.getByRole("dialog").getByRole("button", { name: "Create link" }).element().focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(state.calls.some((call) => call.kind === "create")).toBe(true));
  await expect.element(screen.getByRole("button", { name: /Copy code|Show code/ })).toBeVisible();
});

it("keeps the selected environment fixed while a pairing request is pending", async () => {
  setup();
  let release = () => {};
  state.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={environments as never}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  const picker = screen.getByRole("combobox", { name: "Environment" }).element();
  try {
    await screen.getByRole("button", { name: "Create link" }).click();
    page.getByRole("dialog").getByRole("button", { name: "Create link" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(picker.hasAttribute("disabled")).toBe(true));
    release();
    await vi.waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
  } finally {
    release();
  }
});

it("shows a one-time code while the pairing list follows server snapshots", async () => {
  setup();
  let release = () => {};
  state.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const content = () => (
    <SavedEnvironmentAccess environmentId={EnvironmentId.make("remote")} label="Remote" connected />
  );
  await using screen = await render(content());
  try {
    await screen.getByRole("button", { name: "Create link" }).click();
    page.getByRole("dialog").getByRole("button", { name: "Create link" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(state.calls.some((call) => call.kind === "create")).toBe(true));
    state.newLinkInSnapshot = true;
    await screen.rerender(content());
    await expect.element(screen.getByText("Created link", { exact: true })).toBeVisible();
    state.newLinkInSnapshot = false;
    await screen.rerender(content());
    release();
    await expect
      .element(screen.getByRole("textbox", { name: "Pairing code" }))
      .toHaveValue("test-pairing-code");
    await expect.element(screen.getByText("Created link", { exact: true })).not.toBeInTheDocument();
    state.newLinkInSnapshot = true;
    await screen.rerender(content());
    await expect.element(screen.getByText("Created link", { exact: true })).toBeVisible();
    state.newLinkInSnapshot = false;
    await screen.rerender(content());
    await expect.element(screen.getByText("Created link", { exact: true })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Done" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Pairing code" }))
      .not.toBeInTheDocument();
  } finally {
    release();
  }
});

import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  attach: vi.fn(),
  reissue: vi.fn(),
  detach: vi.fn(),
  release: vi.fn(),
  hub: undefined as unknown,
  // When set, the machine list answers with this atom instead of an empty list.
  list: undefined as unknown,
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => state.hub }));
vi.mock("~/state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const permissionAtom = () => Atom.make(true);
  const machines = Atom.make(AsyncResult.success({ machines: [] }));
  return {
    serverEnvironment: {
      updateSettings: { label: "settings", run: state.save, permissionAtom },
      hubMachinesAttach: { label: "attach", run: state.attach, permissionAtom },
      hubMachinesReissue: { label: "reissue", run: state.reissue, permissionAtom },
      hubMachinesDetach: { label: "detach", run: state.detach, permissionAtom },
      hubMachinesRelease: { label: "release", run: state.release, permissionAtom },
      hubMachinesList: () => state.list ?? machines,
    },
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: string;
    description: ReactNode;
    control: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {children}
    </div>
  ),
}));
import { DisposableMachinesSettings } from "./DisposableMachinesSettings";

const environmentId = EnvironmentId.make("test-hub");
const NOW = Date.parse("2026-11-14T00:00:00.000Z");
// An open consent ends within the hub's 30 days; one with no end reads as ended.
const OPEN_UNTIL = new Date(NOW + 10 * 86_400_000).toISOString();
function setup(enabled: boolean, expiresAt: string | null = enabled ? OPEN_UNTIL : null) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.list = undefined;
  state.hub = {
    ...DEFAULT_SERVER_SETTINGS.hub,
    enabled: true,
    attachDisposableMachines: {
      ...DEFAULT_SERVER_SETTINGS.hub.attachDisposableMachines,
      enabled,
      expiresAt,
    },
  };
  // An older hub drops the switch from the patch and answers with it off.
  state.save.mockReset().mockResolvedValue({ _tag: "Success", value: DEFAULT_SERVER_SETTINGS });
  state.attach.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { invite: { token: "secret-token", expiresAt: "2026-12-01T00:00:00.000Z" } },
  });
  state.reissue.mockReset();
  state.detach.mockReset();
  state.release.mockReset();
  const registry = AtomRegistry.make();
  return {
    registry,
    [Symbol.dispose]: () => {
      registry.dispose();
      clock.mockRestore();
    },
  };
}

it("saves disposable machine consent, describes Pen access, and names an older hub", async () => {
  using fixture = setup(false);
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await expect
    .element(screen.getByText(/may admit up to 10 machines to your Pen mesh/))
    .toBeVisible();
  await userEvent.click(screen.getByRole("switch", { name: "Attach disposable machines" }));
  expect(state.save).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: { patch: { hub: { attachDisposableMachines: { enabled: true } } } },
  });
  await expect.element(screen.getByText(/kept this switch off/)).toBeVisible();
});

it("shows the invite once and clears it when the attach dialog closes", async () => {
  using fixture = setup(true);
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Attach a machine" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Machine name" }), "cloud-a");
  await userEvent.type(screen.getByRole("textbox", { name: "Signing public key" }), "sign");
  await userEvent.type(screen.getByRole("textbox", { name: "Noise public key" }), "noise");
  await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
  await expect.element(screen.getByText("secret-token")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Close", exact: true }).first());
  await userEvent.click(screen.getByRole("button", { name: "Attach a machine" }));
  await expect.element(screen.getByText("secret-token")).not.toBeInTheDocument();
});

it("an expired consent offers a renewal and holds Attach until a person renews", async () => {
  using fixture = setup(true, "2020-01-01T00:00:00.000Z");
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await expect.element(screen.getByText(/Consent ended/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Attach a machine" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Renew for 30 days" }));
  expect(state.save).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: { patch: { hub: { attachDisposableMachines: { expiresAt: expect.any(String) } } } },
  });
});

it("pasting the pen identity --json line fills both keys", async () => {
  using fixture = setup(true);
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Attach a machine" }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Output of pen identity --json" }),
    '{"nodeId":"n","signPub":"sign-key","noisePub":"noise-key"}',
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "Machine name" }), "cc-1");
  await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
  expect(state.attach).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: expect.objectContaining({ name: "cc-1", signPub: "sign-key", noisePub: "noise-key" }),
  });
});

it("a consent that ends while the page is open shows as ended on the next refresh", async () => {
  using fixture = setup(true);
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Attach a machine" })).toBeEnabled();
  vi.mocked(Date.now).mockReturnValue(NOW + 11 * 86_400_000);
  await userEvent.click(screen.getByRole("button", { name: "Refresh machines" }));
  await expect.element(screen.getByText(/Consent ended/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Attach a machine" })).toBeDisabled();
});

// What an older hub's unknown request becomes once the client maps it (rpc/client.ts).
it("an older hub without disposable machines shows Update GOAT instead of the settings", async () => {
  using fixture = setup(false);
  state.list = Atom.make(
    AsyncResult.failure(Cause.fail(new Error("Unknown request tag: hub.machines.list"))),
  );
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await expect
    .element(screen.getByText("Update GOAT on this hub to attach disposable machines."))
    .toBeVisible();
  await expect.element(screen.getByRole("switch")).not.toBeInTheDocument();
});

const row = (overrides: Record<string, unknown>) => ({
  attachId: "a-1",
  name: "cc-1",
  nodeId: "n1",
  state: "linked",
  step: "linked",
  steps: [],
  message: "cc-1 is linked to this hub's OpenCodex as a lightweight Child.",
  nextAction: null,
  class: "disposable",
  penMember: true,
  provisioner: { kind: "person" },
  stateSince: "2026-11-14T00:00:00.000Z",
  ...overrides,
});

it("detaches after a confirm, forces a detaching machine, and releases a slot Pen cannot account for", async () => {
  using fixture = setup(true);
  state.list = Atom.make(
    AsyncResult.success({
      machines: [
        row({}),
        row({ attachId: "a-2", name: "cc-2", state: "detaching", step: "detach" }),
        row({ attachId: "a-3", name: "cc-3", state: "unknown", step: null, penMember: false }),
      ],
    }),
  );
  state.detach.mockResolvedValue({ _tag: "Success", value: row({ state: "detaching" }) });
  state.release.mockResolvedValue({
    _tag: "Success",
    value: row({ attachId: "a-3", state: "failed" }),
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Detach cc-1" }));
  expect(state.detach).not.toHaveBeenCalled();
  // The confirmation says what a detach does and does not do.
  await expect
    .element(
      screen.getByText(/removes its OpenCodex link and the lightweight Child; it stays in Pen/),
    )
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Confirm detach cc-1" }));
  expect(state.detach).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: expect.objectContaining({ attachId: "a-1" }),
  });
  // A detaching row can be detached again, which clears a stop, or forced.
  await expect.element(screen.getByRole("button", { name: "Detach cc-2" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Force detach cc-2" }));
  await expect.element(screen.getByText(/removes the link without the machine/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Confirm force detach cc-2" }));
  expect(state.detach).toHaveBeenLastCalledWith(expect.anything(), {
    environmentId,
    input: expect.objectContaining({ attachId: "a-2", force: true }),
  });
  await expect.element(screen.getByRole("button", { name: "Detach cc-3" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Release cc-3" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm release cc-3" }));
  expect(state.release).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: expect.objectContaining({ attachId: "a-3" }),
  });
});

it("a detaching machine that left Pen says when its slot is free, for a detach and a force", async () => {
  using fixture = setup(true);
  state.list = Atom.make(
    AsyncResult.success({
      machines: [row({ state: "detaching", step: "detach", penMember: false })],
    }),
  );
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Detach cc-1" }));
  await expect
    .element(screen.getByText(/has left Pen; its slot is free once the detach ends/))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Force detach cc-1" }));
  await expect
    .element(screen.getByText(/has left Pen, so its slot is free once the detach ends/))
    .toBeVisible();
  await expect.element(screen.getByText(/stays in Pen/)).not.toBeInTheDocument();
});

it("a retired machine that left Pen offers the Detach its pending removal names", async () => {
  using fixture = setup(true);
  state.list = Atom.make(
    AsyncResult.success({
      machines: [row({ state: "retired", step: "recover", penMember: false })],
    }),
  );
  state.detach.mockResolvedValue({ _tag: "Success", value: row({ state: "detaching" }) });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Detach cc-1" }));
  await expect
    .element(screen.getByText(/has left Pen; its slot is free once the detach ends/))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Confirm detach cc-1" }));
  expect(state.detach).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: expect.objectContaining({ attachId: "a-1" }),
  });
});

it("a hub without detach says to update GOAT instead of a generic failure", async () => {
  using fixture = setup(true);
  state.list = Atom.make(AsyncResult.success({ machines: [row({})] }));
  state.detach.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Unknown request tag: hub.machines.detach")),
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DisposableMachinesSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Detach cc-1" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm detach cc-1" }));
  await expect
    .element(screen.getByText("Update GOAT on this hub to detach or release machines."))
    .toBeVisible();
});

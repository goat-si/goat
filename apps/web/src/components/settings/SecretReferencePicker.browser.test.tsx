import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const { state, checkSecretSource, checkSecretSourceCommand } = vi.hoisted(() => ({
  state: { capabilities: {} as { secretSourceCheck?: boolean | undefined } },
  checkSecretSource: vi.fn(async (_request: unknown) => ({
    _tag: "Success" as const,
    value: { _tag: "Resolved" } as { _tag: "Resolved" } | { _tag: "Failed"; detail: string },
  })),
  checkSecretSourceCommand: {},
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === checkSecretSourceCommand ? checkSecretSource : vi.fn()) as never,
}));
vi.mock(import("../../env"), () => ({ isSecretsFeatureEnabled: true, isElectron: false }));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, selector: (settings: unknown) => unknown) =>
    selector({
      secretProviders: {
        vault: { kind: "one_password", label: "Work", config: { account: "team" } },
      },
    })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({
    secretReferences: true,
    environment: { capabilities: state.capabilities },
  });
  const permitted = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => config) as never,
      checkSecretSource: Object.assign(checkSecretSourceCommand, {
        permissionAtom: () => permitted,
      }) as never,
    },
  };
});

import { SecretReferencePicker } from "./SecretReferencePicker";

const saved = { provider: "vault" as never, reference: "op://work/item/token" };

function setup(secretSourceCheck: boolean | undefined) {
  state.capabilities.secretSourceCheck = secretSourceCheck;
  checkSecretSource.mockClear();
}

describe("secret source", () => {
  it("checks a saved reference and says it was read without showing the value", async () => {
    setup(true);
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={saved}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await expect.element(screen.getByText(/^Read just now/)).toBeVisible();
    expect(checkSecretSource).toHaveBeenCalledExactlyOnceWith({
      environmentId: "fixture",
      input: { source: saved },
    });
  });

  it("shows why a saved reference could not be read", async () => {
    setup(true);
    checkSecretSource.mockResolvedValueOnce({
      _tag: "Success",
      value: { _tag: "Failed", detail: 'Could not read this secret from "Work".' },
    });
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={saved}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await expect.element(screen.getByText('Could not read this secret from "Work".')).toBeVisible();
  });

  it("says the server could not be reached when the check request fails", async () => {
    setup(true);
    checkSecretSource.mockResolvedValueOnce({ _tag: "Failure" } as never);
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={saved}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await expect.element(screen.getByText("Could not reach the server")).toBeVisible();
  });

  it("offers no check on a server that predates it", async () => {
    setup(undefined);
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={saved}
        onChange={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("textbox", { name: "Secret reference" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Check" }).query()).toBeNull();
    expect(checkSecretSource).not.toHaveBeenCalled();
  });

  it("shows how to repair a reference whose provider was removed", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={{ provider: "removed" as never, reference: "op://work/item/token" }}
        onChange={onChange}
      />,
    );
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("combobox", { name: "Secret source" }));
    await userEvent.click(screen.getByRole("option", { name: "Stored value" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("validates a 1Password reference before saving its selected source", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <SecretReferencePicker
        environmentId={EnvironmentId.make("fixture")}
        value={undefined}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Secret source" }));
    await userEvent.click(screen.getByRole("option", { name: "Work" }));
    const reference = screen.getByRole("textbox", { name: "Secret reference" });
    await userEvent.fill(reference, "wrong");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.fill(reference, "op://work/item/token");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({ provider: "vault", reference: "op://work/item/token" });
  });
});

import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

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
  const config = Atom.make({ secretReferences: true });
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});

import { SecretReferencePicker } from "./SecretReferencePicker";

describe("secret source", () => {
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

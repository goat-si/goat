import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ allowed: true }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.allowed,
  useEnvironmentSessionState: () => ({ isPending: false, hasError: false, data: null }),
}));
vi.mock(import("../../state/auth"), async (original) => ({
  ...(await original()),
  authEnvironment: { accessChanges: (target: unknown) => target } as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    data:
      query === null
        ? null
        : {
            type: "snapshot",
            payload: {
              pairingLinks: [{ id: "pair", label: "Laptop link" }],
              clientSessions: [
                {
                  sessionId: "session",
                  client: {
                    label:
                      (query as { environmentId: string }).environmentId === "other"
                        ? "Other browser"
                        : "Office browser",
                  },
                  connected: true,
                },
              ],
            },
          },
    isPending: false,
    error: null,
  })) as never,
}));
vi.mock(import("../../localEnvironment"), async (original) => ({
  ...(await original()),
  isLocalEnvironmentDisabled: () => true,
}));
vi.mock("./LocalEnvironmentSetting", () => ({ LocalEnvironmentSetting: () => null }));
vi.mock("./HeadlessServerSetting", () => ({ HeadlessServerSetting: () => null }));
import { NoLocalEnvironmentSettings, SavedEnvironmentAccess } from "./SavedEnvironmentAccess";

it("shows a connected saved environment's service access with read permission", async () => {
  state.allowed = true;
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

it("shows the saved server's access when Local is disabled", async () => {
  state.allowed = true;
  const environment = {
    environmentId: EnvironmentId.make("remote"),
    label: "Remote",
    entry: { enabled: true },
    connection: { phase: "connected" },
  };
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={[environment as never]}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  await expect.element(screen.getByText("Local environment is off")).toBeVisible();
  await expect.element(screen.getByText("Office browser")).toBeVisible();
});

it("switches the access view to the selected saved environment", async () => {
  state.allowed = true;
  const environments = ["remote", "other"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    label: id === "remote" ? "Remote" : "Other",
    entry: { enabled: true },
    connection: { phase: "connected" },
  }));
  await using screen = await render(
    <NoLocalEnvironmentSettings
      environments={environments as never}
      canReadRelay={false}
      canManageRelay={false}
    />,
  );
  await expect.element(screen.getByText("Office browser")).toBeVisible();
  await screen.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "Other" }).click();
  await expect.element(screen.getByText("Other browser")).toBeVisible();
  await expect.element(screen.getByText("Office browser")).not.toBeInTheDocument();
});

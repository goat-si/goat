import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { openHandoff: {}, answerSecretRequest: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
import { SecretRequestCard } from "./SecretRequestCard";

it("requires a username and masked password before saving a login", async () => {
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:login"),
    threadId: ThreadId.make("thread:login"),
    label: "Site login",
    reason: "Sign in",
    secretStatus: "pending",
    requestKind: "login",
    siteOrigin: "https://login.test",
  } as never;
  await using screen = await render(
    <SecretRequestCard environmentId={EnvironmentId.make("test")} item={item} visibility="local" />,
  );
  const user = screen.getByLabelText("Username");
  const password = screen.getByLabelText("Password");
  const save = screen.getByRole("button", { name: "Save securely" });
  await expect.element(user).toBeVisible();
  await expect.element(password).toHaveAttribute("type", "password");
  await expect.element(save).toBeDisabled();
  await user.fill("test-user");
  await expect.element(save).toBeDisabled();
  await password.fill("test-password");
  await expect.element(save).toBeEnabled();
  await save.click();
  expect(state.answer).toHaveBeenCalledWith({
    environmentId: "test",
    input: {
      threadId: "thread:login",
      turnItemId: "item:login",
      answer: { type: "save_login", username: "test-user", password: "test-password" },
    },
  });
});

it("keeps the existing single-secret form", async () => {
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:secret"),
    threadId: ThreadId.make("thread:secret"),
    label: "API secret",
    reason: "Connect",
    secretStatus: "pending",
  } as never;
  await using screen = await render(
    <SecretRequestCard environmentId={EnvironmentId.make("test")} item={item} visibility="local" />,
  );
  const secret = screen.getByLabelText("API secret");
  const save = screen.getByRole("button", { name: "Save securely" });
  await expect.element(secret).toBeVisible();
  await expect.element(save).toBeDisabled();
  await secret.fill("test-secret");
  await save.click();
  expect(state.answer).toHaveBeenCalledWith({
    environmentId: "test",
    input: {
      threadId: "thread:secret",
      turnItemId: "item:secret",
      answer: { type: "save", secret: "test-secret" },
    },
  });
});

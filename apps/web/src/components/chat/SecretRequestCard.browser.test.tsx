import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => atom) as never,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    openHandoff: {},
    answerSecretRequest: { permissionAtom: () => true },
    settingsValueAtom: () => null,
    configValueAtom: () => null,
  },
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
  const setupKey = screen.getByLabelText("Authenticator setup key (optional)");
  const save = screen.getByRole("button", { name: "Save securely" });
  await expect.element(user).toBeVisible();
  // Password managers must not fill or save these credentials under GOAT's own site.
  for (const field of [user, password, setupKey]) {
    await expect.element(field).toHaveAttribute("autocomplete", "off");
    await expect.element(field).toHaveAttribute("data-1p-ignore");
    await expect.element(field).toHaveAttribute("data-lpignore", "true");
    await expect.element(field).toHaveAttribute("data-bwignore");
  }
  await expect.element(password).toHaveAttribute("type", "password");
  await expect.element(setupKey).toHaveAttribute("type", "password");
  await expect.element(save).toBeDisabled();
  await user.fill("test-user");
  await expect.element(save).toBeDisabled();
  await password.fill("  pass word  ");
  await setupKey.fill("  abcd efgh  ");
  await expect.element(save).toBeEnabled();
  await save.click();
  expect(state.answer).toHaveBeenCalledWith({
    environmentId: "test",
    input: {
      threadId: "thread:login",
      turnItemId: "item:login",
      answer: {
        type: "save_login",
        username: "test-user",
        password: "  pass word  ",
        authenticatorSetupKey: "abcd efgh",
      },
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
  await expect.element(secret).toHaveAttribute("type", "password");
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

it("validates the card, suppresses password managers, and saves a normalized answer", async () => {
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:card"),
    threadId: ThreadId.make("thread:card"),
    label: "Payment",
    reason: "Pay",
    secretStatus: "pending",
    requestKind: "card",
    siteOrigin: "https://card.test",
  } as never;
  await using screen = await render(
    <SecretRequestCard environmentId={EnvironmentId.make("test")} item={item} visibility="local" />,
  );
  const fields = ["Card number", "Expiry month", "Expiry year", "CVC", "Name on card"].map(
    (label) => screen.getByLabelText(label),
  );
  const save = screen.getByRole("button", { name: "Save securely" });
  for (const field of fields) {
    await expect.element(field).toHaveAttribute("autocomplete", "off");
    await expect.element(field).toHaveAttribute("data-1p-ignore");
    await expect.element(field).toHaveAttribute("data-lpignore", "true");
    await expect.element(field).toHaveAttribute("data-bwignore");
  }
  await expect.element(fields[3]!).toHaveAttribute("type", "password");
  await expect.element(save).toBeDisabled();
  await fields[0]!.fill("4242 4242-4242 4242");
  await fields[1]!.fill("01");
  await fields[2]!.fill("29");
  await fields[3]!.fill("00");
  await fields[4]!.fill("  Example Name  ");
  await expect.element(save).toBeDisabled();
  await fields[3]!.fill("003");
  await expect.element(save).toBeEnabled();
  await save.click();
  expect(state.answer).toHaveBeenCalledWith({
    environmentId: "test",
    input: {
      threadId: "thread:card",
      turnItemId: "item:card",
      answer: {
        type: "save_card",
        number: "4242424242424242",
        expiryMonth: "01",
        expiryYear: "2029",
        cvc: "003",
        name: "  Example Name  ",
      },
    },
  });
});

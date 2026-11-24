import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Dialog, DialogPopup } from "../ui/dialog";

const state = vi.hoisted(() => ({
  result: null as { readonly agents: ReadonlyArray<AcpRegistrySearchAgent> } | null,
  error: null as string | null,
  isPending: false,
  canManage: true,
  refresh: vi.fn(),
  search: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      searchAcpRegistry: ((input: unknown) => {
        state.search(input);
        return "search";
      }) as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.canManage,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.result,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.prepare) as never,
}));

import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";

const environmentId = EnvironmentId.make("remote-device");
const gemini: AcpRegistrySearchAgent = {
  id: "gemini",
  name: "Gemini CLI",
  version: "1.2.3",
  description: "Google's agent",
  authors: ["Google <gemini-cli@google.com>", "Contributor"],
  license: "Apache-2.0",
  website: "https://example.com/docs",
  repository: "https://example.com/source",
  icon: null,
  distribution: "npx",
  integrity: "registry",
};

function step(options?: {
  readonly configured?: boolean;
  readonly onPrepared?: (agent: AcpRegistrySearchAgent) => void;
}) {
  return (
    <AcpRegistrySearchStep
      environmentId={environmentId}
      providerInstances={
        options?.configured
          ? {
              acpRegistry_gemini: {
                driver: ProviderDriverKind.make("acpRegistry"),
                config: { agentId: "gemini" },
              },
            }
          : {}
      }
      onPrepared={options?.onPrepared ?? vi.fn()}
      onManualConfiguration={vi.fn()}
    />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  state.canManage = true;
  state.result = null;
  state.error = null;
  state.isPending = false;
  state.refresh.mockReset();
  state.search.mockReset();
  state.prepare.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { agentId: "gemini", version: "1.2.3", distribution: "npx", prepared: true },
  });
}

it("rechecks the grant before preparing an agent", async () => {
  setup();
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await using _screen = await render(step({ onPrepared }));
  state.canManage = false;

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();

  expect(state.prepare).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});

it("bounds pasted registry searches before debounce and submission", async () => {
  setup();
  await using screen = await render(step());
  const searchbox = screen.getByRole("searchbox", { name: "Search ACP Registry" });

  await searchbox.fill("agent".repeat(26));
  await vi.waitFor(() => {
    expect(state.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "agent".repeat(24) },
    });
  });
  await userEvent.keyboard("{Enter}");
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await expect.element(searchbox).toHaveValue("agent".repeat(24));
});

it("ignores prepare completion after unmount", async () => {
  setup();
  const pending = deferred<unknown>();
  state.prepare.mockReturnValueOnce(pending.promise);
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await using screen = await render(step({ onPrepared }));

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();
  await screen.unmount();
  await act(async () =>
    pending.resolve({
      _tag: "Success",
      value: { agentId: "gemini", version: "1.2.3", distribution: "npx", prepared: true },
    }),
  );

  expect(onPrepared).not.toHaveBeenCalled();
});

it.each([
  "codex-acp",
  "claude-acp",
  "antigravity-acp",
  "cursor",
  "grok-build",
  "opencode",
  "opencode-v2",
  "pi-acp",
])("leaves %s to GOAT's first-class provider while retaining other registry agents", async (id) => {
  setup();
  state.result = { agents: [gemini, { ...gemini, id, name: "Built-in provider" }] };
  await using _screen = await render(step());
  await expect.element(page.getByRole("button", { name: "Add Gemini CLI" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Add Built-in provider" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("status")).toHaveTextContent("1 compatible agent found.");
});

it("Escape in the search clears it without closing Add provider", async () => {
  setup();
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>{step()}</DialogPopup>
    </Dialog>,
  );
  const search = page.getByRole("searchbox", { name: "Search ACP Registry" });
  await userEvent.fill(search, "gemini");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true }),
        );
    });
    await expect.element(search).toHaveValue("gemini");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  // Holding Escape repeats the keydown, which must not also close the dialog.
  await act(() => {
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false]);
});

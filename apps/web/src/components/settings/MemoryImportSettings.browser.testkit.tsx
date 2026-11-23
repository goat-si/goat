import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { expect, vi } from "vite-plus/test";
import type { EnvironmentId, MemorySpaceId, MemoryImportProviderInput } from "@goat/contracts";
import { render } from "../../../test/render";
import { id } from "./MemorySettings.browser.fixtures";
import { MemoryImportSettings } from "./MemoryImportSettings";

export async function exerciseCodexConflictNotice(
  state: {
    environment: unknown;
    executors: Map<string, (input: unknown) => Promise<unknown>>;
    exposure: unknown;
    allowed: boolean;
  },
  envId: EnvironmentId,
  spaceId: MemorySpaceId,
) {
  const sourceId = id(61);
  state.environment = {
    serverConfig: {
      environment: { capabilities: { memory: { protocolVersion: 1, codexImportUpdates: true } } },
    },
  };
  state.executors.set("importProvider", async (request) => {
    const input = (request as { input: MemoryImportProviderInput }).input;
    if (input.action === "codexBaseline")
      return {
        action: input.action,
        sourceId,
        next: null,
        items: [
          {
            sourceItemKey: "MEMORY.md#task-group:Setup",
            sourceFingerprint: "a".repeat(64),
            locallyEdited: true,
            scope: { kind: "user" },
          },
        ],
      };
    if (input.action === "preview")
      return {
        action: input.action,
        sourceId,
        sessionId: "fixture",
        items: [
          {
            sourceItemKey: "MEMORY.md#task-group:Setup",
            sourceFingerprint: "b".repeat(64),
            memoryId: id(2),
            title: "Setup",
            byteCount: 10,
            mappingRequired: false,
          },
        ],
      };
    throw new Error("unexpected request");
  });
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    return label === "syncChanges"
      ? (state.exposure as never)
      : label
        ? (state.allowed as never)
        : get(atom);
  });
  // Router is mocked by this existing settings fixture.
  await using screen = await render(
    <RegistryContext value={registry}>
      <MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />
    </RegistryContext>,
    { router: false },
  );
  for (const [name, value] of [
    ["Import provider", "codex"],
    ["Memory scope", "user"],
  ] as const) {
    const select = screen.container.querySelector<HTMLSelectElement>(
      `select[aria-label="${name}"]`,
    );
    if (!select) throw new Error(`Missing ${name} selector`);
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const check = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Check for updates",
  );
  if (!check) throw new Error("Missing update check");
  await act(async () => check.click());
  expect(screen.container.textContent).toContain("Changed in both");
  expect(screen.container.textContent).toContain(
    "Selecting this and applying it can create a conflict",
  );
  expect(screen.container.textContent).toContain("may resolve it automatically using a model");
  const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error("Missing memory selection");
  await act(async () => checkbox.click());
  const confirm = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm selection",
  );
  if (!confirm) throw new Error("Missing selection confirmation");
  expect(confirm.disabled).toBe(false);
  await act(async () => confirm.click());
  expect(screen.container.textContent).toContain("Import 1 selected memories");
}

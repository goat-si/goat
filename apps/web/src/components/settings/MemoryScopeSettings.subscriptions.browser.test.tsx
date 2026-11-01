import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId, MemorySpaceId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const observed = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const source = Atom.make<readonly { id: string; environmentId: string; title: string }[]>([]);
  return {
    testSource: source,
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellsAtom: Atom.make((get) => {
        observed.reads++;
        return get(source);
      }),
    },
  };
});
vi.mock("../../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});
vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentShell: {},
    allEnvironmentProjectSnapshotsReadyAtom: Atom.make(true),
    allEnvironmentShellsBootstrappedAtom: Atom.make(true),
    pendingEnvironmentShellIdsAtom: Atom.make([]),
  };
});
vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map()),
  };
});
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/memory", async () => {
  const { Atom } = await import("effect/reactivity");
  const denied = Atom.make(false);
  return {
    memoryEnvironment: {
      projectBindingGet: { permissionAtom: () => denied },
      projectBindingUpdate: { permissionAtom: () => denied },
    },
  };
});
vi.mock("../../state/use-atom-command", () => {
  const execute = async () => ({ _tag: "Failure" });
  return { useAtomCommand: () => execute };
});
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value ?? ""} onChange={(event) => onValueChange(event.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./MemoryScopePicker", () => ({ MemoryScopePicker: () => null }));
import { MemoryScopeSettings } from "./MemoryScopeSettings";

it("actual entity hook never reads or subscribes to 2000 shells outside thread scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // The actual entities hook reads the test's observable thread atom; the hook itself is not mocked.
  const threads = (await import("../../state/threads")) as unknown as {
    testSource: Atom.Writable<readonly { id: string; environmentId: string; title: string }[]>;
  };
  const shells = Array.from({ length: 2000 }, (_, i) => ({
    id: `thread-${i}`,
    environmentId: "device",
    title: `Thread ${i}`,
  }));
  registry.set(threads.testSource, shells);
  const change = vi.fn();
  try {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <MemoryScopeSettings
            environmentId={EnvironmentId.make("device")}
            memorySpaceId={MemorySpaceId.make("00000000-0000-4000-8000-000000000001")}
            onChange={change}
          />
        </RegistryContext>,
      ),
    );
    async function choose(kind: string) {
      await act(async () => {
        const select = host.querySelector("select")!;
        select.value = kind;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    for (const kind of ["user", "project"]) {
      await choose(kind);
      change.mockClear();
      await act(async () =>
        registry.set(
          threads.testSource,
          shells.map((shell) => ({ ...shell, title: `${shell.title} changed` })),
        ),
      );
      expect(observed.reads).toBe(0);
      expect(change).not.toHaveBeenCalled();
    }
    await choose("thread");
    expect(observed.reads).toBeGreaterThan(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    registry.dispose();
    vi.unstubAllGlobals();
  }
});

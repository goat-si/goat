import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  RelayConnectionTarget,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    title: "Known thread",
    shell: vi.fn(),
    navigate: vi.fn(),
    entries: new Map<EnvironmentId, ConnectionCatalogEntry>(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ entries: mocks.entries }) }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: { name: string; params: unknown }) =>
    mocks.navigate(detail.name, detail.params),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: mocks.shell }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));

import { NoteLinkedThread } from "./NoteLinkedThread";
const environmentId = EnvironmentId.make("hub");
const threadId = ThreadId.make("thread");
let root: Root;
let container: HTMLDivElement;
function render(host: string | null) {
  root.render(
    <NoteLinkedThread environmentId={environmentId} link={{ threadId, host, lastResult: null }} />,
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.entries = new Map();
  mocks.navigate.mockReset();
  mocks.shell.mockReset().mockImplementation((ref) => (ref ? { title: mocks.title } : null));
});
afterEach(() => act(() => root.unmount()));

it("shows a known local title and opens the thread in its environment", async () => {
  mocks.title = "Review the note";
  await act(async () => render(null));
  expect(container.textContent).toContain("Review the note · This hub");
  expect(container.textContent).toContain("No result yet");
  act(() => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith("Thread", { environmentId, threadId });
});

it("uses a short fallback with the host for unknown remote threads", async () => {
  await act(async () => render("studio"));
  expect(container.textContent).toBe("Thread · studioNo result yet");
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.shell).toHaveBeenLastCalledWith(null);
});

it("uses the matching remote environment's title and navigation destination", async () => {
  const remote = EnvironmentId.make("remote");
  mocks.entries.set(remote, {
    target: new RelayConnectionTarget({ environmentId: remote, label: "studio" }),
    profile: Option.none(),
    enabled: true,
  });
  mocks.title = "Remote work";
  await act(async () => render("studio"));
  expect(container.textContent).toContain("Remote work · studio");
  expect(container.textContent).toContain("No result yet");
  expect(mocks.shell).toHaveBeenLastCalledWith({ environmentId: remote, threadId });
  act(() => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith("Thread", { environmentId: remote, threadId });
});

it("finds a known remote thread through an SSH alias on an alternate route", async () => {
  const remote = EnvironmentId.make("remote");
  const target = new RelayConnectionTarget({ environmentId: remote, label: "Remote machine" });
  mocks.entries.set(remote, {
    target,
    profile: Option.none(),
    enabled: true,
    alternateRoutes: [
      {
        target,
        profile: Option.some(
          new SshConnectionProfile({
            environmentId: remote,
            connectionId: "ssh-studio",
            label: "Remote machine",
            target: {
              alias: "studio",
              hostname: "studio.example.test",
              username: null,
              port: null,
            },
          }),
        ),
      },
    ],
  });
  mocks.title = "Work over SSH";
  await act(async () => render("studio"));
  expect(container.textContent).toContain("Work over SSH · studio");
  expect(mocks.shell).toHaveBeenLastCalledWith({ environmentId: remote, threadId });
});

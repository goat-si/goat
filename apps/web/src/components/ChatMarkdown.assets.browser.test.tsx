import { RegistryContext } from "@effect/atom-react";
import { type AssetCreateUrlResult, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// Keep the real query runner and registry: refreshes during waiting requests are skipped.
vi.mock(import("../state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const family = Atom.family((_key: string) =>
    Atom.make(Effect.tryPromise(() => mint())).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => family(JSON.stringify(target)),
    },
  };
});
vi.mock(import("../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

it("opens host media through server authorization before the client grant loads", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  mint.mockReset().mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const onImageExpand = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ChatMarkdown
        cwd="/repo"
        threadRef={{
          environmentId: EnvironmentId.make("media-environment"),
          threadId: ThreadId.make("media-thread"),
        }}
        text="[Open image](/tmp/image.png)"
        onImageExpand={onImageExpand}
      />
    </RegistryContext.Provider>,
  );
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
  const [preview] = onImageExpand.mock.calls[0]!;
  expect(preview.images[0].actionsSource.onOpenFile).toBeTypeOf("function");
});

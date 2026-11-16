import "~/index.css";
import { RegistryContext } from "@effect/atom-react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

interface Bots {
  readonly bots: ReadonlyArray<string>;
}

class ReadFailed extends Data.TaggedError("ReadFailed")<{ readonly message: string }> {}

// One read the test settles by hand.
function pendingRead() {
  let settle!: { resolve: (value: Bots) => void; reject: (error: Error) => void };
  const promise = new Promise<Bots>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

function Probe(props: {
  readonly list: Atom.Atom<AsyncResult.AsyncResult<Bots, ReadFailed>>;
  readonly onView: (view: EnvironmentQueryView<Bots, ReadFailed>) => void;
}) {
  props.onView(useEnvironmentQuery(props.list));
  return null;
}

it("exposes the settled success as an object that changes only when a read succeeds: null while a refetch waits or after it fails, a new object even for the same value (behavior)", async () => {
  const registry = AtomRegistry.make();
  let read = pendingRead();
  const list = Atom.make(
    Effect.suspend(() =>
      Effect.tryPromise({
        try: () => read.promise,
        catch: (error) => new ReadFailed({ message: String((error as Error).message) }),
      }),
    ),
  );
  const views: Array<EnvironmentQueryView<Bots, ReadFailed>> = [];
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe list={list} onView={(view) => views.push(view)} />
    </RegistryContext.Provider>,
  );
  const current = () => views[views.length - 1] as EnvironmentQueryView<Bots, ReadFailed>;
  const answer: Bots = { bots: ["main"] };

  await act(() => read.resolve(answer));
  const first = current().successResult;
  expect(first).not.toBeNull();
  expect(current().data).toBe(answer);

  read = pendingRead();
  await act(() => registry.refresh(list));
  expect(current().isPending).toBe(true);
  expect(current().data).toBe(answer);
  expect(current().successResult).toBeNull();

  await act(() => read.reject(new Error("Not allowed.")));
  expect(current().error).toBe("Not allowed.");
  expect(current().data).toBe(answer);
  expect(current().successResult).toBeNull();

  // The runtime hands back the same value for equal content; the settled success is still new.
  read = pendingRead();
  await act(() => registry.refresh(list));
  await act(() => read.resolve(answer));
  expect(current().data).toBe(answer);
  expect(current().successResult).not.toBeNull();
  expect(current().successResult).not.toBe(first);
});

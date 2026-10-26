import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { act, render } from "../../../test/render";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import { loadCitedHistory, type CitationPhase } from "./citationProcedure";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

const request: AssistantCitationRequest = {
  key: "citation-1",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("source"),
    text: "source",
    start: 0,
    end: 6,
    prefix: "",
    suffix: "",
  },
};
const ready = { _tag: "ready", rowId: "source" } satisfies CitationPhase;

function setup() {
  const manualNavigation = vi.fn();
  const viewport = document.createElement("div");
  let result: ReturnType<typeof useAssistantCitationTarget>;
  function Harness({
    phase,
    citation = request,
  }: {
    phase: CitationPhase;
    citation?: AssistantCitationRequest | null;
  }) {
    const current = useAssistantCitationTarget({
      request: citation,
      phase,
      viewport,
      onManualNavigation: manualNavigation,
    });
    useLayoutEffect(() => {
      result = current;
    });
    return <button onClick={current.onListLoad}>List loaded</button>;
  }
  return { Harness, viewport, manualNavigation, read: () => result };
}

it("waits for older history and the mounted list before completing citation positioning", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "loading" }} />);
  expect(read().target).toBeNull();
  expect(read().positioning).toBe(true);
  const load = vi.fn(async () => ({ _tag: "loaded" as const }));
  let pages = 0;
  const outcome = await loadCitedHistory({
    signal: new AbortController().signal,
    readThread: async () => ({ message: pages++ < 2 ? null : "assistant", hasMoreHistory: true }),
    loadThrough: load,
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(outcome).toEqual({ _tag: "found" });
  await screen.rerender(<Harness phase={ready} />);
  expect(read().target).toBeNull();
  await act(() => read().onListLoad());
  expect(read().target?.citation.messageId).toBe("source");
  expect(read().alwaysRender?.keys).toContain("source");
  await act(() => read().target?.onComplete());
  expect(read().positioning).toBe(false);
});

it("ends positioning when exhausted history reports the response unavailable", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "loading" }} />);
  expect(read().positioning).toBe(true);
  const outcome = await loadCitedHistory({
    signal: new AbortController().signal,
    readThread: async () => ({ message: null, hasMoreHistory: false }),
    loadThrough: vi.fn(),
  });
  expect(outcome).toMatchObject({ _tag: "failed", title: "The cited response is unavailable" });
  await screen.rerender(<Harness phase={{ _tag: "failed" }} />);
  expect(read().positioning).toBe(false);
  expect(read().target).toBeNull();
});

it("waits for a folded turn to expand before exposing the cited response", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "expanding" }} />);
  await act(() => read().onListLoad());
  expect(read().target).toBeNull();
  expect(read().positioning).toBe(true);
  await screen.rerender(<Harness phase={ready} />);
  expect(read().target?.citation.messageId).toBe("source");
});

it("ends positioning when a hidden source cannot be revealed", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "expanding" }} />);
  await screen.rerender(<Harness phase={{ _tag: "failed" }} />);
  expect(read().positioning).toBe(false);
  expect(read().target).toBeNull();
});

it("allows manual navigation to cancel citation loading", async () => {
  const { Harness, viewport, read } = setup();
  await using _screen = await render(<Harness phase={{ _tag: "loading" }} />);
  await act(() => {
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
  });
  expect(read().positioning).toBe(false);
  expect(read().target).toBeNull();
});

it("ends positioning when a history request fails", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "loading" }} />);
  const load = vi.fn(async () => ({ _tag: "error" as const, message: "offline" }));
  const outcome = await loadCitedHistory({
    signal: new AbortController().signal,
    readThread: async () => ({ message: null, hasMoreHistory: true }),
    loadThrough: load,
  });
  expect(load).toHaveBeenCalledOnce();
  expect(outcome).toMatchObject({ _tag: "failed", title: "Could not load the cited response" });
  await screen.rerender(<Harness phase={{ _tag: "failed" }} />);
  expect(read().positioning).toBe(false);
});

it("retires an earlier citation when another activation replaces it", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={ready} />);
  await act(() => read().onListLoad());
  const earlier = read().target;
  await screen.rerender(<Harness phase={ready} citation={{ ...request, key: "citation-2" }} />);
  expect(earlier?.activationRef.current.dismissed).toBe(true);
  expect(read().target?.key).toBe("citation-2");
  expect(read().positioning).toBe(true);
});

it("ends positioning when settled history never advances to the cited response", async () => {
  const { Harness, read } = setup();
  await using screen = await render(<Harness phase={{ _tag: "loading" }} />);
  const load = vi.fn(async () => ({ _tag: "loaded" as const }));
  const outcome = await loadCitedHistory({
    signal: new AbortController().signal,
    readThread: async () => ({ message: null, hasMoreHistory: true }),
    loadThrough: load,
  });
  expect(load).toHaveBeenCalledTimes(20);
  expect(outcome).toMatchObject({ _tag: "failed", title: "Could not load the cited response" });
  await screen.rerender(<Harness phase={{ _tag: "failed" }} />);
  expect(read().positioning).toBe(false);
});

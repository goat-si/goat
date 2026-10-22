import {
  state,
  setupSshComposer,
  local,
  remote,
  destination,
  entry,
  id,
  store,
  result,
  deferred,
} from "~/test/sshComposerFixture";
import { act, fakeTimers } from "../../test/render";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  ThreadId,
  ComposerContextId,
  SshWorkspaceError,
  type SshHostStatus,
} from "@goat/contracts";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import { createEnvironmentPresentationAtoms } from "@goat/client-runtime/state/presentation";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimeline } from "./chat/MessagesTimeline";
import type { ChatComposer, ChatComposerHandle } from "./chat/ChatComposer";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import ChatView from "./ChatView";
import * as chatViewLogic from "./ChatView.logic";
// Browser module namespaces cannot be spied on, so expose the scheduler as a mock that keeps its real behavior.
vi.mock("./ChatView.logic", async (original) => {
  const actual = await original<typeof import("./ChatView.logic")>();
  return {
    ...actual,
    scheduleEnvironmentReconnectWarning: vi.fn(actual.scheduleEnvironmentReconnectWarning),
  };
});
// Keep the real ChatView controller and DOM events; replace only the virtualizer boundary.
vi.mock("./chat/MessagesTimeline", async () => {
  const React = await import("react");
  const { resolveTimelineIsAtEnd } = await import("./chat/MessagesTimeline.logic");
  const listsByNode = new WeakMap<HTMLDivElement, LegendListRef>();
  return {
    MessagesTimeline: (props: ComponentProps<typeof MessagesTimeline>) => {
      state.timeline = props;
      const [version, setVersion] = React.useState(0);
      state.mountTimeline = () => setVersion(1);
      state.replaceTimeline = () => setVersion((current) => current + 1);
      // Like LegendList, the ref keeps its identity across re-renders of the same list.
      const attach = (node: HTMLDivElement | null) => {
        state.scrollNode = node;
        const existing = node ? listsByNode.get(node) : undefined;
        const list = !node
          ? null
          : (existing ??
            ({
              getScrollableNode: () => node,
              getState: () => ({
                data: [0],
                scroll: node.scrollTop,
                scrollLength: 400,
                contentLength: state.contentLength,
                positionAtIndex: () => 0,
                sizeAtIndex: () => state.contentLength,
              }),
              scrollToItem: () => Promise.resolve(),
              scrollToEnd: () => {
                state.scrollToEnd();
                node.scrollTop = state.contentLength - 400;
              },
            } as unknown as LegendListRef));
        if (node && list) listsByNode.set(node, list);
        state.list = list;
        props.listRef.current = list;
        props.onScrollableNodeChange?.(node);
      };
      if (!version) return null;
      return (
        <div
          key={version}
          data-timeline
          style={{ height: 400, overflow: "auto" }}
          ref={attach}
          onScroll={() => {
            const atEnd = resolveTimelineIsAtEnd(props.listRef.current?.getState());
            if (atEnd !== undefined) props.onIsAtEndChange(atEnd);
          }}
        >
          <div style={{ height: state.contentLength }} />
        </div>
      );
    },
  };
});
vi.mock("./chat/ChatComposer", async () => {
  const React = await import("react");
  return {
    ChatComposer: (props: ComponentProps<typeof ChatComposer>) => {
      state.composer = props;
      React.useImperativeHandle(
        props.composerRef,
        () =>
          ({
            getSendContext: () => ({
              answeringPendingUserInput: false,
              multipleModelSelections: props.multipleModelSelections,
              providerAvailable: false,
              selectedProvider: "codex",
              selectedModel: "model",
              selectedProviderModels: [],
              selectedPromptEffort: null,
              selectedModelSelection: state.data!.selection,
              interactionMode: "default",
              interactionModeEnabled: true,
            }),
            validateProviderInput: () => true,
            resetCursorState: () => {},
            focus: () => {},
            focusAtEnd: () => {},
            restoreAfterTimelineReachedEnd: () => {},
            collapseForTimelineScrollKey: () => {},
          }) as unknown as ChatComposerHandle,
      );
      return (
        <div data-editor="editable">
          {props.bannerItems.map((item) => (
            <div key={item.id} data-banner={item.id}>
              {item.title}
              {item.description}
              {item.actions}
            </div>
          ))}
          <button onClick={() => void props.onSend()}>Send</button>
        </div>
      );
    },
  };
});
async function setup() {
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockReset();
  return setupSshComposer();
}
it("never calls normal launch or uploads for SSH send", async () => {
  await using fixture = await setup();
  const { mount } = fixture;
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.normal).not.toHaveBeenCalled();
  expect(state.uploads).not.toHaveBeenCalled();
});

it("deletes an unchanged submitted draft only after remote navigation succeeds", async () => {
  await using fixture = await setup();
  const { mount } = fixture;
  const launch = deferred<Awaited<ReturnType<typeof state.launch>>>(),
    shell = deferred<boolean>(),
    nav = deferred<void>();
  const shellEntered = deferred<void>(),
    navEntered = deferred<void>();
  state.launch.mockImplementation(() => launch.promise);
  state.shell.mockImplementation(() => {
    shellEntered.resolve();
    return shell.promise;
  });
  state.navigate.mockImplementation(async (request) => {
    navEntered.resolve();
    await nav.promise;
    await fixture.rerender(<div data-remote-thread={request.params.threadId} />);
  });
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
  });
  expect(state.composer!.isSendBusy).toBe(true);
  expect(store().getDraftSession(id)).not.toBeNull();
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
    await shellEntered.promise;
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    shell.resolve(true);
    await navEntered.promise;
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(store().getComposerDraft(id)?.prompt).toBe("Text");
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: remote, threadId: result.remoteThreadId },
    replace: true,
  });
  await act(async () => {
    nav.resolve();
    await sending;
  });
  expect(store().getDraftSession(id)).toBeNull();
  expect(store().getComposerDraft(id)).toBeNull();
  expect(store().getDraftSessionByLogicalProjectKey("source")).toBeNull();
  expect(state.navigate).toHaveBeenCalledTimes(1);
});
it.each([true, false])(
  "preserves content added during launch by simulated desktop capture (open=%s)",
  async (opens) => {
    await using fixture = await setup();
    const { mount } = fixture;
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    state.shell.mockResolvedValue(opens);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    await act(async () =>
      store().addImage(id, {
        id: "capture",
        type: "image",
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:capture",
        file: new File(["x"], "capture.png"),
      }),
    );
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Text");
    expect(store().getComposerDraft(id)?.images).toHaveLength(1);
    expect(store().getDraftSession(id)?.sshDestination).toEqual(destination);
    if (!opens) {
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Started on Build, but could not open the thread",
          actionProps: expect.objectContaining({ children: "Open thread" }),
        }),
      );
      expect(state.composer!.isSendBusy).toBe(false);
    }
  },
);
it.each(["shell", "navigation"])("preserves text and contexts added during %s", async (stage) => {
  await using fixture = await setup();
  const { mount } = fixture;
  const wait = deferred<boolean>(),
    nav = deferred<void>(),
    entered = deferred<void>();
  state.shell.mockImplementation(() => {
    if (stage === "shell") entered.resolve();
    return stage === "shell" ? wait.promise : Promise.resolve(true);
  });
  state.navigate.mockImplementation(async () => {
    entered.resolve();
    await nav.promise;
    await fixture.rerender(<div />);
  });
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
    await entered.promise;
  });
  await act(async () => {
    store().setPrompt(id, "Pasted new text");
    store().setThreadContexts(id, [
      {
        version: 1,
        contextId: ComposerContextId.make("context"),
        label: "Context",
        kind: "thread",
        environmentId: local,
        threadId: ThreadId.make("context"),
        title: "Context",
      },
    ]);
  });
  await act(async () => {
    wait.resolve(true);
    nav.resolve();
    await sending;
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("Pasted new text");
  expect(store().getComposerDraft(id)?.threadContexts).toHaveLength(1);
});
it.each(["validate", "preflight", "snapshot", "remote_init", "push", "launch"] as const)(
  "keeps the entire current draft when launch fails at %s",
  async (stage) => {
    await using fixture = await setup();
    const { mount } = fixture;
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    await act(async () => store().setPrompt(id, "Text plus edits"));
    // Preserve the wire error through the actual atom-command squash boundary.
    await act(async () => {
      launch.resolve({
        _tag: "Failure",
        cause: Cause.fail(new SshWorkspaceError({ code: "invalid_target", stage })),
      });
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Text plus edits");
    expect(store().getDraftSession(id)?.sshDestination).toEqual(destination);
    expect(store().getDraftSessionByLogicalProjectKey("source")?.draftId).toBe(id);
    expect(state.composer!.isSendBusy).toBe(false);
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: `Build · ${stage} · invalid_target` }),
    );
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  new SshWorkspaceError({ code: "launch_uncertain", stage: "launch" }),
  { launchMayHaveStarted: true },
  new Error("transport interrupted"),
])("reports an uncertain launch without automatic retry %j", async (error) => {
  await using fixture = await setup();
  const { mount } = fixture;
  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
  });
  await act(async () => store().setPrompt(id, "Current text"));
  await act(async () => {
    launch.reject(error);
    await sending;
  });
  expect(store().getComposerDraft(id)?.prompt).toBe("Current text");
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.composer!.isSendBusy).toBe(false);
  expect(state.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      title:
        "The thread may already have started on Build; check its threads before sending again.",
    }),
  );
});
it.each([false, true])(
  "shows Open thread after navigation timeout (changed=%s)",
  async (changed) => {
    await using fixture = await setup();
    const { mount } = fixture;
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    state.shell.mockResolvedValue(false);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    if (changed) await act(async () => store().setPrompt(id, "new content"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(store().getDraftSessionByLogicalProjectKey("source")?.draftId).toBe(id);
    expect(store().getComposerDraft(id)?.prompt ?? "").toBe(changed ? "new content" : "");
    const toast = state.toast.mock.calls.at(-1)![0];
    expect(toast.title).toBe("Started on Build, but could not open the thread");
    expect(toast.description).toContain(result.remoteThreadId);
    expect(toast.actionProps.children).toBe("Open thread");
    const before = store().getComposerDraft(id);
    state.shell.mockResolvedValue(true);
    await act(async () => {
      toast.actionProps.onClick();
    });
    expect(state.retry).toHaveBeenCalledWith(remote);
    expect(state.launch).toHaveBeenCalledTimes(1);
    expect(store().getComposerDraft(id)).toEqual(before);
  },
);
it.each([false, true])(
  "keeps the ordinary session and Open action when opening keeps failing (changed=%s)",
  async (changed) => {
    await using fixture = await setup();
    const { mount, catalog } = fixture;
    state.shell.mockRejectedValue(new Error("shell failed"));
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    if (changed) await act(async () => store().setPrompt(id, "New text"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    const before = store().getComposerDraft(id);
    const toast = state.toast.mock.calls.at(-1)![0];
    catalog.entries.delete(remote);
    await act(async () => toast.actionProps.onClick());
    catalog.entries.set(remote, entry);
    expect(state.retry).not.toHaveBeenCalled();
    expect(store().getComposerDraft(id)).toEqual(before);
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(state.toast.mock.calls.at(-1)![0].actionProps.children).toBe("Open thread");
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("reports started-not-opened for a mismatched saved environment", async () => {
  await using fixture = await setup();
  const { mount } = fixture;
  state.launch.mockResolvedValue({
    _tag: "Success",
    value: { ...result, remoteEnvironmentId: EnvironmentId.make("wrong") },
  });
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.shell).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(store().getDraftSession(id)).not.toBeNull();
  const toast = state.toast.mock.calls.at(-1)![0];
  expect(toast.description).toContain("different environment");
  await act(async () => toast.actionProps.onClick());
  expect(state.retry).toHaveBeenCalledWith(remote);
  expect(state.shell).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});
it.each([false, true])(
  "keeps a newer draft untouched after navigation away (A changed=%s)",
  async (changed) => {
    await using fixture = await setup();
    const { mount, project } = fixture;
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    const b = DraftId.make("B");
    await act(async () => {
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), b, {
        threadId: ThreadId.make("B"),
      });
      store().setPrompt(b, "B text");
    });
    await mount(b);
    if (changed) await act(async () => store().setPrompt(id, "Changed A"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getComposerDraft(b)?.prompt).toBe("B text");
    expect(store().getComposerDraft(id)?.prompt ?? "").toBe(changed ? "Changed A" : "");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast.mock.calls.at(-1)![0].actionProps.children).toBe("Open thread");
  },
);
it.each(["success", "failure", "uncertain"])(
  "preserves content added on A after A→B→A during a deferred %s",
  async (outcome) => {
    await using fixture = await setup();
    const { mount, project } = fixture;
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    const b = DraftId.make("B");
    await act(async () => {
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), b, {
        threadId: ThreadId.make("B"),
      });
      store().setPrompt(b, "B text");
    });
    await mount(b);
    await mount();
    await act(async () => store().setPrompt(id, "Changed after remount"));
    await act(async () => {
      if (outcome === "success") launch.resolve({ _tag: "Success", value: result });
      else
        launch.reject(
          new SshWorkspaceError({
            code: outcome === "failure" ? "launch_refused" : "launch_uncertain",
            stage: "launch",
          }),
        );
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Changed after remount");
    expect(store().getComposerDraft(b)?.prompt).toBe("B text");
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("serializes duplicate send activation in the mounted instance", async () => {
  await using fixture = await setup();
  const { mount } = fixture;
  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
    state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
    await sending;
  });
});
it.each(["image", "file", "hydration", "context", "fanout"])(
  "rejects %s before command dispatch",
  async (kind) => {
    await using fixture = await setup();
    const { mount } = fixture;
    await mount();
    await act(async () => {
      if (kind === "image")
        store().addImages(id, [
          {
            id: "image",
            type: "image",
            name: "image",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "blob:image",
            file: new File(["x"], "image"),
          },
        ]);
      if (kind === "file")
        store().addFiles(id, [
          {
            id: "file",
            type: "file",
            name: "file",
            mimeType: "text/plain",
            sizeBytes: 1,
            file: new File(["x"], "file"),
          },
        ]);
      if (kind === "hydration") {
        const content = store().getComposerDraft(id)!;
        useComposerDraftStore.setState({
          draftsByThreadKey: {
            ...store().draftsByThreadKey,
            [id]: { ...content, nonPersistedImageIds: ["pending"] },
          },
        });
      }
      if (kind === "context")
        store().setThreadContexts(id, [
          {
            version: 1,
            contextId: ComposerContextId.make("context"),
            label: "Context",
            kind: "thread",
            environmentId: local,
            threadId: ThreadId.make("context"),
            title: "Context",
          },
        ]);
      if (kind === "fanout") state.composer!.onMultipleModelSelectionsChange([]);
    });
    await act(async () => {
      await state.composer!.onSend();
    });
    expect(state.launch).not.toHaveBeenCalled();
    expect(state.normal).not.toHaveBeenCalled();
    expect(state.uploads).not.toHaveBeenCalled();
  },
);
it("requires a new explicit send after a definitive prelaunch failure", async () => {
  await using fixture = await setup();
  const { mount } = fixture;
  state.launch.mockRejectedValueOnce(
    new SshWorkspaceError({ code: "host_unavailable", stage: "preflight" }),
  );
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.composer!.isSendBusy).toBe(false);
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(2);
});

// Reuse this ChatView integration harness for scroll behavior as well as SSH sends.
describe("timeline follow navigation", () => {
  async function setupTimeline() {
    await using stack = new AsyncDisposableStack();
    const fixture = stack.use(await setup());
    const { container } = fixture;
    stack.use(fakeTimers());
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    // Server-thread routes reuse ChatView; exercise that lifetime without a keyed remount.
    async function mountReusedView(draftId = id) {
      const session = store().getDraftSession(draftId)!;
      await act(() =>
        fixture.rerender(
          <AppAtomRegistryProvider>
            <ChatView
              routeKind="draft"
              draftId={draftId}
              environmentId={session.environmentId}
              threadId={session.threadId}
            />
          </AppAtomRegistryProvider>,
        ),
      );
    }
    async function flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      await act(() => pending.forEach((callback) => callback(0)));
    }
    async function mountList() {
      await act(() => state.mountTimeline!());
      state.scrollNode!.scrollTop = 600;
      await flushFrame();
    }
    async function wheel(deltaY: number, offset: number) {
      await act(() => {
        state.scrollNode!.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
        state.scrollNode!.scrollTop = offset;
        state.scrollNode!.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    }
    // Simulate the virtualizer's observable append behavior at its public follow boundary.
    async function append(growth = 100) {
      state.contentLength += growth;
      (state.scrollNode!.firstElementChild as HTMLElement).style.height =
        `${state.contentLength}px`;
      if (state.timeline!.liveFollowEnabled) {
        state.scrollNode!.scrollTop = state.contentLength - 400;
      }
      await act(() => state.scrollNode!.dispatchEvent(new Event("scroll", { bubbles: true })));
    }
    async function clickScrollToEnd() {
      await wheel(-400, 200);
      await act(() => vi.advanceTimersByTime(150));
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Scroll to end"]',
      );
      expect(button).not.toBeNull();
      await act(() => button!.click());
    }

    const owned = stack.move();
    return {
      ...fixture,
      mountReusedView,
      flushFrame,
      mountList,
      wheel,
      append,
      clickScrollToEnd,
      pendingFrame: () => frames.get(nextFrame)!,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  }

  it("keeps manual reading position after a timeline mounts later than thirteen frames", async () => {
    await using fixture = await setupTimeline();
    const { mount, flushFrame, mountList, wheel, append } = fixture;
    await mount();
    for (let frame = 0; frame < 20; frame++) await flushFrame();
    await mountList();
    await wheel(-200, 400);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(400);
  });

  it("resumes following after a twenty-pixel upward scroll and return to the end", async () => {
    await using fixture = await setupTimeline();
    const { mount, mountList, wheel, append } = fixture;
    await mount();
    await mountList();
    await wheel(-20, 580);
    // A small stream chunk keeps both notifications inside the same 40px end band.
    await append(10);
    expect(state.scrollNode!.scrollTop).toBe(580);
    await wheel(30, 610);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(710);
  });

  it("does not resume following on another upward scroll within the end band", async () => {
    await using fixture = await setupTimeline();
    const { mount, mountList, wheel, append } = fixture;
    await mount();
    await mountList();
    await wheel(-20, 580);
    await wheel(-10, 570);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(570);
  });

  it("cancels a scheduled scroll to end when later manual navigation wins", async () => {
    await using fixture = await setupTimeline();
    const { mount, flushFrame, mountList, wheel, clickScrollToEnd } = fixture;
    await mount();
    await mountList();
    await clickScrollToEnd();
    const pending = fixture.pendingFrame();
    await wheel(-20, 180);
    await flushFrame();
    // Even a callback already dispatched by the browser must respect the generation fence.
    await act(() => pending(0));
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(180);
  });

  it("does not scroll a replacement list from a previously scheduled request", async () => {
    await using fixture = await setupTimeline();
    const { mount, flushFrame, mountList, clickScrollToEnd } = fixture;
    await mount();
    await mountList();
    await clickScrollToEnd();
    await act(() => state.replaceTimeline!());
    state.scrollNode!.scrollTop = 123;
    await flushFrame();
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(123);
  });

  it("cancels a scheduled scroll to end on thread switch", async () => {
    await using fixture = await setupTimeline();
    const { mountReusedView, flushFrame, mountList, clickScrollToEnd, project } = fixture;
    await mountReusedView();
    await mountList();
    await clickScrollToEnd();
    const pending = fixture.pendingFrame();
    const other = DraftId.make("B");
    await act(() =>
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), other, {
        threadId: ThreadId.make("B"),
        envMode: "local",
      }),
    );
    await mountReusedView(other);
    await act(() => state.mountTimeline!());
    state.scrollNode!.scrollTop = 123;
    await flushFrame();
    await act(() => pending(0));
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(123);
  });

  it("scrolls to end on the next frame when no later navigation intervenes", async () => {
    await using fixture = await setupTimeline();
    const { mount, flushFrame, mountList, clickScrollToEnd } = fixture;
    await mount();
    await mountList();
    await clickScrollToEnd();
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    await flushFrame();
    expect(state.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(state.scrollNode!.scrollTop).toBe(600);
  });
});

it("uses reconciled SSH presentation in the chat banner while keeping fresh failures visible", async () => {
  await using fixture = await setup();
  const { mount, container } = fixture;
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockImplementation((show) => {
    show();
    return () => {};
  });
  const identity = { supervisorId: "chat-fixture", attemptId: 2, routeId: "ssh-fixture-route" };
  const connection: EnvironmentConnectionPresentation = {
    phase: "reconnecting",
    stage: "opening",
    error: "OLD SETUP TIMEOUT",
    traceId: null,
    failure: { kind: "retrying", reason: "timeout", detail: "OLD SETUP TIMEOUT" },
    failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
    sshRuntimeReady: {
      ...identity,
      operationId: "fixture-op",
      attachmentId: "fixture-attachment",
      runtimeStatus: {
        host: "fixture-vps",
        state: "ready",
        runtimeVersion: "0.4.3",
        requestedVersion: "0.4.3",
      },
    },
  };
  state.primaryConnection = connection;
  await mount();
  const banner = () => container.querySelector('[data-banner^="environment-unavailable:"]');
  expect(banner()?.textContent).toContain("Runtime ready · Opening connection");
  expect(banner()?.textContent).not.toContain("OLD SETUP TIMEOUT");
  for (const reason of ["timeout", "authentication", "transport"] as const) {
    state.primaryConnection = {
      ...connection,
      error: "FRESH FAILURE",
      failure: { kind: "retrying", reason, detail: "FRESH FAILURE" },
      failureOrigin: {
        ...identity,
        attemptId: 3,
        stage: "opening",
        setupTimeout: reason === "timeout",
      },
    };
    await fixture.rerender(<div />);
    await mount();
    expect(banner()?.textContent).toContain("FRESH FAILURE");
  }
  state.primaryConnection = {
    ...connection,
    sshPreparation: {
      ...identity,
      operationId: "fixture-op",
      phase: "uploading",
      hostAnswered: true,
    },
  };
  await fixture.rerender(<div />);
  await mount();
  expect(banner()?.textContent).toContain(
    "Installing GOAT runtime — first setup can take a few minutes",
  );
  expect(banner()?.textContent).not.toContain("OLD SETUP TIMEOUT");
});

it("removes runtime ready from chat after a shared owner invalidation", async () => {
  await using fixture = await setup();
  const { mount, container } = fixture;
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockImplementation((show) => {
    show();
    return () => {};
  });
  const registry = AtomRegistry.make();
  const identity = { supervisorId: "chat-owner", attemptId: 2, routeId: "ssh:fixture" };
  const status = {
    host: "fixture",
    state: "ready",
    runtimeVersion: null,
    requestedVersion: "1.0.0",
  } as const;
  const runtimeStatus = Atom.make<SshHostStatus | undefined>(undefined);
  const snapshot = {
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connecting",
    stage: "opening",
    attempt: 2,
    lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "SETUP TIMEOUT" }),
    failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
    sshRuntimeReady: {
      ...identity,
      operationId: "op",
      attachmentId: "attachment",
      runtimeStatus: status,
    },
  } as const;
  const projections = createEnvironmentPresentationAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([[local, { ...entry, enabled: true }]]),
    }),
    stateAtom: () => Atom.make(AsyncResult.success(snapshot)),
    serverConfigValueAtom: () => Atom.make(null),
    sshRuntimeStatusAtom: () => runtimeStatus,
  });
  const atom = projections.presentationAtom(local);
  const stop = registry.subscribe(atom, () => {});
  const draw = async () => {
    state.primaryConnection = registry.get(atom)!.connection;
    await fixture.rerender(<div />);
    await mount();
  };
  const banner = () => container.querySelector('[data-banner^="environment-unavailable:"]');
  try {
    await draw();
    expect(banner()?.textContent).toContain("Runtime ready · Opening connection");
    for (const state of ["failed", "stopped", "untrusted"] as const) {
      registry.set(runtimeStatus, { ...status, state });
      await draw();
      expect(banner()?.textContent).not.toContain("Runtime ready");
      expect(banner()?.textContent).toContain("SETUP TIMEOUT");
    }
  } finally {
    stop();
    registry.dispose();
  }
});

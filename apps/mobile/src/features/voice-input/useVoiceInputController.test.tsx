import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const focusedOwners = new Set<string>();
  const setOwnerFocused = (key: string, focused: boolean) => {
    if (focused) focusedOwners.add(key);
    else focusedOwners.delete(key);
  };
  return { focusedOwners, setOwnerFocused };
});

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]),
}));
vi.mock("./VoiceInputProvider", () => ({
  useGlobalVoiceInput: () => ({
    isAvailable: true,
    isAvailableForEnvironment: () => true,
    state: { phase: "idle" as const, error: null, errorAction: null },
    audioLevels: [],
    elapsedSeconds: 0,
    isBusy: false,
    ownerKey: null,
    label: null,
    focusedOwners: harness.focusedOwners,
    setOwnerFocused: harness.setOwnerFocused,
    session: {},
    stop: () => {},
    cancel: () => {},
  }),
}));

import { useVoiceInputController } from "./useVoiceInputController";

function Composer(props: { readonly hidden: boolean }) {
  useVoiceInputController({
    ownerKey: "thread-1",
    label: "Thread",
    readDraftMessage: () => "",
    subscribeToDraftChanges: () => () => {},
    selection: { start: 0, end: 0 },
    hidden: props.hidden,
    onChangeDraftMessage: () => {},
    onChangeSelection: () => {},
  });
  return null;
}

function setup() {
  harness.focusedOwners.clear();
  const root = createRoot(document.createElement("div"));
  return {
    isFocused: () => harness.focusedOwners.has("thread-1"),
    render: (hidden: boolean) => act(() => root.render(<Composer hidden={hidden} />)),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      harness.focusedOwners.clear();
    },
  };
}

// GlobalVoiceInputControl hides its dictation pill while the recording owner is focused, so a
// composer that stays mounted under display: none (e.g. behind an agent question) must unfocus.
it("unfocuses a hidden composer so the global dictation controls can show", () => {
  using voice = setup();

  voice.render(false);
  expect(voice.isFocused()).toBe(true);

  voice.render(true);
  expect(voice.isFocused()).toBe(false);

  voice.render(false);
  expect(voice.isFocused()).toBe(true);
});

import { describe, expect, it, vi } from "vite-plus/test";
import {
  createMediaPermissionPolicy,
  type MediaPermissionPolicyOptions,
  type MediaPermissionWebContents,
} from "./MediaPermissionPolicy.ts";

function contents(type = "window"): MediaPermissionWebContents & { destroyed: boolean } {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getType: () => type,
  };
}

function setup(overrides: Partial<MediaPermissionPolicyOptions<MediaPermissionWebContents>> = {}) {
  const main = contents();
  let current: MediaPermissionWebContents = main;
  let status = "not-determined";
  let answer: (granted: boolean) => void = () => undefined;
  const askForMicrophone = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const policy = createMediaPermissionPolicy({
    appScheme: "goat",
    appHost: "app",
    platform: "darwin",
    isCurrentMainWebContents: (webContents) => webContents === current,
    readMicrophoneStatus: () => status,
    askForMicrophone,
    ...overrides,
  });
  const audio = { isMainFrame: true, requestingUrl: "goat://app/threads/1", mediaTypes: ["audio"] };
  const request = (
    webContents: MediaPermissionWebContents,
    details: object = audio,
    permission = "media",
  ) =>
    new Promise<boolean[]>((resolve) => {
      const calls: boolean[] = [];
      policy.request(
        webContents,
        permission,
        (granted) => {
          calls.push(granted);
          queueMicrotask(() => resolve(calls));
        },
        details,
      );
    });
  return {
    main,
    policy,
    askForMicrophone,
    request,
    audio,
    setStatus: (next: string) => {
      status = next;
    },
    answer: (granted: boolean) => answer(granted),
    replaceMain: () => {
      current = contents();
    },
  };
}

describe("desktop microphone permission policy", () => {
  it("grants audio to GOAT's own main window after macOS allows it, asking once for concurrent requests", async () => {
    const session = setup();
    const first = session.request(session.main);
    const second = session.request(session.main);
    await Promise.resolve();
    expect(session.askForMicrophone).toHaveBeenCalledTimes(1);
    session.answer(true);
    expect(await first).toEqual([true]);
    expect(await second).toEqual([true]);
  });

  it("denies when macOS denies, without asking again, and reports the typed state", async () => {
    const session = setup();
    for (const [status, access] of [
      ["denied", "denied"],
      ["restricted", "restricted"],
      ["unknown", "unavailable"],
    ] as const) {
      session.setStatus(status);
      expect(await session.request(session.main)).toEqual([false]);
      expect(await session.policy.requestMicrophoneAccess()).toBe(access);
    }
    session.setStatus("granted");
    expect(await session.request(session.main)).toEqual([true]);
    expect(session.askForMicrophone).not.toHaveBeenCalled();
  });

  it("denies a request whose window was replaced while macOS was asking", async () => {
    const session = setup();
    const pending = session.request(session.main);
    await Promise.resolve();
    session.replaceMain();
    session.answer(true);
    expect(await pending).toEqual([false]);
  });

  it("treats a failed macOS prompt as unavailable and denies", async () => {
    const session = setup({ askForMicrophone: () => Promise.reject(new Error("tcc")) });
    expect(await session.policy.requestMicrophoneAccess()).toBe("unavailable");
    expect(await session.request(session.main)).toEqual([false]);
  });

  it("denies video, mixed, empty, subframe, foreign-origin, guest and destroyed requests without asking", async () => {
    const session = setup();
    session.setStatus("granted");
    const destroyed = contents();
    destroyed.destroyed = true;
    const cases: Array<[MediaPermissionWebContents, object]> = [
      [session.main, { ...session.audio, mediaTypes: ["video"] }],
      [session.main, { ...session.audio, mediaTypes: ["audio", "video"] }],
      [session.main, { ...session.audio, mediaTypes: [] }],
      [session.main, { ...session.audio, mediaTypes: undefined }],
      [session.main, { ...session.audio, isMainFrame: false }],
      [session.main, { ...session.audio, requestingUrl: "https://example.com/" }],
      [session.main, { ...session.audio, requestingUrl: "goat-dev://app/" }],
      [session.main, { ...session.audio, requestingUrl: "t3code://app/" }],
      [contents("webview"), session.audio],
      [contents(), session.audio],
      [destroyed, session.audio],
    ];
    for (const [webContents, details] of cases)
      expect(await session.request(webContents, details)).toEqual([false]);
    expect(session.askForMicrophone).not.toHaveBeenCalled();
  });

  it("keeps Electron's default for other permissions", async () => {
    const session = setup();
    expect(
      await session.request(
        session.main,
        { isMainFrame: true, requestingUrl: "goat://app/" },
        "notifications",
      ),
    ).toEqual([true]);
    expect(
      session.policy.check(session.main, "clipboard-read", "goat://app", { isMainFrame: true }),
    ).toBe(true);
  });

  it("answers media checks only for audio from the app's main frame", () => {
    const session = setup();
    const check = (
      webContents: MediaPermissionWebContents | null,
      origin: string,
      details: object,
    ) => session.policy.check(webContents, "media", origin, { isMainFrame: true, ...details });
    expect(check(session.main, "goat://app", { mediaType: "audio" })).toBe(true);
    expect(check(session.main, "goat://app", { mediaType: "video" })).toBe(false);
    expect(check(session.main, "goat://app", { mediaType: "unknown" })).toBe(false);
    expect(check(session.main, "goat://app", { mediaType: "audio", isMainFrame: false })).toBe(
      false,
    );
    expect(check(session.main, "https://example.com", { mediaType: "audio" })).toBe(false);
    expect(check(null, "goat://app", { mediaType: "audio" })).toBe(false);
    expect(check(contents("webview"), "goat://app", { mediaType: "audio" })).toBe(false);
  });

  it("leaves microphone access to Chromium outside macOS", async () => {
    const session = setup({ platform: "linux" });
    expect(await session.policy.requestMicrophoneAccess()).toBe("unsupported");
    expect(await session.request(session.main)).toEqual([true]);
    expect(session.askForMicrophone).not.toHaveBeenCalled();
  });
});

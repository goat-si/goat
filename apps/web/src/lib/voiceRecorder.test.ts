import { describe, expect, it, vi } from "vite-plus/test";
import { BrowserVoiceRecorder, VoiceMicrophoneError } from "./voiceRecorder";

type Processor = { onaudioprocess: ((event: unknown) => void) | null };

function setup(
  options: {
    access?: string | Promise<string>;
    mediaDevices?: boolean;
    platform?: string;
    getUserMediaError?: Error;
    close?: () => Promise<void>;
  } = {},
) {
  vi.useFakeTimers();
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => {
    if (options.getUserMediaError) throw options.getUserMediaError;
    return stream;
  });
  const processors: Processor[] = [];
  const close = vi.fn(options.close ?? (async () => undefined));
  class FakeAudioContext {
    sampleRate = 24_000;
    destination = {};
    resume = async () => undefined;
    close = close;
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createScriptProcessor = () => {
      const processor: Processor & { connect: () => void; disconnect: () => void } = {
        onaudioprocess: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      processors.push(processor);
      return processor;
    };
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  }
  const requestMicrophoneAccess = vi.fn(async () => options.access ?? "granted");
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "navigator",
    options.mediaDevices === false ? {} : { mediaDevices: { getUserMedia } },
  );
  vi.stubGlobal(
    "window",
    options.access === undefined
      ? {}
      : {
          desktopBridge: {
            requestMicrophoneAccess,
            getClientPlatform: () => options.platform ?? "darwin",
          },
        },
  );
  const onError = vi.fn();
  const recorder = new BrowserVoiceRecorder();
  const samples = (value: number) =>
    processors.at(-1)?.onaudioprocess?.({
      inputBuffer: {
        length: 2_048,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(2_048).fill(value),
      },
    });
  return {
    recorder,
    track,
    close,
    getUserMedia,
    requestMicrophoneAccess,
    onError,
    samples,
    [Symbol.dispose]: () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

describe("browser voice recorder", () => {
  it("stops with a no-input error when the microphone only delivers silence", async () => {
    using session = setup();
    await session.recorder.startRecording({ onError: session.onError });
    session.samples(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(session.onError).toHaveBeenCalledTimes(1);
    expect(session.onError.mock.calls[0]?.[0]).toMatchObject({ reason: "no-input" });
    expect(session.track.stop).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
    expect(session.recorder.getSnapshot().isRecording).toBe(false);
    session.samples(0.5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.onError).toHaveBeenCalledTimes(1);
  });

  it("drops the no-input error when the recording is cancelled while the device closes", async () => {
    let finishClose: () => void = () => undefined;
    using session = setup({
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    });
    await session.recorder.startRecording({ onError: session.onError });
    await vi.advanceTimersByTimeAsync(4_000);
    const cancelled = session.recorder.cancelRecording();
    finishClose();
    await cancelled;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.onError).not.toHaveBeenCalled();
  });

  it("gives Windows and Linux denials their own guidance", async () => {
    using session = setup({
      access: "unsupported",
      platform: "win32",
      getUserMediaError: Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    });
    const error = await session.recorder.startRecording().catch((cause) => cause);
    expect(error).toMatchObject({ reason: "permission-denied", opensSystemSettings: false });
    expect(error.message).not.toContain("System Settings");
    expect(error.message).toContain("privacy settings");
  });

  it("keeps recording once real audio arrives before the deadline", async () => {
    using session = setup();
    await session.recorder.startRecording({ onError: session.onError });
    session.samples(0.25);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.onError).not.toHaveBeenCalled();
    expect(session.recorder.getSnapshot().hasAudioSignal).toBe(true);
    expect(await session.recorder.stopRecording()).toMatchObject({ mimeType: "audio/wav" });
  });

  it("reports a macOS denial from the desktop bridge without opening the microphone", async () => {
    using session = setup({ access: "denied" });
    const error = await session.recorder
      .startRecording({ onError: session.onError })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(VoiceMicrophoneError);
    expect(error).toMatchObject({ reason: "permission-denied", opensSystemSettings: true });
    expect(session.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not offer System Settings for a restricted microphone", async () => {
    using session = setup({ access: "restricted" });
    const error = await session.recorder.startRecording().catch((cause) => cause);
    expect(error).toMatchObject({ reason: "permission-restricted", opensSystemSettings: false });
  });

  it("releases a microphone granted after the recording was cancelled", async () => {
    let grant: (access: string) => void = () => undefined;
    using session = setup({
      access: new Promise<string>((resolve) => {
        grant = resolve;
      }),
    });
    session.requestMicrophoneAccess.mockImplementation(
      () => new Promise((resolve) => (grant = resolve)),
    );
    const starting = session.recorder
      .startRecording({ onError: session.onError })
      .catch((cause) => cause);
    await Promise.resolve();
    await session.recorder.cancelRecording();
    grant("granted");
    await starting;
    expect(session.getUserMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.onError).not.toHaveBeenCalled();
  });

  it("explains that recording needs a secure connection", async () => {
    using session = setup({ mediaDevices: false });
    await expect(session.recorder.startRecording()).rejects.toMatchObject({
      reason: "insecure-context",
    });
  });
});

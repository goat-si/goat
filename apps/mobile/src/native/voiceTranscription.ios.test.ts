import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@goat/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
  languages: [] as unknown,
}));

vi.mock("react-native", () => ({ Settings: { get: () => mocks.languages } }));

vi.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  default: {
    isAvailable: mocks.isAvailable,
    prepare: mocks.prepare,
    transcribe: mocks.transcribe,
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.readAudio;
  },
}));

import { EnvironmentId } from "@goat/contracts";
import { getLocalVoiceTranscriber, getVoiceTranscriber } from "./voiceTranscription.ios";

const audio = new ArrayBuffer(4);
const nativeTranscript: TranscriptionResult = {
  duration: 2,
  segments: [
    { text: " Hej", startSecond: 0, endSecond: 1 },
    { text: "världen. ", startSecond: 1, endSecond: 2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.languages = [];
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("tries preferred languages in order before the app locale", async () => {
    mocks.languages = ["gsw-CH", "ko-KR", "en-US"];
    mocks.prepare.mockImplementation(async (locale) => {
      if (locale === "gsw-CH")
        throw Object.assign(new Error("unsupported"), {
          code: "AppleTranscriptionUnsupportedLocale",
        });
      return locale;
    });
    const prepared = await getLocalVoiceTranscriber()!.prepare({
      signal: new AbortController().signal,
    });
    expect(prepared.locale).toBe("ko-KR");
    expect(mocks.prepare.mock.calls.map(([locale]) => locale)).toEqual(["gsw-CH", "ko-KR"]);
  });

  it("tries the app locale after unsupported preferred languages", async () => {
    mocks.languages = ["gsw-CH"];
    const appLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    mocks.prepare.mockImplementation(async (locale) => {
      if (locale === "gsw-CH") {
        throw Object.assign(new Error("unsupported"), {
          code: "AppleTranscriptionUnsupportedLocale",
        });
      }
      return locale;
    });
    const prepared = await getLocalVoiceTranscriber()!.prepare({
      signal: new AbortController().signal,
    });
    expect(prepared.locale).toBe(appLocale);
    expect(mocks.prepare.mock.calls.map(([locale]) => locale)).toEqual(["gsw-CH", appLocale]);
  });

  it("falls back to the environment after all preferred languages are unsupported", async () => {
    mocks.languages = ["gsw-CH", "yi"];
    mocks.prepare.mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "AppleTranscriptionUnsupportedLocale" }),
    );
    const remote = {
      prepare: vi.fn(async () => ({ locale: "en", transcribe: async () => "remote" })),
    };
    const prepared = await getVoiceTranscriber(remote)!.prepare({
      signal: new AbortController().signal,
    });
    expect(
      await prepared.transcribe("file:///voice.m4a", { signal: new AbortController().signal }),
    ).toBe("remote");
    expect(mocks.prepare.mock.calls.map(([locale]) => locale).slice(0, 2)).toEqual([
      "gsw-CH",
      "yi",
    ]);
    expect(remote.prepare).toHaveBeenCalledOnce();
  });

  it("does not try another language after cancellation or a model failure", async () => {
    mocks.languages = ["ko-KR", "ja-JP"];
    mocks.prepare.mockRejectedValue(new Error("download failed"));
    await expect(
      getLocalVoiceTranscriber()!.prepare({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "preparation-failed" });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    mocks.prepare.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("unsupported"), {
        code: "AppleTranscriptionUnsupportedLocale",
      });
    });
    await expect(
      getLocalVoiceTranscriber()!.prepare({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });
  it("reports the device that actually transcribes, including the fallback to the environment", async () => {
    const options = { signal: new AbortController().signal };
    const environment = {
      kind: "environment" as const,
      environmentId: EnvironmentId.make("studio"),
      label: "Mac Studio",
    };
    const remote = {
      prepare: vi.fn(async () => ({
        locale: "sv-SE",
        transcribe: async () => "",
        location: environment,
      })),
    };
    expect((await getVoiceTranscriber(remote)!.prepare(options)).location).toEqual({
      kind: "this-device",
    });
    for (const code of ["AppleTranscriptionUnsupportedLocale", "AppleTranscriptionUnavailable"]) {
      mocks.prepare.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect((await getVoiceTranscriber(remote)!.prepare(options)).location).toEqual(environment);
    }
  });

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredRead.promise;
    controller.abort();
    readResult.resolve(audio);

    const error = await result;
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

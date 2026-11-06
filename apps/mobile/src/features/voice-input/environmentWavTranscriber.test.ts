import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, encodeMonoPcm16Wav, type VoiceTranscriptionInput } from "@goat/contracts";
import type { EnvironmentVoiceRequestContext } from "@goat/client-runtime/voice-input";
import { createEnvironmentWavTranscriber } from "./environmentWavTranscriber";

it("uploads canonical audio only while the selected environment grant remains current", async () => {
  const environmentId = EnvironmentId.make("environment-a");
  const context = { prepared: { environmentId, label: "A" } } as EnvironmentVoiceRequestContext;
  const wav = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
  if (!wav) throw new Error("Invalid fixture");
  let allowed = true;
  const upload = vi.fn(
    async (_context: EnvironmentVoiceRequestContext, _audio: VoiceTranscriptionInput) => " spoken ",
  );
  const transcriber = createEnvironmentWavTranscriber({
    environmentId,
    locale: "en-US",
    canSend: () => allowed,
    resolveContext: () => context,
    readAudio: async () => wav.bytes,
    upload,
  });
  const signal = new AbortController().signal;
  const prepared = await transcriber.prepare({ signal });
  expect(prepared.location).toEqual({ kind: "environment", environmentId, label: "A" });
  expect(await prepared.transcribe("file://recording", { signal })).toBe("spoken");
  expect(upload).toHaveBeenCalledOnce();
  expect(upload.mock.calls[0]?.[1]).toMatchObject({
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 1000,
  });
  allowed = false;
  await expect(prepared.transcribe("file://recording", { signal })).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(upload).toHaveBeenCalledOnce();
});

it("refuses an environment that changed before upload", async () => {
  const environmentId = EnvironmentId.make("environment-a");
  const wav = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
  if (!wav) throw new Error("Invalid fixture");
  let actual = environmentId;
  const upload = vi.fn(async () => "unexpected");
  const transcriber = createEnvironmentWavTranscriber({
    environmentId,
    locale: "en-US",
    canSend: () => true,
    resolveContext: () =>
      ({ prepared: { environmentId: actual, label: "A" } }) as EnvironmentVoiceRequestContext,
    readAudio: async () => {
      actual = EnvironmentId.make("environment-b");
      return wav.bytes;
    },
    upload,
  });
  const signal = new AbortController().signal;
  const prepared = await transcriber.prepare({ signal });
  await expect(prepared.transcribe("file://recording", { signal })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(upload).not.toHaveBeenCalled();
});

it("discards a recording if consent is revoked while audio is being read", async () => {
  const environmentId = EnvironmentId.make("environment-a");
  const wav = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
  if (!wav) throw new Error("Invalid fixture");
  let allowed = true;
  let complete: (bytes: Uint8Array) => void = () => {
    throw new Error("Read was not started");
  };
  const upload = vi.fn(async () => "unexpected");
  const transcriber = createEnvironmentWavTranscriber({
    environmentId,
    locale: "en-US",
    canSend: () => allowed,
    resolveContext: () =>
      ({ prepared: { environmentId, label: "A" } }) as EnvironmentVoiceRequestContext,
    readAudio: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    upload,
  });
  const signal = new AbortController().signal;
  const prepared = await transcriber.prepare({ signal });
  const pending = prepared.transcribe("file://recording", { signal });
  allowed = false;
  complete(wav.bytes);
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(upload).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vite-plus/test";
import { encodeMonoPcm16Wav, uint8ArrayToBase64 } from "./voiceRecorderEncoding";
import { BrowserVoiceRecorder, isVoiceRecordingCancelledError } from "./voiceRecorder";

describe("voice recorder WAV encoding", () => {
  it("writes canonical 24 kHz mono PCM16 headers and clamps samples", () => {
    const encoded = encodeMonoPcm16Wav([Float32Array.of(-2, -1, 0, 1, 2)], 24_000)!;
    const view = new DataView(
      encoded.bytes.buffer,
      encoded.bytes.byteOffset,
      encoded.bytes.byteLength,
    );
    expect(new TextDecoder().decode(encoded.bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(encoded.bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(46);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
      -32768, -32768, 0, 32767, 32767,
    ]);
  });

  it("interpolates across chunk boundaries identically to a contiguous capture", () => {
    const chunks = [Float32Array.of(0, 0.25), Float32Array.of(0.75, 1, -0.5)];
    const encoded = encodeMonoPcm16Wav(chunks, 32_000)!;
    expect(encoded).toEqual(encodeMonoPcm16Wav([Float32Array.of(0, 0.25, 0.75, 1, -0.5)], 32_000));
    const view = new DataView(
      encoded.bytes.buffer,
      encoded.bytes.byteOffset,
      encoded.bytes.byteLength,
    );
    expect(view.getInt16(46, true)).toBe(Math.round(Math.fround(0.25 + 0.5 / 3) * 32767));
    expect(encoded.sampleCount).toBe(4);
  });

  it("uses the actual input rate to compute the output samples and duration", () => {
    const encoded = encodeMonoPcm16Wav([new Float32Array(44_100)], 44_100)!;
    expect(encoded.sampleCount).toBe(24_000);
    expect(encoded.durationMs).toBe(1_000);
    expect(encoded.bytes.length).toBe(48_044);
    expect(encodeMonoPcm16Wav([], 48_000)).toBeNull();
    expect(encodeMonoPcm16Wav([Float32Array.of(1)], 0)).toBeNull();
  });

  it("base64 encodes precisely the selected byte range", () => {
    expect(uint8ArrayToBase64(Uint8Array.of(99, 0, 255, 128, 99).subarray(1, 4))).toBe("AP+A");
  });
});

function fakeMicrophone() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48_000,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => gain,
  };
  const permission = deferred<typeof stream>();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission.promise } });
  vi.stubGlobal("AudioContext", function () {
    return context;
  });
  const recorder = new BrowserVoiceRecorder();
  return {
    recorder,
    permission,
    stream,
    stop,
    source,
    processor,
    gain,
    context,
    frame: (...channels: Float32Array[]) =>
      processor.onaudioprocess?.({
        inputBuffer: {
          length: channels[0]!.length,
          numberOfChannels: channels.length,
          getChannelData: (index: number) => channels[index],
        },
      } as unknown as AudioProcessingEvent),
    [Symbol.asyncDispose]: async () => {
      await recorder.cancelRecording();
      vi.unstubAllGlobals();
    },
  };
}

describe("browser microphone lifecycle", () => {
  it("drops only initial digital silence, downmixes, streams WAV and releases all resources on stop", async () => {
    await using mic = fakeMicrophone();
    const onStreamingChunk = vi.fn();
    const start = mic.recorder.startRecording({ onStreamingChunk });
    mic.permission.resolve(mic.stream);
    await start;
    mic.frame(new Float32Array(48_000));
    expect(mic.recorder.getSnapshot().hasAudioSignal).toBe(false);
    mic.frame(new Float32Array(192_000).fill(0.5), new Float32Array(192_000).fill(0.25));
    expect(onStreamingChunk).toHaveBeenCalledOnce();
    expect(onStreamingChunk.mock.calls[0]![0]).toMatchObject({
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 4_000,
    });
    mic.frame(new Float32Array(48_000));
    const payload = await mic.recorder.stopRecording();
    expect(payload?.durationMs).toBe(5_000);
    const bytes = Buffer.from(payload!.audioBase64, "base64");
    expect(bytes.readInt16LE(44)).toBe(Math.round(0.375 * 32767));
    expect(bytes.readInt16LE(bytes.length - 2)).toBe(0);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.source.disconnect).toHaveBeenCalledOnce();
    expect(mic.processor.disconnect).toHaveBeenCalledOnce();
    expect(mic.gain.disconnect).toHaveBeenCalledOnce();
    expect(mic.context.close).toHaveBeenCalledOnce();
    expect(mic.processor.onaudioprocess).toBeNull();
  });

  it("releases a microphone granted after cancellation without creating an audio context", async () => {
    await using mic = fakeMicrophone();
    const start = mic.recorder.startRecording().catch((error: unknown) => error);
    await mic.recorder.cancelRecording();
    mic.permission.resolve(mic.stream);
    expect(isVoiceRecordingCancelledError(await start)).toBe(true);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.context.resume).not.toHaveBeenCalled();
  });

  it("releases the microphone immediately when cancelled while its audio context is resuming", async () => {
    await using mic = fakeMicrophone();
    const resumed = deferred<void>();
    mic.context.resume.mockImplementation(() => resumed.promise);
    const start = mic.recorder.startRecording().catch((error: unknown) => error);
    mic.permission.resolve(mic.stream);
    await mic.permission.promise;
    await mic.recorder.cancelRecording();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.context.close).toHaveBeenCalledOnce();
    resumed.resolve();
    expect(isVoiceRecordingCancelledError(await start)).toBe(true);
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("retains at most 160 waveform levels and stops publishing after cancellation", async () => {
    await using mic = fakeMicrophone();
    let tick = 0;
    using _time = vi.spyOn(performance, "now").mockImplementation(() => (tick += 100));
    const start = mic.recorder.startRecording();
    mic.permission.resolve(mic.stream);
    await start;
    for (let frame = 0; frame < 200; frame++) mic.frame(new Float32Array(2_048).fill(0.01));
    expect(mic.recorder.getSnapshot().waveformLevels).toHaveLength(160);
    const capture = mic.processor.onaudioprocess!;
    await mic.recorder.cancelRecording();
    const idle = mic.recorder.getSnapshot();
    capture({ inputBuffer: {} } as AudioProcessingEvent);
    expect(mic.recorder.getSnapshot()).toBe(idle);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

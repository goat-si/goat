import { expect, it } from "vite-plus/test";
import { encodeMonoPcm16Wav, VOICE_STREAM_MAX_AUDIO_BYTES } from "@goat/contracts";
import { StreamingPcmEncoder } from "./streamingPcmEncoder";

it("caps live audio at five minutes when the last capture buffer crosses the limit", () => {
  let bytes = 0;
  const encoder = new StreamingPcmEncoder(16_000, (frame) => {
    bytes += frame.byteLength;
  });
  encoder.push(new Float32Array(VOICE_STREAM_MAX_AUDIO_BYTES / 2 + 256));
  encoder.finish();
  expect(bytes).toBe(VOICE_STREAM_MAX_AUDIO_BYTES);
});

it("resamples continuously across input chunks and flushes the final partial frame", () => {
  const input = Float32Array.from({ length: 4_411 }, (_, index) => Math.sin(index / 19) * 0.5);
  const frames: Uint8Array[] = [];
  const encoder = new StreamingPcmEncoder(44_100, (frame) => frames.push(frame));
  encoder.push(input.subarray(0, 1_001));
  encoder.push(input.subarray(1_001, 3_007));
  encoder.push(input.subarray(3_007));
  encoder.finish();
  const expected = encodeMonoPcm16Wav([input], 44_100, 16_000);
  if (!expected) throw new Error("invalid audio fixture");
  expect(frames).toHaveLength(1);
  expect(frames[0]).toEqual(expected.bytes.subarray(44));
});

it("emits no more than one second per frame without dropping trailing audio", () => {
  const frames: Uint8Array[] = [];
  const encoder = new StreamingPcmEncoder(48_000, (frame) => frames.push(frame));
  encoder.push(new Float32Array(48_004).fill(0.5));
  encoder.finish();
  expect(frames.map((frame) => frame.byteLength)).toEqual([32_000, 2]);
  expect(frames.every((frame) => frame.byteLength <= 32_768)).toBe(true);
});

it("matches the batch PCM encoder for common microphone rates and short clips", () => {
  for (const rate of [8_000, 16_000, 44_100, 48_000, 192_000]) {
    for (const count of [1, 2, 4, 17, 79, 511]) {
      const input = Float32Array.from({ length: count }, (_, index) => Math.cos(index / 7));
      const frames: Uint8Array[] = [];
      const encoder = new StreamingPcmEncoder(rate, (frame) => frames.push(frame));
      for (let offset = 0; offset < input.length; offset += 13)
        encoder.push(input.subarray(offset, offset + 13));
      encoder.finish();
      const expected = encodeMonoPcm16Wav([input], rate, 16_000);
      if (!expected) throw new Error("invalid audio fixture");
      expect(Uint8Array.from(frames.flatMap((frame) => [...frame]))).toEqual(
        expected.bytes.subarray(44),
      );
    }
  }
});

it("rejects input rates that could produce multiple frames per capture slice", () => {
  expect(() => new StreamingPcmEncoder(7_999, () => {})).toThrow(
    "Unsupported microphone sample rate",
  );
});

import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VOICE_TRANSCRIPTION_MAX_BASE64_CHARS,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
} from "./voice.ts";

export interface EncodedMonoPcm16Wav {
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly sampleRateHz: number;
}

export interface ValidatedVoiceWav {
  readonly bytes: Uint8Array;
  readonly dataBytes: number;
  readonly sampleCount: number;
  readonly sampleRateHz: number;
  readonly sampleDurationMs: number;
}

const IS_LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

export function encodeMonoPcm16Wav(
  chunks: readonly Float32Array[],
  inputSampleRateHz: number,
  outputSampleRateHz: number = VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
): EncodedMonoPcm16Wav | null {
  if (
    !Number.isFinite(inputSampleRateHz) ||
    inputSampleRateHz <= 0 ||
    !Number.isFinite(outputSampleRateHz) ||
    outputSampleRateHz <= 0
  ) {
    return null;
  }

  let inputSampleCount = 0;
  for (const chunk of chunks) {
    inputSampleCount += chunk.length;
  }
  if (inputSampleCount === 0) {
    return null;
  }

  const inputSamplesPerOutputSample = inputSampleRateHz / outputSampleRateHz;
  const outputSampleCount = Math.max(1, Math.round(inputSampleCount / inputSamplesPerOutputSample));
  const buffer = new ArrayBuffer(44 + outputSampleCount * 2);
  const dataView = new DataView(buffer);
  writeWavHeader(dataView, outputSampleCount, outputSampleRateHz);
  const pcmSamples = IS_LITTLE_ENDIAN ? new Int16Array(buffer, 44, outputSampleCount) : null;

  let wavOffset = 44;
  let outputIndex = 0;
  if (inputSampleRateHz === outputSampleRateHz) {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (!chunk) continue;
      for (let sampleIndex = 0; sampleIndex < chunk.length; sampleIndex += 1) {
        const sample = chunk[sampleIndex] ?? 0;
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        if (pcmSamples) {
          pcmSamples[outputIndex] = Math.round(pcm);
        } else {
          dataView.setInt16(wavOffset, Math.round(pcm), true);
        }
        outputIndex += 1;
        wavOffset += 2;
      }
    }
  } else {
    let chunkIndex = 0;
    let chunkStart = 0;
    let chunk = chunks[0];
    const integerStride = Number.isInteger(inputSamplesPerOutputSample);
    for (let index = 0; index < outputSampleCount; index += 1) {
      const sourceIndex = index * inputSamplesPerOutputSample;
      const leftIndex = Math.floor(sourceIndex);
      while (chunk && leftIndex >= chunkStart + chunk.length && chunkIndex < chunks.length - 1) {
        chunkStart += chunk.length;
        chunkIndex += 1;
        chunk = chunks[chunkIndex];
      }
      const localIndex = leftIndex - chunkStart;
      const leftValue = chunk?.[localIndex] ?? 0;
      let sample = leftValue;
      if (!integerStride) {
        const rightValue =
          leftIndex >= inputSampleCount - 1
            ? leftValue
            : (chunk?.[localIndex + 1] ?? chunks[chunkIndex + 1]?.[0] ?? leftValue);
        sample = Math.fround(leftValue + (rightValue - leftValue) * (sourceIndex - leftIndex));
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (pcmSamples) {
        pcmSamples[index] = Math.round(pcm);
      } else {
        dataView.setInt16(wavOffset, Math.round(pcm), true);
      }
      wavOffset += 2;
    }
  }

  return {
    bytes: new Uint8Array(buffer),
    durationMs: Math.max(1, Math.round((outputSampleCount / outputSampleRateHz) * 1_000)),
    sampleCount: outputSampleCount,
    sampleRateHz: outputSampleRateHz,
  };
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array | null {
  const normalized = base64.trim().replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length > VOICE_TRANSCRIPTION_MAX_BASE64_CHARS ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    return null;
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const expectedLength = (normalized.length / 4) * 3 - padding;
  if (expectedLength <= 0 || expectedLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    return null;
  }
  try {
    const bin = atob(normalized);
    if (bin.length !== expectedLength) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function validateCanonicalVoiceWav(
  bytes: Uint8Array,
  declaredDurationMs?: number,
):
  | { readonly ok: true; readonly value: ValidatedVoiceWav }
  | { readonly ok: false; readonly reason: string } {
  if (bytes.byteLength <= 44) {
    return { ok: false, reason: "WAV payload is shorter than the 44-byte RIFF header." };
  }
  if (bytes.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    return { ok: false, reason: "WAV payload exceeds the 15 MiB size limit." };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    return { ok: false, reason: "WAV payload is missing the RIFF/WAVE header." };
  }
  const riffChunkSize = view.getUint32(4, true);
  const limit = riffChunkSize + 8;
  if (riffChunkSize < 36 || limit !== bytes.byteLength) {
    return { ok: false, reason: "RIFF chunk size does not match the WAV buffer length." };
  }

  let fmtFound = false;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;

  while (offset + 8 <= limit) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;
    const nextOffset = chunkDataEnd + (chunkSize % 2);
    if (chunkDataEnd > limit || nextOffset > limit) {
      return { ok: false, reason: `WAV chunk ${chunkId} exceeds RIFF bounds.` };
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        return { ok: false, reason: "WAV fmt chunk is smaller than 16 bytes." };
      }
      const audioFormat = view.getUint16(chunkDataStart, true);
      const numChannels = view.getUint16(chunkDataStart + 2, true);
      const sampleRate = view.getUint32(chunkDataStart + 4, true);
      const byteRate = view.getUint32(chunkDataStart + 8, true);
      const blockAlign = view.getUint16(chunkDataStart + 12, true);
      const bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (audioFormat !== 1) {
        return { ok: false, reason: "WAV audioFormat must be linear PCM (1)." };
      }
      if (numChannels !== 1) {
        return { ok: false, reason: "WAV audio must be mono (1 channel)." };
      }
      if (sampleRate !== VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ) {
        return { ok: false, reason: "WAV sampleRate must be 24000 Hz." };
      }
      if (
        bitsPerSample !== 16 ||
        blockAlign !== 2 ||
        byteRate !== VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ * 2
      ) {
        return {
          ok: false,
          reason: "WAV format must be 16-bit mono PCM (blockAlign=2, byteRate=48000).",
        };
      }
      fmtFound = true;
    } else if (chunkId === "data") {
      dataOffset = chunkDataStart;
      dataBytes = chunkSize;
      break;
    }
    offset = nextOffset;
  }

  if (!fmtFound) {
    return { ok: false, reason: "WAV payload is missing a valid fmt chunk." };
  }
  if (dataOffset < 0 || dataBytes <= 0 || dataBytes % 2 !== 0) {
    return {
      ok: false,
      reason: "WAV data chunk must contain a positive, even number of PCM16 bytes.",
    };
  }
  const sampleCount = dataBytes / 2;
  const sampleDurationMs = Math.max(
    1,
    Math.round((sampleCount / VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ) * 1_000),
  );
  if (sampleDurationMs > VOICE_TRANSCRIPTION_MAX_DURATION_MS) {
    return { ok: false, reason: "WAV duration exceeds the 300-second limit." };
  }
  if (declaredDurationMs !== undefined) {
    if (
      !Number.isFinite(declaredDurationMs) ||
      declaredDurationMs <= 0 ||
      declaredDurationMs > VOICE_TRANSCRIPTION_MAX_DURATION_MS
    ) {
      return { ok: false, reason: "Declared durationMs is out of bounds." };
    }
    if (Math.abs(declaredDurationMs - sampleDurationMs) > 250) {
      return { ok: false, reason: "Declared durationMs does not match WAV sample count." };
    }
  }
  return {
    ok: true,
    value: {
      bytes,
      dataBytes,
      sampleCount,
      sampleRateHz: VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
      sampleDurationMs,
    },
  };
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function writeWavHeader(view: DataView, sampleCount: number, sampleRateHz: number): void {
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

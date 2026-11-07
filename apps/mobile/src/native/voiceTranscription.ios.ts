import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";
import { Settings } from "react-native";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@goat/client-runtime/voice-input";

function getPreferredLocales(): string[] {
  const languages: unknown = Settings.get("AppleLanguages");
  const preferred = Array.isArray(languages)
    ? languages.filter(
        (language): language is string => typeof language === "string" && language.length > 0,
      )
    : [];
  return [...new Set([...preferred, Intl.DateTimeFormat().resolvedOptions().locale])];
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }

  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  const locales = getPreferredLocales();
  if (!AppleTranscription.isAvailable(locales[0] ?? "")) return null;
  return {
    prepareWhileRecording: true,
    prepare: (options) => prepareVoiceTranscription(locales, options),
  };
}

export function getVoiceTranscriber(
  remoteTranscriber?: VoiceTranscriber | null,
): VoiceTranscriber | null {
  const local = getLocalVoiceTranscriber();
  if (!local) return remoteTranscriber ?? null;
  if (!remoteTranscriber) return local;
  return {
    prepareWhileRecording: true,
    prepare: async (options) => {
      try {
        return await local.prepare(options);
      } catch (error) {
        throwIfVoiceTranscriptionAborted(options.signal);
        if (
          error instanceof VoiceTranscriptionError &&
          (error.code === "unavailable" || error.code === "unsupported-locale")
        ) {
          return remoteTranscriber.prepare(options);
        }
        throw error;
      }
    },
  };
}

async function prepareVoiceTranscription(
  locales: readonly string[],
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locales[0] ?? "")) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  let unsupported: VoiceTranscriptionError | undefined;
  for (const locale of locales) {
    try {
      return await prepareLocale(locale, signal);
    } catch (error) {
      if (!(error instanceof VoiceTranscriptionError) || error.code !== "unsupported-locale")
        throw error;
      unsupported = error;
    }
  }
  throw (
    unsupported ??
    new VoiceTranscriptionError(
      "unsupported-locale",
      "Voice transcription does not support any of your languages.",
    )
  );
}

async function prepareLocale(
  locale: string,
  signal: AbortSignal,
): Promise<PreparedVoiceTranscription> {
  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: supportedLocale,
      location: { kind: "this-device" },
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support any of your languages.",
        { cause: error },
      );
    }
    if (getNativeErrorCode(error) === "AppleTranscriptionUnavailable") {
      throw new VoiceTranscriptionError(
        "unavailable",
        "Local voice transcription is unavailable.",
        {
          cause: error,
        },
      );
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}

import { getLanguageLabel, isSupportedLanguage, SOURCE_AUTO } from "@/lib/realtime/languages";

export const GROQ_TRANSLATE_MODEL = "openai/gpt-oss-20b";
export const GROQ_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
export const GROQ_TTS_MODEL_EN = "canopylabs/orpheus-v1-english";
export const GROQ_TTS_MODEL_AR = "canopylabs/orpheus-arabic-saudi";

export const GROQ_ENGLISH_VOICES = [
  "autumn",
  "diana",
  "hannah",
  "austin",
  "daniel",
  "troy",
] as const;

export const GROQ_ARABIC_VOICES = ["fahad", "sultan", "lulwa", "noura"] as const;

export const REALTIME_MODEL = GROQ_TRANSLATE_MODEL;
export const REALTIME_TRANSCRIBE_MODEL = GROQ_TRANSCRIBE_MODEL;
export const REALTIME_VOICES = [...GROQ_ENGLISH_VOICES, ...GROQ_ARABIC_VOICES] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number];
export type SourceLanguageCode = typeof SOURCE_AUTO | string;
export type RealtimeMode = "translate" | "interpret";

const ENGLISH_VOICE_SET = new Set<string>(GROQ_ENGLISH_VOICES);
const ARABIC_VOICE_SET = new Set<string>(GROQ_ARABIC_VOICES);

export function parseSourceLanguage(input: string | null): SourceLanguageCode {
  const value = (input ?? SOURCE_AUTO).trim().toLowerCase();

  if (value === SOURCE_AUTO) {
    return SOURCE_AUTO;
  }

  if (!isSupportedLanguage(value)) {
    throw new Error(`Unsupported source language: ${value}`);
  }

  return value;
}

export function parseTargetLanguage(input: string | null): string {
  const value = input?.trim().toLowerCase() ?? "";

  if (!value) {
    throw new Error("Target language is required.");
  }

  if (!isSupportedLanguage(value)) {
    throw new Error(`Unsupported target language: ${value}`);
  }

  return value;
}

export function parseVoice(input: string | null): RealtimeVoice {
  const value = (input ?? REALTIME_VOICES[0]).trim().toLowerCase();
  const matched = REALTIME_VOICES.find((voice) => voice.toLowerCase() === value);

  if (!matched) {
    throw new Error(`Unsupported voice: ${value}`);
  }

  return matched;
}

export function buildTranslationInstructions(source: SourceLanguageCode, target: string) {
  const targetLabel = getLanguageLabel(target);
  const sourceGuidance =
    source === SOURCE_AUTO
      ? "Detect the source language automatically."
      : `The source language is ${getLanguageLabel(source)}.`;

  return [
    "You are a precise translation engine for spoken utterances.",
    sourceGuidance,
    `Translate the provided text into ${targetLabel}.`,
    "Preserve meaning, tone, and punctuation.",
    "Do not explain, answer questions, or add commentary.",
    `Return only the translated ${targetLabel} text.`,
  ].join(" ");
}

export function supportsGroqSpeech(target: string) {
  return target === "en" || target === "ar";
}

export function resolveGroqSpeechVoice(target: string, preferredVoice: RealtimeVoice) {
  if (target === "en") {
    return ENGLISH_VOICE_SET.has(preferredVoice) ? preferredVoice : GROQ_ENGLISH_VOICES[0];
  }

  if (target === "ar") {
    return ARABIC_VOICE_SET.has(preferredVoice) ? preferredVoice : GROQ_ARABIC_VOICES[0];
  }

  return null;
}

export function describeSpeechProvider(target: string) {
  if (supportsGroqSpeech(target)) {
    return "Groq TTS";
  }

  return "Browser speech fallback";
}

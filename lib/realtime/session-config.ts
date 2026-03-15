import { getLanguageLabel, isSupportedLanguage, SOURCE_AUTO } from "@/lib/realtime/languages";

export const XAI_REALTIME_MODEL = "grok-beta";
export const XAI_REALTIME_VOICES = ["Eve", "Caleb", "Iris", "Jace", "Maya", "Noah"] as const;

export const REALTIME_MODEL = XAI_REALTIME_MODEL;
export const REALTIME_VOICES = XAI_REALTIME_VOICES;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number];
export type SourceLanguageCode = typeof SOURCE_AUTO | string;
export type RealtimeMode = "translate" | "interpret";

export function parseSourceLanguage(input: string | null): SourceLanguageCode {
  const value = (input ?? SOURCE_AUTO).trim().toLowerCase();

  if (value === SOURCE_AUTO) {
    return SOURCE_AUTO;
  }

  if (!isSupportedLanguage(value)) {
    throw new Error(`지원하지 않는 원본 언어: ${value}`);
  }

  return value;
}

export function parseTargetLanguage(input: string | null): string {
  const value = input?.trim().toLowerCase() ?? "";

  if (!value) {
    throw new Error("대상 언어가 필요합니다.");
  }

  if (!isSupportedLanguage(value)) {
    throw new Error(`지원하지 않는 대상 언어: ${value}`);
  }

  return value;
}

export function parseVoice(input: string | null): RealtimeVoice {
  const value = (input ?? REALTIME_VOICES[0]).trim();
  const matched = REALTIME_VOICES.find((voice) => voice === value);

  if (!matched) {
    throw new Error(`지원하지 않는 음성: ${value}`);
  }

  return matched;
}

export function buildTranslationInstructions(source: SourceLanguageCode, target: string) {
  const targetLabel = getLanguageLabel(target);
  const sourceGuidance =
    source === SOURCE_AUTO
      ? "원본 언어를 자동으로 감지하세요."
      : `원본 언어는 ${getLanguageLabel(source)}입니다.`;

  return [
    "당신은 정밀한 실시간 음성 통역 엔진입니다.",
    sourceGuidance,
    `사용자의 말을 ${targetLabel}로 즉시 번역하세요.`,
    "의미, 어조, 구두점을 보존하세요.",
    "설명이나 부가적인 답변은 하지 마세요.",
    `${targetLabel}로 번역된 텍스트만 출력하세요.`,
  ].join(" ");
}

export function describeSpeechProvider() {
  return "xAI Voice Agent (Realtime)";
}

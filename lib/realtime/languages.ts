export type LanguageOption = {
  code: string;
  label: string;
};

export const SOURCE_AUTO = "auto";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "ar", label: "아랍어" },
  { code: "zh", label: "중국어" },
  { code: "nl", label: "네덜란드어" },
  { code: "en", label: "영어" },
  { code: "fr", label: "프랑스어" },
  { code: "de", label: "독일어" },
  { code: "hi", label: "힌디어" },
  { code: "id", label: "인도네시아어" },
  { code: "it", label: "이탈리아어" },
  { code: "ja", label: "일본어" },
  { code: "ko", label: "한국어" },
  { code: "pl", label: "폴란드어" },
  { code: "pt", label: "포르투갈어" },
  { code: "ru", label: "러시아어" },
  { code: "es", label: "스페인어" },
  { code: "th", label: "태국어" },
  { code: "tr", label: "터키어" },
  { code: "uk", label: "우크라이나어" },
  { code: "vi", label: "베트남어" },
];

const LANGUAGE_MAP = new Map(LANGUAGE_OPTIONS.map((option) => [option.code, option.label]));

export function isSupportedLanguage(code: string): boolean {
  return LANGUAGE_MAP.has(code);
}

export function getLanguageLabel(code: string): string {
  if (code === SOURCE_AUTO) {
    return "자동 감지";
  }

  return LANGUAGE_MAP.get(code) ?? code;
}

export type LanguageOption = {
  code: string;
  label: string;
};

export const SOURCE_AUTO = "auto";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "es", label: "Spanish" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "vi", label: "Vietnamese" },
];

const LANGUAGE_MAP = new Map(LANGUAGE_OPTIONS.map((option) => [option.code, option.label]));

export function isSupportedLanguage(code: string): boolean {
  return LANGUAGE_MAP.has(code);
}

export function getLanguageLabel(code: string): string {
  if (code === SOURCE_AUTO) {
    return "Auto-detect";
  }

  return LANGUAGE_MAP.get(code) ?? code;
}

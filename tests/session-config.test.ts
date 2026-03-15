import { describe, expect, it } from "vitest";

import {
  buildTranslationInstructions,
  describeSpeechProvider,
  GROQ_TTS_MODEL_AR,
  GROQ_TTS_MODEL_EN,
  parseVoice,
  REALTIME_MODEL,
  REALTIME_TRANSCRIBE_MODEL,
  resolveGroqSpeechVoice,
  supportsGroqSpeech,
} from "@/lib/realtime/session-config";

describe("session config", () => {
  it("exposes the current Groq transcription and translation models", () => {
    expect(REALTIME_MODEL).toBe("openai/gpt-oss-20b");
    expect(REALTIME_TRANSCRIBE_MODEL).toBe("whisper-large-v3-turbo");
    expect(GROQ_TTS_MODEL_EN).toBe("canopylabs/orpheus-v1-english");
    expect(GROQ_TTS_MODEL_AR).toBe("canopylabs/orpheus-arabic-saudi");
  });

  it("builds strict translation-only instructions", () => {
    const instructions = buildTranslationInstructions("auto", "ko");
    expect(instructions).toContain("Translate the provided text into Korean.");
    expect(instructions).toContain("Return only the translated Korean text.");
  });
});

describe("speech support", () => {
  it("marks only english and arabic as direct Groq TTS targets", () => {
    expect(supportsGroqSpeech("en")).toBe(true);
    expect(supportsGroqSpeech("ar")).toBe(true);
    expect(supportsGroqSpeech("ko")).toBe(false);
  });

  it("resolves an english Groq voice and falls back across language families", () => {
    expect(resolveGroqSpeechVoice("en", "autumn")).toBe("autumn");
    expect(resolveGroqSpeechVoice("en", "fahad")).toBe("autumn");
    expect(resolveGroqSpeechVoice("ar", "fahad")).toBe("fahad");
    expect(resolveGroqSpeechVoice("ar", "autumn")).toBe("fahad");
    expect(resolveGroqSpeechVoice("ko", "autumn")).toBeNull();
  });

  it("describes the fallback speech provider for unsupported targets", () => {
    expect(describeSpeechProvider("en")).toBe("Groq TTS");
    expect(describeSpeechProvider("ko")).toBe("Browser speech fallback");
  });
});

describe("parseVoice", () => {
  it("accepts case-insensitive Groq voice names", () => {
    expect(parseVoice("autumn")).toBe("autumn");
    expect(parseVoice("Fahad")).toBe("fahad");
  });
});

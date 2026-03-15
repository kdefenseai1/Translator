import {
  buildTranslationInstructions,
  type RealtimeVoice,
  type SourceLanguageCode,
  GROQ_TRANSCRIBE_MODEL,
  GROQ_TRANSLATE_MODEL,
  GROQ_TTS_MODEL_AR,
  GROQ_TTS_MODEL_EN,
  parseSourceLanguage,
  parseTargetLanguage,
  parseVoice,
  resolveGroqSpeechVoice,
  supportsGroqSpeech,
} from "@/lib/realtime/session-config";

export class GroqApiError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "GroqApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TTS_MAX_CHARS = 180;

export type SpeechProvider = "groq" | "browser" | "none";

export type ProcessTurnParams = {
  audioFile: File;
  source: SourceLanguageCode;
  target: string;
  mode: "translate" | "interpret";
  voice: RealtimeVoice;
};

export type ProcessTurnResult = {
  transcript: string;
  translation: string;
  confidence: number | null;
  audioChunks: string[];
  audioMimeType: string | null;
  speechProvider: SpeechProvider;
  note: string | null;
};

type GroqTranscriptionResponse = {
  text?: string;
  segments?: Array<{
    avg_logprob?: number;
  }>;
};

function getGroqApiKey() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new GroqApiError("GROQ_API_KEY is not configured.", 500);
  }

  return apiKey;
}

export function isRetryableStatus(status: number) {
  return RETRYABLE_STATUSES.has(status);
}

export function normalizeGroqErrorMessage(
  bodyText: string,
  status: number,
  contentType: string | null,
) {
  if (contentType?.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: string | { message?: string };
        message?: string;
      };

      if (typeof parsed.error === "string") {
        return parsed.error;
      }

      if (
        parsed.error &&
        typeof parsed.error === "object" &&
        typeof parsed.error.message === "string"
      ) {
        return parsed.error.message;
      }

      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    } catch {
      return bodyText || `Groq API request failed with status ${status}.`;
    }
  }

  if (contentType?.includes("text/html") || /^\s*<!doctype html/i.test(bodyText)) {
    const compactText = bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return compactText || `Groq API request failed with status ${status}.`;
  }

  return bodyText || `Groq API request failed with status ${status}.`;
}

async function groqFetch(input: string, init: RequestInit) {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    const bodyText = await response.text();
    throw new GroqApiError(
      normalizeGroqErrorMessage(bodyText, response.status, contentType),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  return response;
}

function estimateConfidence(transcription: GroqTranscriptionResponse) {
  const values = (transcription.segments ?? [])
    .map((segment) => segment.avg_logprob)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  const averageProbability =
    values.reduce((sum, value) => sum + Math.exp(Math.max(-20, Math.min(0, value))), 0) /
    values.length;

  return Number(averageProbability.toFixed(3));
}

export async function transcribeAudioTurn({
  audioFile,
  source,
}: {
  audioFile: File;
  source: SourceLanguageCode;
}) {
  const formData = new FormData();
  formData.append("file", audioFile, audioFile.name || "turn.webm");
  formData.append("model", GROQ_TRANSCRIBE_MODEL);
  formData.append("response_format", "verbose_json");
  formData.append("temperature", "0");

  if (source !== "auto") {
    formData.append("language", source);
  }

  const response = await groqFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getGroqApiKey()}`,
    },
    body: formData,
  });

  const parsed = (await response.json()) as GroqTranscriptionResponse;

  return {
    transcript: parsed.text?.trim() ?? "",
    confidence: estimateConfidence(parsed),
  };
}

function readCompletionText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (
          entry &&
          typeof entry === "object" &&
          "text" in entry &&
          typeof entry.text === "string"
        ) {
          return entry.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

export async function translateTextTurn({
  transcript,
  source,
  target,
}: {
  transcript: string;
  source: SourceLanguageCode;
  target: string;
}) {
  const response = await groqFetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getGroqApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_TRANSLATE_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: buildTranslationInstructions(source, target),
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    }),
  });

  const parsed = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };

  const translation = readCompletionText(parsed.choices?.[0]?.message?.content);

  if (!translation) {
    throw new GroqApiError("Groq did not return a translated text response.", 502);
  }

  return translation;
}

export function chunkTextForSpeech(text: string, maxChars = TTS_MAX_CHARS) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) {
      chunks.push(value);
    }
    current = "";
  };

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.length > maxChars) {
      pushCurrent();

      const words = trimmed.split(" ");
      let line = "";

      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length <= maxChars) {
          line = candidate;
        } else {
          if (line) {
            chunks.push(line);
          }
          line = word;
        }
      }

      if (line) {
        chunks.push(line);
      }

      continue;
    }

    const candidate = current ? `${current} ${trimmed}` : trimmed;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      pushCurrent();
      current = trimmed;
    }
  }

  pushCurrent();
  return chunks;
}

export async function synthesizeSpeech({
  text,
  target,
  voice,
}: {
  text: string;
  target: string;
  voice: RealtimeVoice;
}) {
  if (!supportsGroqSpeech(target)) {
    return {
      audioChunks: [],
      audioMimeType: null,
      speechProvider: "browser" as const,
      note: "Groq TTS currently supports English and Arabic. Using browser speech synthesis instead.",
    };
  }

  const resolvedVoice = resolveGroqSpeechVoice(target, voice);
  const model = target === "ar" ? GROQ_TTS_MODEL_AR : GROQ_TTS_MODEL_EN;
  const chunks = chunkTextForSpeech(text);

  if (!resolvedVoice || chunks.length === 0) {
    return {
      audioChunks: [],
      audioMimeType: null,
      speechProvider: "none" as const,
      note: null,
    };
  }

  const audioChunks: string[] = [];

  try {
    for (const chunk of chunks) {
      const response = await groqFetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getGroqApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice: resolvedVoice,
          input: chunk,
          response_format: "wav",
        }),
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      audioChunks.push(buffer.toString("base64"));
    }
  } catch (error) {
    if (error instanceof GroqApiError) {
      return {
        audioChunks: [],
        audioMimeType: null,
        speechProvider: "browser" as const,
        note: `Groq TTS is unavailable for this account right now (${error.message}). Using browser speech synthesis instead.`,
      };
    }

    throw error;
  }

  return {
    audioChunks,
    audioMimeType: "audio/wav",
    speechProvider: "groq" as const,
    note: null,
  };
}

export async function processSpeechTurn({
  audioFile,
  source,
  target,
  mode,
  voice,
}: ProcessTurnParams): Promise<ProcessTurnResult> {
  parseSourceLanguage(source);
  parseTargetLanguage(target);
  const normalizedVoice = parseVoice(voice);

  const { transcript, confidence } = await transcribeAudioTurn({ audioFile, source });

  if (!transcript) {
    return {
      transcript: "",
      translation: "",
      confidence,
      audioChunks: [],
      audioMimeType: null,
      speechProvider: "none",
      note: null,
    };
  }

  const translation = await translateTextTurn({ transcript, source, target });

  if (mode !== "interpret") {
    return {
      transcript,
      translation,
      confidence,
      audioChunks: [],
      audioMimeType: null,
      speechProvider: "none",
      note: null,
    };
  }

  const speech = await synthesizeSpeech({
    text: translation,
    target,
    voice: normalizedVoice,
  });

  return {
    transcript,
    translation,
    confidence,
    audioChunks: speech.audioChunks,
    audioMimeType: speech.audioMimeType,
    speechProvider: speech.speechProvider,
    note: speech.note,
  };
}

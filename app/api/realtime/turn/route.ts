import { NextRequest, NextResponse } from "next/server";

import { processSpeechTurn, GroqApiError } from "@/lib/realtime/groq";
import { parseSourceLanguage, parseTargetLanguage, parseVoice } from "@/lib/realtime/session-config";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const source = parseSourceLanguage(url.searchParams.get("source"));
    const target = parseTargetLanguage(url.searchParams.get("target"));
    const mode = url.searchParams.get("mode") === "interpret" ? "interpret" : "translate";
    const voice = parseVoice(url.searchParams.get("voice"));

    const formData = await request.formData();
    const audio = formData.get("audio");

    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "Audio file is required." }, { status: 400 });
    }

    const result = await processSpeechTurn({
      audioFile: audio,
      source,
      target,
      mode,
      voice,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GroqApiError) {
      return NextResponse.json(
        { error: error.message, retryable: error.retryable, status: error.status },
        { status: error.status },
      );
    }

    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}

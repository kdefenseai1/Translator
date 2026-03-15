import { NextResponse } from "next/server";

export async function POST() {
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "XAI_API_KEY is not configured." }, { status: 500 });
  }

  try {
    const response = await fetch("https://api.x.ai/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-beta",
        modalities: ["audio", "text"],
        instructions: "You are a helpful translation assistant. Listen to the user and translate their speech as requested.",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json({ error: `xAI API error: ${error}` }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "Failed to create xAI session." }, { status: 500 });
  }
}

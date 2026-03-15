import { describe, expect, it } from "vitest";

import {
  chunkTextForSpeech,
  isRetryableStatus,
  normalizeGroqErrorMessage,
} from "@/lib/realtime/groq";

describe("normalizeGroqErrorMessage", () => {
  it("returns a compact message for html gateway failures", () => {
    const message = normalizeGroqErrorMessage(
      "<!DOCTYPE html><html><head><title>api.groq.com | 504: Gateway time-out</title></head></html>",
      504,
      "text/html",
    );

    expect(message).toContain("504");
    expect(message).not.toContain("<html>");
  });

  it("extracts nested json error messages", () => {
    const message = normalizeGroqErrorMessage(
      JSON.stringify({ error: { message: "bad request" } }),
      400,
      "application/json",
    );

    expect(message).toBe("bad request");
  });
});

describe("isRetryableStatus", () => {
  it("marks transient Groq upstream statuses as retryable", () => {
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});

describe("chunkTextForSpeech", () => {
  it("splits long text into speech-safe chunks", () => {
    const chunks = chunkTextForSpeech(
      "One short sentence. Two short sentence. Three short sentence. Four short sentence.",
      24,
    );

    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

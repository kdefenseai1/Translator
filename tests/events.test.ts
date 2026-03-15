import { describe, expect, it } from "vitest";

import {
  createSourceTranscriptState,
  createTranslationState,
  reduceSourceTranscript,
  reduceTranslationState,
  selectOrderedSourceTurns,
  selectTranslationTurns,
} from "@/lib/realtime/events";

describe("reduceTranslationState", () => {
  it("accumulates text deltas and finalizes translated text turns", () => {
    let state = createTranslationState();

    state = reduceTranslationState(state, {
      type: "response.output_text.delta",
      response_id: "response-1",
      item_id: "item-1",
      content_index: 0,
      delta: "Hello ",
    });

    state = reduceTranslationState(state, {
      type: "response.output_text.delta",
      response_id: "response-1",
      item_id: "item-1",
      content_index: 0,
      delta: "world",
    });

    state = reduceTranslationState(state, {
      type: "response.output_text.done",
      response_id: "response-1",
      item_id: "item-1",
      content_index: 0,
      text: "Hello world",
    });

    expect(selectTranslationTurns(state, "text")).toEqual([
      {
        id: "text:response-1:item-1:0",
        kind: "text",
        text: "Hello world",
        isFinal: true,
        order: 0,
      },
    ]);
  });
});

describe("reduceSourceTranscript", () => {
  it("orders finalized transcript turns by committed item order even if completions arrive out of order", () => {
    let state = createSourceTranscriptState();

    state = reduceSourceTranscript(state, {
      type: "input_audio_buffer.committed",
      item_id: "item-1",
      previous_item_id: null,
    });

    state = reduceSourceTranscript(state, {
      type: "input_audio_buffer.committed",
      item_id: "item-2",
      previous_item_id: "item-1",
    });

    state = reduceSourceTranscript(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "second sentence",
      logprobs: [{ token: "second", logprob: -0.05 }],
    });

    state = reduceSourceTranscript(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "first sentence",
      logprobs: [{ token: "first", logprob: -0.12 }],
    });

    expect(selectOrderedSourceTurns(state)).toEqual([
      {
        itemId: "item-1",
        text: "first sentence",
        isFinal: true,
        confidence: 0.887,
      },
      {
        itemId: "item-2",
        text: "second sentence",
        isFinal: true,
        confidence: 0.951,
      },
    ]);
  });

  it("drops whitespace-only interim transcript turns from the rendered list", () => {
    let state = createSourceTranscriptState();

    state = reduceSourceTranscript(state, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "   ",
    });

    expect(selectOrderedSourceTurns(state)).toEqual([]);
  });
});

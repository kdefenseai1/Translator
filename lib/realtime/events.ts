export type RealtimeClientEvent = {
  type: string;
  [key: string]: unknown;
};

type SourceTranscriptTurn = {
  itemId: string;
  previousItemId: string | null;
  partialText: string;
  finalText: string | null;
  confidence: number | null;
  committedOrder: number;
  seenOrder: number;
};

export type SourceTranscriptState = {
  turnsById: Record<string, SourceTranscriptTurn>;
  committedIds: string[];
  nextOrder: number;
};

type TranslationSegmentKind = "text" | "audio";

type TranslationSegment = {
  key: string;
  kind: TranslationSegmentKind;
  text: string;
  startedOrder: number;
};

export type TranslationTurn = {
  id: string;
  kind: TranslationSegmentKind;
  text: string;
  isFinal: boolean;
  order: number;
};

export type TranslationState = {
  activeByKey: Record<string, TranslationSegment>;
  activeOrder: string[];
  finalized: TranslationTurn[];
  nextOrder: number;
};

export function createSourceTranscriptState(): SourceTranscriptState {
  return {
    turnsById: {},
    committedIds: [],
    nextOrder: 0,
  };
}

export function createTranslationState(): TranslationState {
  return {
    activeByKey: {},
    activeOrder: [],
    finalized: [],
    nextOrder: 0,
  };
}

function readString(event: RealtimeClientEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(event: RealtimeClientEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" ? value : undefined;
}

function getOrCreateSourceTurn(
  state: SourceTranscriptState,
  itemId: string,
): [SourceTranscriptTurn, number] {
  const existing = state.turnsById[itemId];

  if (existing) {
    return [existing, state.nextOrder];
  }

  return [
    {
      itemId,
      previousItemId: null,
      partialText: "",
      finalText: null,
      confidence: null,
      committedOrder: Number.MAX_SAFE_INTEGER,
      seenOrder: state.nextOrder,
    },
    state.nextOrder + 1,
  ];
}

function collectLogprobValues(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectLogprobValues(entry));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, entryValue]) => {
    if (key === "logprob" && typeof entryValue === "number" && Number.isFinite(entryValue)) {
      return [entryValue];
    }

    return collectLogprobValues(entryValue);
  });
}

function estimateConfidenceFromEvent(event: RealtimeClientEvent): number | null {
  const values = collectLogprobValues(event.logprobs);

  if (values.length === 0) {
    return null;
  }

  const averageProbability =
    values.reduce((sum, value) => sum + Math.exp(Math.max(-20, Math.min(0, value))), 0) /
    values.length;

  return Number(averageProbability.toFixed(3));
}

export function reduceSourceTranscript(
  state: SourceTranscriptState,
  event: RealtimeClientEvent | { type: "__reset" },
): SourceTranscriptState {
  if (event.type === "__reset") {
    return createSourceTranscriptState();
  }

  if (event.type === "input_audio_buffer.committed") {
    const itemId = readString(event, "item_id");

    if (!itemId) {
      return state;
    }

    const [currentTurn, nextOrder] = getOrCreateSourceTurn(state, itemId);
    const committedIds = state.committedIds.includes(itemId)
      ? state.committedIds
      : [...state.committedIds, itemId];

    return {
      turnsById: {
        ...state.turnsById,
        [itemId]: {
          ...currentTurn,
          previousItemId: readString(event, "previous_item_id") ?? currentTurn.previousItemId,
          committedOrder: committedIds.indexOf(itemId),
        },
      },
      committedIds,
      nextOrder,
    };
  }

  if (
    event.type === "conversation.item.input_audio_transcription.delta" ||
    event.type === "conversation.item.input_audio_transcription.completed"
  ) {
    const itemId = readString(event, "item_id");

    if (!itemId) {
      return state;
    }

    const [currentTurn, nextOrder] = getOrCreateSourceTurn(state, itemId);

    if (event.type === "conversation.item.input_audio_transcription.delta") {
      const delta = readString(event, "delta") ?? "";

      return {
        ...state,
        turnsById: {
          ...state.turnsById,
          [itemId]: {
            ...currentTurn,
            partialText: `${currentTurn.partialText}${delta}`,
          },
        },
        nextOrder,
      };
    }

    const transcript =
      readString(event, "transcript") ?? readString(event, "text") ?? currentTurn.partialText;

    return {
      ...state,
      turnsById: {
        ...state.turnsById,
        [itemId]: {
          ...currentTurn,
          partialText: transcript,
          finalText: transcript,
          confidence: estimateConfidenceFromEvent(event),
        },
      },
      nextOrder,
    };
  }

  return state;
}

export function selectOrderedSourceTurns(state: SourceTranscriptState) {
  const turns = Object.values(state.turnsById).filter((turn) => turn.partialText || turn.finalText);
  const turnsById = new Map(turns.map((turn) => [turn.itemId, turn]));
  const childrenByPrevious = new Map<string | null, SourceTranscriptTurn[]>();

  for (const turn of turns) {
    const parentKey =
      turn.previousItemId && turnsById.has(turn.previousItemId) ? turn.previousItemId : null;
    const siblings = childrenByPrevious.get(parentKey) ?? [];
    siblings.push(turn);
    siblings.sort((left, right) => {
      if (left.committedOrder !== right.committedOrder) {
        return left.committedOrder - right.committedOrder;
      }

      return left.seenOrder - right.seenOrder;
    });
    childrenByPrevious.set(parentKey, siblings);
  }

  const ordered: SourceTranscriptTurn[] = [];
  const visited = new Set<string>();

  const visit = (turn: SourceTranscriptTurn) => {
    if (visited.has(turn.itemId)) {
      return;
    }

    visited.add(turn.itemId);
    ordered.push(turn);

    for (const child of childrenByPrevious.get(turn.itemId) ?? []) {
      visit(child);
    }
  };

  for (const root of childrenByPrevious.get(null) ?? []) {
    visit(root);
  }

  for (const itemId of state.committedIds) {
    const turn = state.turnsById[itemId];
    if (turn) {
      visit(turn);
    }
  }

  for (const turn of turns.sort((left, right) => left.seenOrder - right.seenOrder)) {
    visit(turn);
  }

  return ordered
    .map((turn) => ({
      itemId: turn.itemId,
      text: turn.finalText ?? turn.partialText,
      isFinal: turn.finalText !== null,
      confidence: turn.confidence,
    }))
    .filter((turn) => turn.text.trim().length > 0);
}

function buildTranslationKey(event: RealtimeClientEvent, fallbackKind: TranslationSegmentKind) {
  const responseId = readString(event, "response_id") ?? "response";
  const itemId = readString(event, "item_id") ?? `output-${readNumber(event, "output_index") ?? 0}`;
  const contentIndex = readNumber(event, "content_index") ?? 0;
  return `${fallbackKind}:${responseId}:${itemId}:${contentIndex}`;
}

function updateTranslationSegment(
  state: TranslationState,
  event: RealtimeClientEvent,
  kind: TranslationSegmentKind,
  doneField: "text" | "transcript",
) {
  const key = buildTranslationKey(event, kind);
  const existing = state.activeByKey[key];

  if (event.type.endsWith(".delta")) {
    const delta = readString(event, "delta") ?? "";

    return {
      ...state,
      activeByKey: {
        ...state.activeByKey,
        [key]: {
          key,
          kind,
          text: `${existing?.text ?? ""}${delta}`,
          startedOrder: existing?.startedOrder ?? state.nextOrder,
        },
      },
      activeOrder: existing ? state.activeOrder : [...state.activeOrder, key],
      nextOrder: existing ? state.nextOrder : state.nextOrder + 1,
    };
  }

  const finalText = readString(event, doneField) ?? existing?.text ?? "";

  return {
    ...state,
    activeByKey: Object.fromEntries(
      Object.entries(state.activeByKey).filter(([activeKey]) => activeKey !== key),
    ),
    activeOrder: state.activeOrder.filter((activeKey) => activeKey !== key),
    finalized:
      finalText.trim().length > 0
        ? [
            ...state.finalized,
            {
              id: key,
              kind,
              text: finalText,
              isFinal: true,
              order: existing?.startedOrder ?? state.nextOrder,
            },
          ]
        : state.finalized,
    nextOrder: existing ? state.nextOrder : state.nextOrder + 1,
  };
}

export function reduceTranslationState(
  state: TranslationState,
  event: RealtimeClientEvent | { type: "__reset" },
): TranslationState {
  if (event.type === "__reset") {
    return createTranslationState();
  }

  if (
    event.type === "response.output_text.delta" ||
    event.type === "response.output_text.done" ||
    event.type === "response.text.delta" ||
    event.type === "response.text.done"
  ) {
    return updateTranslationSegment(state, event, "text", "text");
  }

  if (
    event.type === "response.output_audio_transcript.delta" ||
    event.type === "response.output_audio_transcript.done"
  ) {
    return updateTranslationSegment(state, event, "audio", "transcript");
  }

  return state;
}

export function selectTranslationTurns(
  state: TranslationState,
  kind: TranslationSegmentKind,
): TranslationTurn[] {
  const activeTurns = state.activeOrder
    .map((key) => state.activeByKey[key])
    .filter((segment): segment is TranslationSegment => Boolean(segment) && segment.kind === kind)
    .map((segment) => ({
      id: segment.key,
      kind: segment.kind,
      text: segment.text,
      isFinal: false,
      order: segment.startedOrder,
    }));

  return [...state.finalized.filter((turn) => turn.kind === kind), ...activeTurns]
    .filter((turn) => turn.text.trim().length > 0)
    .sort((left, right) => left.order - right.order);
}

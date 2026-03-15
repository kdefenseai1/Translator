"use client";

import { useEffect, useRef, useState } from "react";

import { getLanguageLabel, LANGUAGE_OPTIONS, SOURCE_AUTO } from "@/lib/realtime/languages";
import {
  describeSpeechProvider,
  type RealtimeMode,
  type RealtimeVoice,
  REALTIME_MODEL,
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICES,
  supportsGroqSpeech,
} from "@/lib/realtime/session-config";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

type SessionInfo = {
  sessionId: string | null;
  expiresAt: number | null;
};

type SourceTurn = {
  id: string;
  text: string;
  confidence: number | null;
};

type OutputTurn = {
  id: string;
  text: string;
};

type TurnResponse = {
  transcript: string;
  translation: string;
  confidence: number | null;
  audioChunks: string[];
  audioMimeType: string | null;
  speechProvider: "groq" | "browser" | "none";
  note: string | null;
};

type RecorderRefs = {
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  animationFrame: number | null;
  recorder: MediaRecorder | null;
  recorderStopResolver: (() => void) | null;
  chunks: Blob[];
  isSpeaking: boolean;
  speechStartedAt: number;
  lastSpeechAt: number;
  currentTurnStartedAt: number;
  isSubmitting: boolean;
};

const FFT_SIZE = 2048;
const SPEECH_THRESHOLD = 0.018;
const MIN_SPEECH_MS = 320;
const SILENCE_MS = 800;

function buildTurnUrl(params: Record<string, string>) {
  const searchParams = new URLSearchParams(params);
  return `/api/realtime/turn?${searchParams.toString()}`;
}

function statusLabel(status: ConnectionStatus) {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Live";
    case "error":
      return "Issue";
    default:
      return "Ready to start";
  }
}

function formatConfidence(confidence: number | null | undefined) {
  if (confidence === null || confidence === undefined) {
    return null;
  }

  return `${Math.round(confidence * 100)}% confidence`;
}

function formatSessionExpiry(expiresAt: number | null) {
  if (!expiresAt) {
    return "Active while connected";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(expiresAt * 1000));
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function calculateRms(samples: Float32Array) {
  let total = 0;

  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }

  return Math.sqrt(total / Math.max(1, samples.length));
}

function readErrorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const objectBody = body as Record<string, unknown>;

    if (typeof objectBody.error === "string") {
      return objectBody.error;
    }

    if (objectBody.error && typeof objectBody.error === "object" && !Array.isArray(objectBody.error)) {
      const nested = objectBody.error as Record<string, unknown>;
      if (typeof nested.message === "string") {
        return nested.message;
      }
    }

    if (typeof objectBody.message === "string") {
      return objectBody.message;
    }
  }

  return fallback;
}

function createSessionId() {
  return `groq-${crypto.randomUUID()}`;
}

export function InterpreterApp() {
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRefs = useRef<RecorderRefs>({
    audioContext: null,
    analyser: null,
    sourceNode: null,
    animationFrame: null,
    recorder: null,
    recorderStopResolver: null,
    chunks: [],
    isSpeaking: false,
    speechStartedAt: 0,
    lastSpeechAt: 0,
    currentTurnStartedAt: 0,
    isSubmitting: false,
  });
  const isMutedRef = useRef(false);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  const [mode, setMode] = useState<RealtimeMode>("translate");
  const [sourceLanguage, setSourceLanguage] = useState(SOURCE_AUTO);
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [voice, setVoice] = useState<RealtimeVoice>(REALTIME_VOICES[0]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "The browser captures microphone turns locally, then sends each completed turn to Groq for transcription and translation.",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceTranscriptError, setSourceTranscriptError] = useState<string | null>(null);
  const [translatedOutputError, setTranslatedOutputError] = useState<string | null>(null);
  const [sessionNotes, setSessionNotes] = useState<string[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [hasMicPermission, setHasMicPermission] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>({
    sessionId: null,
    expiresAt: null,
  });
  const [sourceTurns, setSourceTurns] = useState<SourceTurn[]>([]);
  const [outputTurns, setOutputTurns] = useState<OutputTurn[]>([]);
  const [isCapturingTurn, setIsCapturingTurn] = useState(false);
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);

  const controlsLocked = status === "connecting" || status === "connected";
  const audioControlsDisabled = mode !== "interpret" || status !== "connected";
  const targetLabel = getLanguageLabel(targetLanguage);
  const targetSpeechLabel = describeSpeechProvider(targetLanguage);

  useEffect(() => {
    isMutedRef.current = isMuted;

    if (activeAudioRef.current) {
      activeAudioRef.current.muted = isMuted;
    }

    if (isMuted) {
      window.speechSynthesis.cancel();
    }
  }, [isMuted]);

  useEffect(() => {
    return () => {
      stopSession({ keepStatus: true });
    };
  }, []);

  function appendSessionNote(note: string) {
    setSessionNotes((current) => [note, ...current.filter((entry) => entry !== note)].slice(0, 4));
  }

  async function playGroqAudioChunks(chunks: string[], mimeType: string) {
    for (const chunk of chunks) {
      const byteCharacters = atob(chunk);
      const bytes = new Uint8Array(byteCharacters.length);

      for (let index = 0; index < byteCharacters.length; index += 1) {
        bytes[index] = byteCharacters.charCodeAt(index);
      }

      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.muted = isMutedRef.current;
      activeAudioRef.current = audio;

      try {
        await audio.play();
        await new Promise<void>((resolve) => {
          audio.addEventListener("ended", () => resolve(), { once: true });
          audio.addEventListener("error", () => resolve(), { once: true });
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    activeAudioRef.current = null;
  }

  function speakWithBrowser(text: string, target: string) {
    if (!text.trim() || isMutedRef.current) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = target === "ar" ? "ar-SA" : `${target}-${target.toUpperCase()}`;

    const voices = window.speechSynthesis.getVoices();
    const preferredVoice =
      voices.find((voiceOption) => voiceOption.lang.toLowerCase().startsWith(utterance.lang.toLowerCase().slice(0, 2))) ??
      voices.find((voiceOption) => voiceOption.lang.toLowerCase().startsWith(target.toLowerCase()));

    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  function cleanupRecorderGraph() {
    const refs = recorderRefs.current;

    if (refs.animationFrame !== null) {
      cancelAnimationFrame(refs.animationFrame);
      refs.animationFrame = null;
    }

    if (refs.recorder && refs.recorder.state !== "inactive") {
      refs.recorder.stop();
    }

    refs.recorder = null;
    refs.recorderStopResolver = null;
    refs.chunks = [];
    refs.isSpeaking = false;
    refs.speechStartedAt = 0;
    refs.lastSpeechAt = 0;
    refs.currentTurnStartedAt = 0;
    refs.isSubmitting = false;

    refs.sourceNode?.disconnect();
    refs.sourceNode = null;
    refs.analyser?.disconnect();
    refs.analyser = null;

    if (refs.audioContext) {
      void refs.audioContext.close();
      refs.audioContext = null;
    }
  }

  function stopSession({ keepStatus = false }: { keepStatus?: boolean } = {}) {
    cleanupRecorderGraph();

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    activeAudioRef.current?.pause();
    activeAudioRef.current = null;
    window.speechSynthesis.cancel();

    setIsCapturingTurn(false);
    setIsProcessingTurn(false);
    setSessionInfo({ sessionId: null, expiresAt: null });

    if (!keepStatus) {
      setStatus("idle");
      setStatusMessage("Change the target language or mode to reconnect cleanly.");
      setErrorMessage(null);
      setSourceTranscriptError(null);
      setTranslatedOutputError(null);
      setSessionNotes([]);
      setSourceTurns([]);
      setOutputTurns([]);
    }
  }

  function failSession(message: string) {
    stopSession({ keepStatus: true });
    setStatus("error");
    setErrorMessage(message);
    setStatusMessage(
      "The live session could not continue. Retry after adjusting the target language or reconnecting.",
    );
  }

  async function submitTurn(blob: Blob) {
    const refs = recorderRefs.current;

    if (refs.isSubmitting || !blob.size) {
      return;
    }

    refs.isSubmitting = true;
    setIsProcessingTurn(true);
    setSourceTranscriptError(null);
    setTranslatedOutputError(null);

    try {
      const formData = new FormData();
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      formData.append("audio", new File([blob], `turn.${extension}`, { type: blob.type || "audio/webm" }));

      const response = await fetch(
        buildTurnUrl({
          source: sourceLanguage,
          target: targetLanguage,
          mode,
          voice,
        }),
        {
          method: "POST",
          body: formData,
        },
      );

      const body = (await response.json()) as TurnResponse | Record<string, unknown>;

      if (!response.ok) {
        throw new Error(readErrorMessage(body, "Groq could not process the captured speech turn."));
      }

      const turn = body as TurnResponse;
      if (!turn.transcript.trim()) {
        appendSessionNote("Captured a turn, but Groq returned no transcript text.");
        return;
      }

      const turnId = crypto.randomUUID();
      setSourceTurns((current) => [
        ...current,
        {
          id: turnId,
          text: turn.transcript,
          confidence: turn.confidence,
        },
      ]);

      if (turn.translation.trim()) {
        setOutputTurns((current) => [
          ...current,
          {
            id: turnId,
            text: turn.translation,
          },
        ]);
      }

      if (turn.note) {
        appendSessionNote(turn.note);
      }

      if (mode === "interpret" && turn.translation.trim()) {
        if (turn.speechProvider === "groq" && turn.audioChunks.length > 0 && turn.audioMimeType) {
          await playGroqAudioChunks(turn.audioChunks, turn.audioMimeType);
        } else if (turn.speechProvider === "browser") {
          speakWithBrowser(turn.translation, targetLanguage);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Groq could not process the captured speech turn.";
      setTranslatedOutputError(message);
      setSourceTranscriptError(message);
      appendSessionNote(`Turn failed: ${message}`);
    } finally {
      refs.isSubmitting = false;
      setIsProcessingTurn(false);
    }
  }

  function beginRecorder(stream: MediaStream) {
    const refs = recorderRefs.current;

    if (refs.recorder && refs.recorder.state !== "inactive") {
      return;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    refs.chunks = [];
    refs.currentTurnStartedAt = performance.now();

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        refs.chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(refs.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      refs.recorder = null;
      refs.chunks = [];
      setIsCapturingTurn(false);
      void submitTurn(blob);
      refs.recorderStopResolver?.();
      refs.recorderStopResolver = null;
    });

    recorder.start();
    refs.recorder = recorder;
    setIsCapturingTurn(true);
  }

  function stopRecorder() {
    const refs = recorderRefs.current;

    if (!refs.recorder || refs.recorder.state === "inactive") {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      refs.recorderStopResolver = resolve;
      refs.recorder?.stop();
    });
  }

  function startVoiceActivityLoop(stream: MediaStream) {
    const refs = recorderRefs.current;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    const sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyser);

    refs.audioContext = audioContext;
    refs.analyser = analyser;
    refs.sourceNode = sourceNode;

    const buffer = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (!refs.analyser) {
        return;
      }

      refs.analyser.getFloatTimeDomainData(buffer);
      const rms = calculateRms(buffer);
      const now = performance.now();

      if (rms >= SPEECH_THRESHOLD && !refs.isSubmitting) {
        refs.lastSpeechAt = now;

        if (!refs.isSpeaking) {
          refs.isSpeaking = true;
          refs.speechStartedAt = now;
          beginRecorder(stream);
        }
      }

      if (refs.isSpeaking && now - refs.lastSpeechAt >= SILENCE_MS) {
        refs.isSpeaking = false;

        if (refs.currentTurnStartedAt && now - refs.speechStartedAt >= MIN_SPEECH_MS) {
          void stopRecorder();
        }
      }

      refs.animationFrame = requestAnimationFrame(tick);
    };

    refs.animationFrame = requestAnimationFrame(tick);
  }

  async function startSession() {
    if (status === "connecting" || status === "connected") {
      return;
    }

    setStatus("connecting");
    setStatusMessage("Requesting microphone access and arming the local turn detector.");
    setErrorMessage(null);
    setSourceTranscriptError(null);
    setTranslatedOutputError(null);
    setSessionNotes([]);
    setSourceTurns([]);
    setOutputTurns([]);
    setIsCapturingTurn(false);
    setIsProcessingTurn(false);

    try {
      if (typeof MediaRecorder === "undefined") {
        throw new Error("This browser does not support MediaRecorder audio capture.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      micStreamRef.current = stream;
      setHasMicPermission(true);
      setSessionInfo({
        sessionId: createSessionId(),
        expiresAt: null,
      });

      startVoiceActivityLoop(stream);

      appendSessionNote(`Microphone granted. Listening for turns headed toward ${targetLabel}.`);
      if (mode === "interpret" && !supportsGroqSpeech(targetLanguage)) {
        appendSessionNote("Groq TTS is unavailable for this target language, so spoken output will use the browser voice.");
      }

      setStatus("connected");
      setStatusMessage(
        mode === "interpret"
          ? `Turn-based translation will stream in ${targetLabel}. Spoken output uses ${targetSpeechLabel}.`
          : `Turn-based transcript and translated text will stream in ${targetLabel}.`,
      );
    } catch (error) {
      stopSession({ keepStatus: true });
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "The session could not start.");
      setStatusMessage("The session could not start. Fix the issue and try again.");
    }
  }

  return (
    <main className="rt-shell">
      <div className="rt-noise rt-noise-a" />
      <div className="rt-noise rt-noise-b" />

      <section className="rt-hero">
        <h1>Live Realtime Translator</h1>
        <p>
          Speak in any language, let the browser capture each microphone turn locally, then send it
          to Groq for speech transcription, translation, and spoken delivery.
        </p>
      </section>

      <section className="rt-workspace">
        <aside className="rt-card rt-control-card">
          <div className="rt-card-heading">
            <h2>Connection Control</h2>
            <p>
              The browser arms the microphone, detects completed speaker turns locally, then sends
              each turn to Groq. Changing the target language reconnects the session cleanly.
            </p>
          </div>

          <div className="rt-mode-toggle" role="tablist" aria-label="Mode">
            <button
              type="button"
              className={mode === "translate" ? "rt-mode-button rt-mode-button-active" : "rt-mode-button"}
              onClick={() => setMode("translate")}
              disabled={controlsLocked}
            >
              Translate
            </button>
            <button
              type="button"
              className={mode === "interpret" ? "rt-mode-button rt-mode-button-active" : "rt-mode-button"}
              onClick={() => setMode("interpret")}
              disabled={controlsLocked}
            >
              Interpret
            </button>
          </div>

          <div className="rt-pill-group">
            <span className={`rt-pill rt-pill-status rt-pill-${status}`}>Status {statusLabel(status)}</span>
            <span className="rt-pill">
              Mic {hasMicPermission ? "Microphone granted" : "Waiting for microphone"}
            </span>
            <span className="rt-pill">Translate {REALTIME_MODEL}</span>
            <span className="rt-pill">Transcript {REALTIME_TRANSCRIBE_MODEL}</span>
          </div>

          <div className="rt-control-stack">
            <label className="rt-field">
              <span>Target language</span>
              <select
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.target.value)}
                disabled={controlsLocked}
              >
                {LANGUAGE_OPTIONS.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label} - {language.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="rt-inline-fields">
              <label className="rt-field">
                <span>Source</span>
                <select
                  value={sourceLanguage}
                  onChange={(event) => setSourceLanguage(event.target.value)}
                  disabled={controlsLocked}
                >
                  <option value={SOURCE_AUTO}>Auto-detect</option>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="rt-field">
                <span>Voice</span>
                <select
                  value={voice}
                  onChange={(event) => setVoice(event.target.value as RealtimeVoice)}
                  disabled={controlsLocked || mode !== "interpret"}
                >
                  {REALTIME_VOICES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="rt-actions">
            <button
              type="button"
              className="rt-button rt-button-primary"
              onClick={startSession}
              disabled={controlsLocked}
            >
              {status === "connecting" ? "Connecting..." : "Connect session"}
            </button>
            <button
              type="button"
              className="rt-button rt-button-secondary"
              onClick={() => stopSession()}
              disabled={!controlsLocked}
            >
              Disconnect
            </button>
          </div>

          <div className="rt-actions rt-actions-compact">
            <button
              type="button"
              className="rt-button rt-button-tertiary"
              onClick={() => setIsMuted((current) => !current)}
              disabled={audioControlsDisabled}
            >
              {isMuted ? "Unmute interpreter" : "Mute interpreter"}
            </button>
          </div>

          <dl className="rt-meta-list">
            <div>
              <dt>Current target</dt>
              <dd>{targetLabel}</dd>
            </div>
            <div>
              <dt>Speech output</dt>
              <dd>{mode === "interpret" ? targetSpeechLabel : "Text only"}</dd>
            </div>
            <div>
              <dt>Session id</dt>
              <dd>{sessionInfo.sessionId ?? "Pending"}</dd>
            </div>
            <div>
              <dt>Session expires</dt>
              <dd>{formatSessionExpiry(sessionInfo.expiresAt)}</dd>
            </div>
          </dl>

          <div className="rt-status-copy">
            <p>{statusMessage}</p>
            {errorMessage ? <p className="rt-error-copy">{errorMessage}</p> : null}
            {sessionNotes.length > 0 ? (
              <ul className="rt-notes">
                {sessionNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </aside>

        <section className="rt-card rt-surface-card">
          <div className="rt-card-heading">
            <h2>Live Transcript Surface</h2>
            <p>
              Source turns are captured locally and sent to Groq once the speaker pauses. Groq returns
              a full transcript and translated response for each completed turn.
            </p>
          </div>

          <div className="rt-surface-grid">
            <article className="rt-surface-pane">
              <header>
                <h3>Speaker transcript</h3>
                <p>Turn-based transcription with Groq Whisper after each detected speaker pause.</p>
              </header>
              <div className="rt-scrollbox">
                {sourceTurns.length > 0 ? (
                  sourceTurns.map((turn) => (
                    <div key={turn.id} className="rt-turn rt-turn-final">
                      <p>{turn.text}</p>
                      {turn.confidence !== null ? (
                        <span className="rt-confidence">{formatConfidence(turn.confidence)}</span>
                      ) : null}
                    </div>
                  ))
                ) : sourceTranscriptError ? (
                  <p className="rt-empty-copy rt-empty-copy-error">{sourceTranscriptError}</p>
                ) : isCapturingTurn ? (
                  <div className="rt-turn rt-turn-live">
                    <p>Listening to the current speaker turn…</p>
                  </div>
                ) : isProcessingTurn ? (
                  <div className="rt-turn rt-turn-live">
                    <p>Sending the captured turn to Groq for transcription…</p>
                  </div>
                ) : (
                  <p className="rt-empty-copy">
                    Speak after connecting to capture one full speaker turn at a time.
                  </p>
                )}
              </div>
            </article>

            <article className="rt-surface-pane">
              <header>
                <h3>Translated output</h3>
                <p>
                  {mode === "interpret"
                    ? `Turn translations stream in ${targetLabel}. Spoken output uses ${targetSpeechLabel}.`
                    : `Translated text lands in ${targetLabel} after each completed speaker turn.`}
                </p>
              </header>
              <div className="rt-scrollbox">
                {outputTurns.length > 0 ? (
                  outputTurns.map((turn) => (
                    <div
                      key={turn.id}
                      className={mode === "interpret" ? "rt-turn rt-turn-audio-final" : "rt-turn rt-turn-final"}
                    >
                      <p>{turn.text}</p>
                    </div>
                  ))
                ) : translatedOutputError ? (
                  <p className="rt-empty-copy rt-empty-copy-error">{translatedOutputError}</p>
                ) : isProcessingTurn ? (
                  <div className={mode === "interpret" ? "rt-turn rt-turn-audio-live" : "rt-turn rt-turn-live"}>
                    <p>Groq is translating the current speaker turn…</p>
                  </div>
                ) : (
                  <p className="rt-empty-copy">
                    {mode === "interpret"
                      ? "The translated voice and transcript will appear here after each completed speaker turn."
                      : "The translated text will appear here after each completed speaker turn."}
                  </p>
                )}
              </div>
            </article>
          </div>

          <footer className="rt-surface-footer">
            <p>The microphone stays armed while the session is connected, but Groq is called only after a pause in speech.</p>
            <p>
              Groq TTS currently supports English and Arabic directly. Other spoken targets use the browser voice fallback.
            </p>
          </footer>
        </section>
      </section>
    </main>
  );
}

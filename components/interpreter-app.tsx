"use client";

import { useEffect, useRef, useState } from "react";

import { getLanguageLabel, LANGUAGE_OPTIONS, SOURCE_AUTO } from "@/lib/realtime/languages";
import {
  describeSpeechProvider,
  type RealtimeMode,
  type RealtimeVoice,
  REALTIME_MODEL,
  REALTIME_VOICES,
  buildTranslationInstructions,
} from "@/lib/realtime/session-config";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

type SourceTurn = {
  id: string;
  text: string;
};

type OutputTurn = {
  id: string;
  text: string;
};

export function InterpreterApp() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioBufferRef = useRef<Int16Array[]>([]);

  const [mode, setMode] = useState<RealtimeMode>("translate");
  const [sourceLanguage, setSourceLanguage] = useState(SOURCE_AUTO);
  const [targetLanguage, setTargetLanguage] = useState("ko");
  const [voice, setVoice] = useState<RealtimeVoice>(REALTIME_VOICES[0]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "xAI Voice Agent를 통해 실시간 동시 통역을 제공합니다.",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceTurns, setSourceTurns] = useState<SourceTurn[]>([]);
  const [outputTurns, setOutputTurns] = useState<OutputTurn[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);

  const controlsLocked = status === "connecting" || status === "connected";

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  function stopSession() {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (inputSourceRef.current) {
      inputSourceRef.current.disconnect();
      inputSourceRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    setStatus("idle");
    setIsCapturing(false);
  }

  async function startSession() {
    if (status !== "idle") return;

    setStatus("connecting");
    setStatusMessage("세션 토큰을 생성하고 서버에 연결 중입니다...");

    try {
      const sessionRes = await fetch("/api/realtime/session", { method: "POST" });
      if (!sessionRes.ok) {
        const errJson = await sessionRes.json().catch(() => ({}));
        console.error("Session fetch failed:", errJson);
        throw new Error(`세션 생성에 실패했습니다: ${errJson.error || sessionRes.statusText}`);
      }
      const sessionData = await sessionRes.json();
      console.log("Frontend received sessionData:", sessionData);
      
      // xAI may return { client_secret: { value: "..." } } (OpenAI style) 
      // or directly { value: "..." } based on documentation
      const clientSecret = sessionData.client_secret?.value || sessionData.value;

      if (!clientSecret) throw new Error("유효한 세션 토큰을 받지 못했습니다.");

      // For browsers, we pass the token in Sec-WebSocket-Protocol
      const ws = new WebSocket(
        `wss://api.x.ai/v1/realtime?model=${REALTIME_MODEL}`,
        [`xai-client-secret.${clientSecret}`]
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        setStatusMessage("연결되었습니다. 말씀을 시작하세요.");

        // Initial configuration
        const sessionUpdate = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: buildTranslationInstructions(sourceLanguage, targetLanguage),
            voice: voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad" },
          },
        };
        ws.send(JSON.stringify(sessionUpdate));

        startAudioCapture();
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "conversation.item.input_audio_transcription.completed":
            setSourceTurns((prev) => [
              ...prev,
              { id: data.item_id, text: data.transcript },
            ]);
            break;
          case "response.audio_transcript.delta":
            // Live translation text delta
            setOutputTurns((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.id === data.item_id) {
                return [...prev.slice(0, -1), { ...last, text: last.text + data.delta }];
              }
              return [...prev, { id: data.item_id, text: data.delta }];
            });
            break;
          case "response.audio_transcript.done":
            // Finalized translation text
            break;
          case "response.audio.delta":
            playOutputAudioChunk(data.delta);
            break;
          case "error":
            console.error("WS Error:", data.error);
            setErrorMessage(data.error.message || "서버 오류가 발생했습니다.");
            break;
        }
      };

      ws.onclose = () => stopSession();
      ws.onerror = () => {
        setStatus("error");
        setErrorMessage("연결 오류가 발생했습니다.");
      };

    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "알 수 없는 오류");
    }
  }

  async function startAudioCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      inputSourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
        }

        const base64Audio = btoa(
          String.fromCharCode(...new Uint8Array(pcm16.buffer))
        );

        wsRef.current.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio
        }));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsCapturing(true);

    } catch (err) {
      console.error("Mic error:", err);
      setErrorMessage("마이크 접근에 실패했습니다.");
    }
  }

  // Very basic audio player for PCM chunks
  const audioStack: AudioBuffer[] = [];
  let isPlaying = false;

  async function playOutputAudioChunk(base64: string) {
    if (!audioContextRef.current) return;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x7fff;

    const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.start();
  }

  return (
    <main className="rt-shell wv-style">
      <div className="rt-noise rt-noise-a" />
      <div className="rt-noise rt-noise-b" />

      <section className="rt-hero wv-hero">
        <h1>동통사</h1>
        <p>실시간 인공지능 동시 통역사 (xAI Powered)</p>
      </section>

      <section className="rt-workspace wv-workspace">
        <aside className="rt-card rt-control-card wv-card">
          <div className="rt-card-heading">
            <h2>설정 제어</h2>
            <p>언어 및 동작 모드를 선택하고 연결을 시작하세요.</p>
          </div>

          <div className="rt-mode-toggle">
            <button
              type="button"
              className={mode === "translate" ? "rt-mode-button rt-mode-button-active" : "rt-mode-button"}
              onClick={() => setMode("translate")}
              disabled={controlsLocked}
            >
              번역 모드
            </button>
            <button
              type="button"
              className={mode === "interpret" ? "rt-mode-button rt-mode-button-active" : "rt-mode-button"}
              onClick={() => setMode("interpret")}
              disabled={controlsLocked}
            >
              통역 모드
            </button>
          </div>

          <div className="rt-control-stack">
            <label className="rt-field">
              <span>목표 언어</span>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                disabled={controlsLocked}
              >
                {LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label className="rt-field">
              <span>음성</span>
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value as RealtimeVoice)}
                disabled={controlsLocked}
              >
                {REALTIME_VOICES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="rt-actions">
            <button
              type="button"
              className="rt-button rt-button-primary"
              onClick={startSession}
              disabled={controlsLocked}
            >
              {status === "connecting" ? "연결 중..." : "서비스 시작하기"}
            </button>
            <button
              type="button"
              className="rt-button rt-button-secondary"
              onClick={stopSession}
              disabled={!controlsLocked}
            >
              종료
            </button>
          </div>

          <div className="rt-status-copy">
            <p>{statusMessage}</p>
            {errorMessage && <p className="rt-error-copy">{errorMessage}</p>}
          </div>
        </aside>

        <section className="rt-card rt-surface-card wv-card">
          <div className="rt-card-heading">
            <h2>실시간 대화 내역</h2>
          </div>

          <div className="rt-surface-grid wv-surface-grid">
            <article className="rt-surface-pane">
              <header><h3>인식된 음성</h3></header>
              <div className="rt-scrollbox">
                {sourceTurns.map((turn) => (
                  <div key={turn.id} className="rt-turn rt-turn-final"><p>{turn.text}</p></div>
                ))}
                {isCapturing && (
                  <div className="rt-turn rt-turn-live"><p>말씀하시는 중...</p></div>
                )}
              </div>
            </article>

            <article className="rt-surface-pane">
              <header><h3>번역 결과</h3></header>
              <div className="rt-scrollbox">
                {outputTurns.map((turn) => (
                  <div key={turn.id} className="rt-turn rt-turn-audio-final"><p>{turn.text}</p></div>
                ))}
              </div>
            </article>
          </div>
        </section>
      </section>
    </main>
  );
}

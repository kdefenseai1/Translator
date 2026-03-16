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
  buildBidirectionalInstructions,
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

  const [mode, setMode] = useState<RealtimeMode>("interpret"); // Default to interpret for bidirectional
  const [sourceLanguage, setSourceLanguage] = useState(SOURCE_AUTO);
  const [primaryLanguage, setPrimaryLanguage] = useState("ko");
  const [secondaryLanguage, setSecondaryLanguage] = useState("en");
  const [voice, setVoice] = useState<RealtimeVoice>(REALTIME_VOICES[0]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "AI Voice Agent를 통한 전문 통역 서비스를 제공합니다.",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceTurns, setSourceTurns] = useState<SourceTurn[]>([]);
  const [outputTurns, setOutputTurns] = useState<OutputTurn[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [interpretationMode, setInterpretationMode] = useState<"realtime" | "sequential">("realtime");
  const [isSpeaking, setIsSpeaking] = useState(false);

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
    setStatusMessage("AI 통역 엔진을 연결하고 있습니다...");

    try {
      const sessionRes = await fetch("/api/realtime/session", { method: "POST" });
      if (!sessionRes.ok) {
        const errJson = await sessionRes.json().catch(() => ({}));
        throw new Error(`세션 생성에 실패했습니다: ${errJson.error || sessionRes.statusText}`);
      }
      const sessionData = await sessionRes.json();
      const clientSecret = sessionData.client_secret?.value || sessionData.value;

      if (!clientSecret) throw new Error("유효한 세션 토큰을 받지 못했습니다.");

      const ws = new WebSocket(
        `wss://api.x.ai/v1/realtime?model=${REALTIME_MODEL}`,
        [`xai-client-secret.${clientSecret}`]
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        setStatusMessage("전문 통역이 시작되었습니다.");

        const instructions = mode === "interpret" 
          ? buildBidirectionalInstructions(primaryLanguage, secondaryLanguage)
          : buildTranslationInstructions(sourceLanguage, primaryLanguage);

        const sessionUpdate = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: instructions,
            voice: voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: interpretationMode === "realtime" ? { type: "server_vad" } : null,
          },
        };
        ws.send(JSON.stringify(sessionUpdate));

        startAudioCapture();
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case "conversation.item.input_audio_transcription.completed":
              setSourceTurns((prev) => [
                ...prev,
                { id: data.item_id, text: data.transcript },
              ]);
              break;
            case "response.output_audio_transcript.delta":
              setOutputTurns((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === data.item_id) {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...last, text: last.text + data.delta };
                  return updated;
                }
                return [...prev, { id: data.item_id, text: data.delta }];
              });
              break;
            case "response.output_audio.delta":
              playOutputAudioChunk(data.delta);
              break;
            case "error":
              setErrorMessage(data.error.message || "서버 오류가 발생했습니다.");
              break;
          }
        } catch (e) {
          console.error("Error parsing WS message:", e);
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
        if (interpretationMode === "sequential" && !isSpeaking) return;

        const inputData = e.inputBuffer.getChannelData(0);
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

  function startSpeaking() {
    setIsSpeaking(true);
    setStatusMessage("말씀하세요...");
  }

  function commitAudio() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setIsSpeaking(false);
    wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    wsRef.current.send(JSON.stringify({ type: "response.create" }));
    setStatusMessage("AI 가 통역 중입니다...");
  }

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
    <main className="rt-shell">
      {/* Header */}
      <header className="rt-header">
        <h1>동통사</h1>
        <p>Professional AI Interpretation & Translation</p>
      </header>

      {/* Connection Status & Mode Info */}
      <div className="rt-status-bar">
        <span className={`rt-status-pill ${mode === "interpret" ? "active" : ""}`}>
          {mode === "interpret" ? "통역 모드" : "번역 모드"}
        </span>
        <span className={`rt-status-pill ${interpretationMode === "realtime" ? "active" : ""}`}>
          {interpretationMode === "realtime" ? "실시간" : "순차"}
        </span>
        <span className="rt-status-pill">
          {status === "connected" ? "연결됨" : status === "connecting" ? "연결 중" : "대기 중"}
        </span>
      </div>

      {/* Main Conversation Flow */}
      <section className="rt-conversation">
        {sourceTurns.length === 0 && outputTurns.length === 0 && (
          <div className="glass-card" style={{ padding: '48px 24px', textAlign: 'center', marginTop: '20px' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem', margin: 0 }}>
              {status === "connected" 
                ? "상단의 언어 설정을 확인하고 말씀을 시작해 주세요." 
                : "서비스 시작하기 버튼을 눌러 AI 통역사를 연결하세요."}
            </p>
          </div>
        )}

        {sourceTurns.map((sTurn, index) => {
          const oTurn = outputTurns.find(ot => ot.id === sTurn.id) || outputTurns[index];
          
          return (
            <div key={sTurn.id} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="rt-turn-wrapper left">
                <span className="rt-turn-label">{getLanguageLabel(mode === "interpret" ? primaryLanguage : sourceLanguage)}</span>
                <div className="rt-bubble glass-card">{sTurn.text}</div>
              </div>
              {oTurn && (
                <div className="rt-turn-wrapper right">
                  <span className="rt-turn-label" style={{ textAlign: 'right' }}>{getLanguageLabel(mode === "interpret" ? secondaryLanguage : primaryLanguage)}</span>
                  <div className="rt-bubble glass-card">{oTurn.text}</div>
                </div>
              )}
            </div>
          );
        })}

        {isSpeaking && (
          <div className="rt-turn-wrapper left">
            <span className="rt-turn-label">듣는 중...</span>
            <div className="rt-bubble rt-bubble-live glass-card" style={{ borderStyle: 'dashed' }}>
              말씀하시는 내용을 분석하고 있습니다...
            </div>
          </div>
        )}
      </section>

      {/* Floating Controls Hub */}
      <div className="rt-controls-hub">
        <div className="glass-card rt-controls-inner">
          <div className="rt-control-row">
            <select
              className="rt-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as RealtimeMode)}
              disabled={controlsLocked}
            >
              <option value="interpret">통역 모드 (양방향)</option>
              <option value="translate">번역 모드 (일방향)</option>
            </select>

            <select
              className="rt-select"
              value={interpretationMode}
              onChange={(e) => setInterpretationMode(e.target.value as any)}
              disabled={controlsLocked}
            >
              <option value="realtime">실시간 (자동 감지)</option>
              <option value="sequential">순차 (수동 제어)</option>
            </select>
          </div>

          <div className="rt-control-row">
            <select
              className="rt-select"
              value={mode === "interpret" ? primaryLanguage : sourceLanguage}
              onChange={(e) => mode === "interpret" ? setPrimaryLanguage(e.target.value) : setSourceLanguage(e.target.value)}
              disabled={controlsLocked}
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
            <div style={{ color: 'var(--text-muted)', fontWeight: 'bold' }}>➝</div>
            <select
              className="rt-select"
              value={mode === "interpret" ? secondaryLanguage : primaryLanguage}
              onChange={(e) => mode === "interpret" ? setSecondaryLanguage(e.target.value) : setPrimaryLanguage(e.target.value)}
              disabled={controlsLocked}
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
          </div>

          <div className="rt-control-row" style={{ marginTop: '4px' }}>
            {status === "idle" || status === "error" ? (
              <button className="rt-btn-main" onClick={startSession}>
                <div className="rt-mic-visualizer" />
                서비스 시작하기
              </button>
            ) : status === "connected" && interpretationMode === "sequential" ? (
              !isSpeaking ? (
                <button className="rt-btn-main" onClick={startSpeaking}>
                  <div className="rt-mic-visualizer" />
                  말씀 시작하기
                </button>
              ) : (
                <button className="rt-btn-main" onClick={commitAudio}>
                  <div className="rt-mic-visualizer active" />
                  말씀 완료 (통역하기)
                </button>
              )
            ) : (
              <button className="rt-btn-main rt-btn-main-stop" onClick={stopSession}>
                {status === "connecting" ? "연결 중..." : "서비스 종료"}
              </button>
            )}
          </div>

          {(errorMessage || statusMessage) && (
            <p style={{ 
              color: errorMessage ? 'var(--danger)' : 'var(--text-secondary)', 
              fontSize: '0.8rem', 
              margin: '0', 
              textAlign: 'center',
              opacity: 0.8 
            }}>
              {errorMessage || statusMessage}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

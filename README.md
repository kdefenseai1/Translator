# Live Translate

Turn-based speech translation and interpretation web app built on Groq.

## Run locally

1. Copy `.env.example` to `.env.local` and set `GROQ_API_KEY`.
2. Install dependencies with `npm install`.
3. Start the app with `npm run dev`.
4. Open `http://localhost:3000`.

## Runtime

- Speech transcription: `whisper-large-v3-turbo`
- Text translation: `openai/gpt-oss-20b`
- Spoken output:
  - English: `playai-tts`
  - Arabic: `playai-tts-arabic`
  - Other targets: browser speech synthesis fallback

## Route

- `POST /api/realtime/turn?source=auto|<iso639-1>&target=<iso639-1>&mode=translate|interpret&voice=<voice>`

Send a multipart form with an `audio` file. The server transcribes the turn with Groq, translates it, and in interpret mode optionally returns base64-encoded audio chunks for supported target languages.

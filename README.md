# PulseGlance G2

Hands-free Telegram AI Digest & Voice Reply HUD for **Even Realities G2** smart glasses (576x288 monochrome green waveguide display).

Built for **Heads Up: Even Realities Hackathon by TVM Ventures & Daos Hub** (Tracks: *Messaging & News* and *AI Assistants & Work*).

## Key Features

- **Live Personal Telegram Sync (MTProto):** Connects directly to a real Telegram account via GramJS (telegram), prioritizing unread personal chats and filtering noise.
- **On-Glass AI Summaries & Smart Replies:** Uses Gemini 2.0 Flash via OpenRouter to condense incoming threads into a 3-line HUD digest and generate 3 context-aware quick replies.
- **Hands-Free Voice Reply (Long Press):** Captures voice input from the Even G2 microphone (AudioInputSource.Glasses PCM -> WAV), transcribes and polishes the message via AI, and queues it for 1-tap sending.
- **Synchronized Companion Dashboard:** Dark-mode browser companion mirroring the HUD state, live voice transcripts, and chat context.

## Even G2 Controls

| Gesture | Feed Mode | Reply Mode | Recording Mode |
| :--- | :--- | :--- | :--- |
| **Scroll Up / Down** | Switch active chat | Cycle AI / voice replies | — |
| **Click** | Open reply drafts | Send selected reply to Telegram | Finish & transcribe voice |
| **Long Press (Hold)** | Start voice reply | Start voice reply | — |
| **Double Click** | Close container | Back to feed | Cancel recording |

## Quick Start

1. Install dependencies:

       npm install

2. Configure `.env`:

       TG_API_ID=your_api_id
       TG_API_HASH=your_api_hash
       OPENROUTER_API_KEY=your_openrouter_key
       PORT=3001

3. Start the Telegram + AI backend:

       npx tsx server/index.ts

4. Start the Even Hub frontend:

       npm run dev

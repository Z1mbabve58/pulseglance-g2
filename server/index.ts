import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import { TelegramClient, sessions } from 'telegram'

dotenv.config()

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH || ''
const openrouterKey = process.env.OPENROUTER_API_KEY || ''
const port = Number(process.env.PORT) || 3001

const SESSION_FILE = '.tg_session'
const savedSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf-8').trim() : ''
const stringSession = new sessions.StringSession(savedSession)

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
})

const dialogEntities = new Map<string, any>()

function parseJsonBlock(raw: string): any {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

async function summarizeAndDraft(chatTitle: string, messagesText: string) {
  const fallback = {
    summary: messagesText.slice(0, 120).replace(/\n+/g, ' '),
    replies: ['Ок, принял!', 'Сейчас посмотрю', 'На связи, скоро отвечу'],
  }

  if (!openrouterKey) return fallback

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [
          {
            role: 'system',
            content:
              'You summarize Telegram messages for Even G2 smart glasses (576x288 HUD). Return ONLY valid JSON: {"summary":"max 115 chars concise summary in the chat language","replies":["reply 1 max 42 chars","reply 2 max 42 chars","reply 3 max 42 chars"]}.',
          },
          {
            role: 'user',
            content: `Chat: ${chatTitle}\nRecent messages:\n${messagesText}`,
          },
        ],
        temperature: 0.3,
      }),
    })

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''
    const parsed = parseJsonBlock(content)
    if (parsed?.summary && Array.isArray(parsed?.replies) && parsed.replies.length > 0) {
      return {
        summary: String(parsed.summary).slice(0, 130),
        replies: parsed.replies.slice(0, 3).map((r: any) => String(r).slice(0, 55)),
      }
    }
  } catch (err) {
    console.error('AI digest error:', err)
  }

  return fallback
}

async function processVoiceReply(
  chatTitle: string,
  summary: string,
  audioBase64?: string,
  transcriptHint?: string
) {
  const hintClean = (transcriptHint || '').trim()

  if (!openrouterKey) {
    const text = hintClean || 'Ок, понял, скоро вернусь с ответом!'
    return { transcript: text, reply: text }
  }

  const languageInstruction = `Detect the language of the chat context ("${summary}"). Transcribe the user's voice input (which may be spoken in Russian or English), clean up filler words, and format a concise, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (automatically translate Russian speech into natural English if the chat context is in English). Return ONLY valid JSON: {"transcript":"original spoken phrase","reply":"final reply in chat language"}.`

  if (audioBase64 && audioBase64.length > 100) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Chat: "${chatTitle}". ${languageInstruction}`,
                },
                {
                  type: 'input_audio',
                  input_audio: {
                    data: audioBase64,
                    format: 'wav',
                  },
                },
              ],
            },
          ],
          temperature: 0.2,
        }),
      })

      const data: any = await res.json()
      const content = data?.choices?.[0]?.message?.content || ''
      const parsed = parseJsonBlock(content)
      if (parsed?.reply) {
        return {
          transcript: String(parsed.transcript || parsed.reply),
          reply: String(parsed.reply).slice(0, 120),
        }
      }
    } catch (err) {
      console.error('AI audio error:', err)
    }
  }

  if (hintClean) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', }, body: JSON.stringify({ model: 'google/gemini-2.0-flash-001', messages: [ { role: 'system', content: 'Detect the language of the chat context. Convert the user voice transcript into a clean, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian to natural English if the chat context is English). Return ONLY the final reply text.', }, { role: 'user', content: `Chat: ${chatTitle}\nChat context: ${summary}\nUser voice transcript:${hintClean}`,
            },
          ],
          temperature: 0.2,
        }),
      })
      const data: any = await res.json()
      const polished = data?.choices?.[0]?.message?.content?.trim()
      if (polished) {
        return { transcript: hintClean, reply: polished.slice(0, 120) }
      }
    } catch (err) {
      console.error('AI text polish error:', err)
    }
    return { transcript: hintClean, reply: hintClean.slice(0, 120) }
  }

  return {
    transcript: 'Голосовое подтверждение',
    reply: 'Got it, will follow up shortly!',
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

app.get('/api/digest', async (_req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 20 })
    const filtered = dialogs
      .filter((d) => d.title && d.message?.message)
      .sort((a, b) => {
        const dmDiff = (b.isUser ? 1 : 0) - (a.isUser ? 1 : 0)
        if (dmDiff !== 0) return dmDiff
        return (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
      })
      .slice(0, 7)

    const cards = []
    for (const d of filtered) {
      const id = String(d.id)
      if (d.entity) dialogEntities.set(id, d.entity)

      const msgs = await client.getMessages(d.entity || d.id, { limit: 4 })
      const textBlock = msgs
        .reverse()
        .map((m) => (m.message || '').trim())
        .filter(Boolean)
        .join('\n')

      if (!textBlock) continue
      const ai = await summarizeAndDraft(d.title || 'Chat', textBlock)
      cards.push({
        id,
        title: d.title || 'Chat',
        isUser: Boolean(d.isUser),
        unreadCount: d.unreadCount || 0,
        summary: ai.summary,
        replies: ai.replies,
      })
    }

    res.json({ ok: true, cards })
  } catch (err: any) {
    console.error('Digest error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice-reply', async (req, res) => {
  try {
    const { chatTitle, summary, audioBase64, transcriptHint } = req.body || {}
    const result = await processVoiceReply(
      chatTitle || 'Chat',
      summary || '',
      audioBase64,
      transcriptHint
    )
    res.json({ ok: true, ...result })
  } catch (err: any) {
    console.error('Voice reply error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body
    if (!chatId || !text) {
      return res.status(400).json({ ok: false, error: 'Missing chatId or text' })
    }
    const target = dialogEntities.get(String(chatId)) || chatId
    await client.sendMessage(target, { message: text })
    res.json({ ok: true })
  } catch (err: any) {
    console.error('Send error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

async function start() {
  await client.connect()
  app.listen(port, () => {
    console.log(`PulseGlance G2 Backend running on http://localhost:${port}`) }) }  start() EOF  cat << 'EOF' > src/main.ts import { waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer, OsEventTypeList, AudioInputSource, } from '@evenrealities/even_hub_sdk' import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'  interface ChatCard { id: string title: string isUser?: boolean unreadCount: number summary: string replies: string[] }  type ScreenMode = 'LOADING' \vert{} 'FEED' \vert{} 'REPLY' \vert{} 'RECORDING' \vert{} 'TRANSCRIBING' \vert{} 'SENDING' \vert{} 'SENT' \vert{} 'ERROR'  const BACKEND_URL = 'http://localhost:3001' const bridge = await waitForEvenAppBridge()  let mode: ScreenMode = 'LOADING' let cards: ChatCard[] = [] let dmOnly = false let chatIdx = 0 let replyIdx = 0 let statusNote = '' let lastVoiceTranscript = '' let pcmChunks: Uint8Array[] = [] let speechRecognition: any = null let speechTranscript = '' let pageCreated = false  function getVisibleCards(): ChatCard[] { if (!dmOnly) return cards const dms = cards.filter((c) => c.isUser) return dms.length > 0 ? dms : cards }  function getActiveCard(): ChatCard \vert{} undefined { const list = getVisibleCards() if (list.length === 0) return undefined if (chatIdx >= list.length) chatIdx = 0 return list[chatIdx] }  function formatBadge(count: number): string { if (count <= 0) return '' return count > 99 ? ' (99+)' : ` (${count})`
}

function wrapText(text: string, maxLen = 46, maxLines = 3): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxLen) {
      current = (current + ' ' + w).trim()
    } else {
      if (current) lines.push(current)
      current = w.slice(0, maxLen)
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines).join('\n')
}

function encodeWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  if (totalBytes === 0) return ''

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  let binary = ''
  const step = 0x8000
  for (let i = 0; i < out.length; i += step) {
    binary += String.fromCharCode(...out.subarray(i, i + step))
  }
  return btoa(binary)
}

function buildScreenText(): string {
  if (mode === 'LOADING') {
    return 'PULSEGLANCE G2 // SYNCING\n\nFetching Telegram chats & AI digest...\nPlease wait a moment.'
  }

  if (mode === 'ERROR') {
    return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 46, 2)}\n\n[Click] Retry` }  const list = getVisibleCards() const card = getActiveCard() if (!card) { return 'PULSEGLANCE G2\n\nNo active chats found.\n\n[Long Press] Refresh' }  if (mode === 'RECORDING') { const liveHint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak reply (auto-translates to chat lang)...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${liveHint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }

  if (mode === 'TRANSCRIBING') {
    return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching chat language...\nTo: ${card.title.slice(0, 28)}`
  }

  if (mode === 'SENDING') {
    return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n"${(card.replies[replyIdx] || '').slice(0, 44)}"`
  }

  if (mode === 'SENT') {
    return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  }

  if (mode === 'REPLY') {
    const total = card.replies.length || 1
    const replyText = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${total}]\n\n${wrapText(replyText, 46, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice` }  const tag = card.isUser ? 'DM' : 'CH' const header = `[${chatIdx + 1}/${list.length}${tag}] ${card.title.slice(0, 21)}${formatBadge(card.unreadCount)}`
  const body = wrapText(card.summary, 46, 3)
  return `${header}\n${body}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return

  const list = getVisibleCards()
  const card = getActiveCard()
  const activeReply = card?.replies[replyIdx] || ''

  root.innerHTML = `
    <div style="max-width:520px;margin:20px auto;padding:18px;border:1px solid #1e3a2b;border-radius:14px;background:#0b130f;box-shadow:0 8px 30px rgba(0,0,0,0.45);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #173023;padding-bottom:10px;margin-bottom:14px;">
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:0.6px;color:#4ade80;">PULSEGLANCE G2</div>
          <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Live Telegram & AI Voice HUD</div>
        </div>
        <span style="font-size:11px;padding:4px 9px;border-radius:999px;background:#132a1e;color:#4ade80;border:1px solid #22543d;">
          ${mode}
        </span>
      </div>

      <div style="background:#050806;border:1px solid #1c3b2b;border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.5;color:#4ade80;white-space:pre-wrap;">${buildScreenText()}</div>

      ${
        card
          ? `<div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Active (${chatIdx + 1}/${list.length} • ${card.isUser ? 'Personal DM' : 'Group/Channel'}): <strong>${card.title}</strong>${formatBadge(card.unreadCount)}</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #1a3326;">${card.summary}</div>
            </div>
            <div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Selected Draft Reply:</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #244735;color:#6ee7b7;">${activeReply}</div>
            </div>`
          : ''
      }

      ${
        lastVoiceTranscript
          ? `<div style="font-size:11px;color:#86efac;background:#0e2218;padding:8px 10px;border-radius:8px;margin-bottom:12px;">
              Spoken Input: "${lastVoiceTranscript}"
            </div>`
          : ''
      }

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-voice" style="flex:1;paddingcat << 'EOF' > server/index.ts
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import { TelegramClient, sessions } from 'telegram'

dotenv.config()

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH || ''
const openrouterKey = process.env.OPENROUTER_API_KEY || ''
const port = Number(process.env.PORT) || 3001

const SESSION_FILE = '.tg_session'
const savedSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf-8').trim() : ''
const stringSession = new sessions.StringSession(savedSession)

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
})

const dialogEntities = new Map<string, any>()

function parseJsonBlock(raw: string): any {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

async function summarizeAndDraft(chatTitle: string, messagesText: string) {
  const fallback = {
    summary: messagesText.slice(0, 120).replace(/\n+/g, ' '),
    replies: ['Ок, принял!', 'Сейчас посмотрю', 'На связи, скоро отвечу'],
  }

  if (!openrouterKey) return fallback

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [
          {
            role: 'system',
            content:
              'You summarize Telegram messages for Even G2 smart glasses (576x288 HUD). Return ONLY valid JSON: {"summary":"max 115 chars concise summary in the chat language","replies":["reply 1 max 42 chars","reply 2 max 42 chars","reply 3 max 42 chars"]}.',
          },
          {
            role: 'user',
            content: `Chat: ${chatTitle}\nRecent messages:\n${messagesText}`,
          },
        ],
        temperature: 0.3,
      }),
    })

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''
    const parsed = parseJsonBlock(content)
    if (parsed?.summary && Array.isArray(parsed?.replies) && parsed.replies.length > 0) {
      return {
        summary: String(parsed.summary).slice(0, 130),
        replies: parsed.replies.slice(0, 3).map((r: any) => String(r).slice(0, 55)),
      }
    }
  } catch (err) {
    console.error('AI digest error:', err)
  }

  return fallback
}

async function processVoiceReply(
  chatTitle: string,
  summary: string,
  audioBase64?: string,
  transcriptHint?: string
) {
  const hintClean = (transcriptHint || '').trim()

  if (!openrouterKey) {
    const text = hintClean || 'Ок, понял, скоро вернусь с ответом!'
    return { transcript: text, reply: text }
  }

  const languageInstruction = `Detect the language of the chat context ("${summary}"). Transcribe the user's voice input (which may be spoken in Russian or English), clean up filler words, and format a concise, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (automatically translate Russian speech into natural English if the chat context is in English). Return ONLY valid JSON: {"transcript":"original spoken phrase","reply":"final reply in chat language"}.`

  if (audioBase64 && audioBase64.length > 100) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Chat: "${chatTitle}". ${languageInstruction}`,
                },
                {
                  type: 'input_audio',
                  input_audio: {
                    data: audioBase64,
                    format: 'wav',
                  },
                },
              ],
            },
          ],
          temperature: 0.2,
        }),
      })

      const data: any = await res.json()
      const content = data?.choices?.[0]?.message?.content || ''
      const parsed = parseJsonBlock(content)
      if (parsed?.reply) {
        return {
          transcript: String(parsed.transcript || parsed.reply),
          reply: String(parsed.reply).slice(0, 120),
        }
      }
    } catch (err) {
      console.error('AI audio error:', err)
    }
  }

  if (hintClean) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', }, body: JSON.stringify({ model: 'google/gemini-2.0-flash-001', messages: [ { role: 'system', content: 'Detect the language of the chat context. Convert the user voice transcript into a clean, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian to natural English if the chat context is English). Return ONLY the final reply text.', }, { role: 'user', content: `Chat: ${chatTitle}\nChat context: ${summary}\nUser voice transcript:${hintClean}`,
            },
          ],
          temperature: 0.2,
        }),
      })
      const data: any = await res.json()
      const polished = data?.choices?.[0]?.message?.content?.trim()
      if (polished) {
        return { transcript: hintClean, reply: polished.slice(0, 120) }
      }
    } catch (err) {
      console.error('AI text polish error:', err)
    }
    return { transcript: hintClean, reply: hintClean.slice(0, 120) }
  }

  return {
    transcript: 'Голосовое подтверждение',
    reply: 'Got it, will follow up shortly!',
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

app.get('/api/digest', async (_req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 20 })
    const filtered = dialogs
      .filter((d) => d.title && d.message?.message)
      .sort((a, b) => {
        const dmDiff = (b.isUser ? 1 : 0) - (a.isUser ? 1 : 0)
        if (dmDiff !== 0) return dmDiff
        return (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
      })
      .slice(0, 7)

    const cards = []
    for (const d of filtered) {
      const id = String(d.id)
      if (d.entity) dialogEntities.set(id, d.entity)

      const msgs = await client.getMessages(d.entity || d.id, { limit: 4 })
      const textBlock = msgs
        .reverse()
        .map((m) => (m.message || '').trim())
        .filter(Boolean)
        .join('\n')

      if (!textBlock) continue
      const ai = await summarizeAndDraft(d.title || 'Chat', textBlock)
      cards.push({
        id,
        title: d.title || 'Chat',
        isUser: Boolean(d.isUser),
        unreadCount: d.unreadCount || 0,
        summary: ai.summary,
        replies: ai.replies,
      })
    }

    res.json({ ok: true, cards })
  } catch (err: any) {
    console.error('Digest error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice-reply', async (req, res) => {
  try {
    const { chatTitle, summary, audioBase64, transcriptHint } = req.body || {}
    const result = await processVoiceReply(
      chatTitle || 'Chat',
      summary || '',
      audioBase64,
      transcriptHint
    )
    res.json({ ok: true, ...result })
  } catch (err: any) {
    console.error('Voice reply error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body
    if (!chatId || !text) {
      return res.status(400).json({ ok: false, error: 'Missing chatId or text' })
    }
    const target = dialogEntities.get(String(chatId)) || chatId
    await client.sendMessage(target, { message: text })
    res.json({ ok: true })
  } catch (err: any) {
    console.error('Send error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

async function start() {
  await client.connect()
  app.listen(port, () => {
    console.log(`PulseGlance G2 Backend running on http://localhost:${port}`) }) }  start() EOF  cat << 'EOF' > src/main.ts import { waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer, OsEventTypeList, AudioInputSource, } from '@evenrealities/even_hub_sdk' import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'  interface ChatCard { id: string title: string isUser?: boolean unreadCount: number summary: string replies: string[] }  type ScreenMode = 'LOADING' \vert{} 'FEED' \vert{} 'REPLY' \vert{} 'RECORDING' \vert{} 'TRANSCRIBING' \vert{} 'SENDING' \vert{} 'SENT' \vert{} 'ERROR'  const BACKEND_URL = 'http://localhost:3001' const bridge = await waitForEvenAppBridge()  let mode: ScreenMode = 'LOADING' let cards: ChatCard[] = [] let dmOnly = false let chatIdx = 0 let replyIdx = 0 let statusNote = '' let lastVoiceTranscript = '' let pcmChunks: Uint8Array[] = [] let speechRecognition: any = null let speechTranscript = '' let pageCreated = false  function getVisibleCards(): ChatCard[] { if (!dmOnly) return cards const dms = cards.filter((c) => c.isUser) return dms.length > 0 ? dms : cards }  function getActiveCard(): ChatCard \vert{} undefined { const list = getVisibleCards() if (list.length === 0) return undefined if (chatIdx >= list.length) chatIdx = 0 return list[chatIdx] }  function formatBadge(count: number): string { if (count <= 0) return '' return count > 99 ? ' (99+)' : ` (${count})`
}

function wrapText(text: string, maxLen = 46, maxLines = 3): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxLen) {
      current = (current + ' ' + w).trim()
    } else {
      if (current) lines.push(current)
      current = w.slice(0, maxLen)
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines).join('\n')
}

function encodeWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  if (totalBytes === 0) return ''

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  let binary = ''
  const step = 0x8000
  for (let i = 0; i < out.length; i += step) {
    binary += String.fromCharCode(...out.subarray(i, i + step))
  }
  return btoa(binary)
}

function buildScreenText(): string {
  if (mode === 'LOADING') {
    return 'PULSEGLANCE G2 // SYNCING\n\nFetching Telegram chats & AI digest...\nPlease wait a moment.'
  }

  if (mode === 'ERROR') {
    return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 46, 2)}\n\n[Click] Retry` }  const list = getVisibleCards() const card = getActiveCard() if (!card) { return 'PULSEGLANCE G2\n\nNo active chats found.\n\n[Long Press] Refresh' }  if (mode === 'RECORDING') { const liveHint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak reply (auto-translates to chat lang)...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${liveHint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }

  if (mode === 'TRANSCRIBING') {
    return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching chat language...\nTo: ${card.title.slice(0, 28)}`
  }

  if (mode === 'SENDING') {
    return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n"${(card.replies[replyIdx] || '').slice(0, 44)}"`
  }

  if (mode === 'SENT') {
    return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  }

  if (mode === 'REPLY') {
    const total = card.replies.length || 1
    const replyText = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${total}]\n\n${wrapText(replyText, 46, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice` }  const tag = card.isUser ? 'DM' : 'CH' const header = `[${chatIdx + 1}/${list.length}${tag}] ${card.title.slice(0, 21)}${formatBadge(card.unreadCount)}`
  const body = wrapText(card.summary, 46, 3)
  return `${header}\n${body}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return

  const list = getVisibleCards()
  const card = getActiveCard()
  const activeReply = card?.replies[replyIdx] || ''

  root.innerHTML = `
    <div style="max-width:520px;margin:20px auto;padding:18px;border:1px solid #1e3a2b;border-radius:14px;background:#0b130f;box-shadow:0 8px 30px rgba(0,0,0,0.45);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #173023;padding-bottom:10px;margin-bottom:14px;">
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:0.6px;color:#4ade80;">PULSEGLANCE G2</div>
          <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Live Telegram & AI Voice HUD</div>
        </div>
        <span style="font-size:11px;padding:4px 9px;border-radius:999px;background:#132a1e;color:#4ade80;border:1px solid #22543d;">
          ${mode}
        </span>
      </div>

      <div style="background:#050806;border:1px solid #1c3b2b;border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.5;color:#4ade80;white-space:pre-wrap;">${buildScreenText()}</div>

      ${
        card
          ? `<div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Active (${chatIdx + 1}/${list.length} • ${card.isUser ? 'Personal DM' : 'Group/Channel'}): <strong>${card.title}</strong>${formatBadge(card.unreadCount)}</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #1a3326;">${card.summary}</div>
            </div>
            <div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Selected Draft Reply:</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #244735;color:#6ee7b7;">${activeReply}</div>
            </div>`
          : ''
      }

      ${
        lastVoiceTranscript
          ? `<div style="font-size:11px;color:#86efac;background:#0e2218;padding:8px 10px;border-radius:8px;margin-bottom:12px;">
              Spoken Input: "${lastVoiceTranscript}"
            </div>`
          : ''
      }

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-voice" style="flex:1;padding
cat << 'EOF' > server/index.ts
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import { TelegramClient, sessions } from 'telegram'

dotenv.config()

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH || ''
const openrouterKey = process.env.OPENROUTER_API_KEY || ''
const port = Number(process.env.PORT) || 3001

const SESSION_FILE = '.tg_session'
const savedSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf-8').trim() : ''
const stringSession = new sessions.StringSession(savedSession)

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
})

const dialogEntities = new Map<string, any>()

function parseJsonBlock(raw: string): any {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

async function summarizeAndDraft(chatTitle: string, messagesText: string) {
  const fallback = {
    summary: messagesText.slice(0, 120).replace(/\n+/g, ' '),
    replies: ['Ок, принял!', 'Сейчас посмотрю', 'На связи, скоро отвечу'],
  }

  if (!openrouterKey) return fallback

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [
          {
            role: 'system',
            content:
              'You summarize Telegram messages for Even G2 smart glasses (576x288 HUD). Return ONLY valid JSON: {"summary":"max 115 chars concise summary in the chat language","replies":["reply 1 max 42 chars","reply 2 max 42 chars","reply 3 max 42 chars"]}.',
          },
          {
            role: 'user',
            content: `Chat: ${chatTitle}\nRecent messages:\n${messagesText}`,
          },
        ],
        temperature: 0.3,
      }),
    })

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''
    const parsed = parseJsonBlock(content)
    if (parsed?.summary && Array.isArray(parsed?.replies) && parsed.replies.length > 0) {
      return {
        summary: String(parsed.summary).slice(0, 130),
        replies: parsed.replies.slice(0, 3).map((r: any) => String(r).slice(0, 55)),
      }
    }
  } catch (err) {
    console.error('AI digest error:', err)
  }

  return fallback
}

async function processVoiceReply(
  chatTitle: string,
  summary: string,
  audioBase64?: string,
  transcriptHint?: string
) {
  const hintClean = (transcriptHint || '').trim()

  if (!openrouterKey) {
    const text = hintClean || 'Ок, понял, скоро вернусь с ответом!'
    return { transcript: text, reply: text }
  }

  const languageInstruction = `Detect the language of the chat context ("${summary}"). Transcribe the user's voice input (which may be spoken in Russian or English), clean up filler words, and format a concise, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (automatically translate Russian speech into natural English if the chat context is in English). Return ONLY valid JSON: {"transcript":"original spoken phrase","reply":"final reply in chat language"}.`

  if (audioBase64 && audioBase64.length > 100) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Chat: "${chatTitle}". ${languageInstruction}`,
                },
                {
                  type: 'input_audio',
                  input_audio: {
                    data: audioBase64,
                    format: 'wav',
                  },
                },
              ],
            },
          ],
          temperature: 0.2,
        }),
      })

      const data: any = await res.json()
      const content = data?.choices?.[0]?.message?.content || ''
      const parsed = parseJsonBlock(content)
      if (parsed?.reply) {
        return {
          transcript: String(parsed.transcript || parsed.reply),
          reply: String(parsed.reply).slice(0, 120),
        }
      }
    } catch (err) {
      console.error('AI audio error:', err)
    }
  }

  if (hintClean) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', }, body: JSON.stringify({ model: 'google/gemini-2.0-flash-001', messages: [ { role: 'system', content: 'Detect the language of the chat context. Convert the user voice transcript into a clean, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian to natural English if the chat context is English). Return ONLY the final reply text.', }, { role: 'user', content: `Chat: ${chatTitle}\nChat context: ${summary}\nUser voice transcript:${hintClean}`,
            },
          ],
          temperature: 0.2,
        }),
      })
      const data: any = await res.json()
      const polished = data?.choices?.[0]?.message?.content?.trim()
      if (polished) {
        return { transcript: hintClean, reply: polished.slice(0, 120) }
      }
    } catch (err) {
      console.error('AI text polish error:', err)
    }
    return { transcript: hintClean, reply: hintClean.slice(0, 120) }
  }

  return {
    transcript: 'Голосовое подтверждение',
    reply: 'Got it, will follow up shortly!',
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

app.get('/api/digest', async (_req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 20 })
    const filtered = dialogs
      .filter((d) => d.title && d.message?.message)
      .sort((a, b) => {
        const dmDiff = (b.isUser ? 1 : 0) - (a.isUser ? 1 : 0)
        if (dmDiff !== 0) return dmDiff
        return (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
      })
      .slice(0, 7)

    const cards = []
    for (const d of filtered) {
      const id = String(d.id)
      if (d.entity) dialogEntities.set(id, d.entity)

      const msgs = await client.getMessages(d.entity || d.id, { limit: 4 })
      const textBlock = msgs
        .reverse()
        .map((m) => (m.message || '').trim())
        .filter(Boolean)
        .join('\n')

      if (!textBlock) continue
      const ai = await summarizeAndDraft(d.title || 'Chat', textBlock)
      cards.push({
        id,
        title: d.title || 'Chat',
        isUser: Boolean(d.isUser),
        unreadCount: d.unreadCount || 0,
        summary: ai.summary,
        replies: ai.replies,
      })
    }

    res.json({ ok: true, cards })
  } catch (err: any) {
    console.error('Digest error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice-reply', async (req, res) => {
  try {
    const { chatTitle, summary, audioBase64, transcriptHint } = req.body || {}
    const result = await processVoiceReply(
      chatTitle || 'Chat',
      summary || '',
      audioBase64,
      transcriptHint
    )
    res.json({ ok: true, ...result })
  } catch (err: any) {
    console.error('Voice reply error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body
    if (!chatId || !text) {
      return res.status(400).json({ ok: false, error: 'Missing chatId or text' })
    }
    const target = dialogEntities.get(String(chatId)) || chatId
    await client.sendMessage(target, { message: text })
    res.json({ ok: true })
  } catch (err: any) {
    console.error('Send error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

async function start() {
  await client.connect()
  app.listen(port, () => {
    console.log(`PulseGlance G2 Backend running on http://localhost:${port}`) }) }  start() EOF  cat << 'EOF' > src/main.ts import { waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer, OsEventTypeList, AudioInputSource, } from '@evenrealities/even_hub_sdk' import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'  interface ChatCard { id: string title: string isUser?: boolean unreadCount: number summary: string replies: string[] }  type ScreenMode = 'LOADING' \vert{} 'FEED' \vert{} 'REPLY' \vert{} 'RECORDING' \vert{} 'TRANSCRIBING' \vert{} 'SENDING' \vert{} 'SENT' \vert{} 'ERROR'  const BACKEND_URL = 'http://localhost:3001' const bridge = await waitForEvenAppBridge()  let mode: ScreenMode = 'LOADING' let cards: ChatCard[] = [] let dmOnly = false let chatIdx = 0 let replyIdx = 0 let statusNote = '' let lastVoiceTranscript = '' let pcmChunks: Uint8Array[] = [] let speechRecognition: any = null let speechTranscript = '' let pageCreated = false  function getVisibleCards(): ChatCard[] { if (!dmOnly) return cards const dms = cards.filter((c) => c.isUser) return dms.length > 0 ? dms : cards }  function getActiveCard(): ChatCard \vert{} undefined { const list = getVisibleCards() if (list.length === 0) return undefined if (chatIdx >= list.length) chatIdx = 0 return list[chatIdx] }  function formatBadge(count: number): string { if (count <= 0) return '' return count > 99 ? ' (99+)' : ` (${count})`
}

function wrapText(text: string, maxLen = 46, maxLines = 3): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxLen) {
      current = (current + ' ' + w).trim()
    } else {
      if (current) lines.push(current)
      current = w.slice(0, maxLen)
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines).join('\n')
}

function encodeWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  if (totalBytes === 0) return ''

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  let binary = ''
  const step = 0x8000
  for (let i = 0; i < out.length; i += step) {
    binary += String.fromCharCode(...out.subarray(i, i + step))
  }
  return btoa(binary)
}

function buildScreenText(): string {
  if (mode === 'LOADING') {
    return 'PULSEGLANCE G2 // SYNCING\n\nFetching Telegram chats & AI digest...\nPlease wait a moment.'
  }

  if (mode === 'ERROR') {
    return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 46, 2)}\n\n[Click] Retry` }  const list = getVisibleCards() const card = getActiveCard() if (!card) { return 'PULSEGLANCE G2\n\nNo active chats found.\n\n[Long Press] Refresh' }  if (mode === 'RECORDING') { const liveHint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak reply (auto-translates to chat lang)...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${liveHint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }

  if (mode === 'TRANSCRIBING') {
    return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching chat language...\nTo: ${card.title.slice(0, 28)}`
  }

  if (mode === 'SENDING') {
    return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n"${(card.replies[replyIdx] || '').slice(0, 44)}"`
  }

  if (mode === 'SENT') {
    return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  }

  if (mode === 'REPLY') {
    const total = card.replies.length || 1
    const replyText = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${total}]\n\n${wrapText(replyText, 46, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice` }  const tag = card.isUser ? 'DM' : 'CH' const header = `[${chatIdx + 1}/${list.length}${tag}] ${card.title.slice(0, 21)}${formatBadge(card.unreadCount)}`
  const body = wrapText(card.summary, 46, 3)
  return `${header}\n${body}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return

  const list = getVisibleCards()
  const card = getActiveCard()
  const activeReply = card?.replies[replyIdx] || ''

  root.innerHTML = `
    <div style="max-width:520px;margin:20px auto;padding:18px;border:1px solid #1e3a2b;border-radius:14px;background:#0b130f;box-shadow:0 8px 30px rgba(0,0,0,0.45);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #173023;padding-bottom:10px;margin-bottom:14px;">
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:0.6px;color:#4ade80;">PULSEGLANCE G2</div>
          <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Live Telegram & AI Voice HUD</div>
        </div>
        <span style="font-size:11px;padding:4px 9px;border-radius:999px;background:#132a1e;color:#4ade80;border:1px solid #22543d;">
          ${mode}
        </span>
      </div>

      <div style="background:#050806;border:1px solid #1c3b2b;border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.5;color:#4ade80;white-space:pre-wrap;">${buildScreenText()}</div>

      ${
        card
          ? `<div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Active (${chatIdx + 1}/${list.length} • ${card.isUser ? 'Personal DM' : 'Group/Channel'}): <strong>${card.title}</strong>${formatBadge(card.unreadCount)}</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #1a3326;">${card.summary}</div>
            </div>
            <div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Selected Draft Reply:</div>
              <div style="background:#0f1c16;padding:10px;border-radius:8px;border:1px solid #244735;color:#6ee7b7;">${activeReply}</div>
            </div>`
          : ''
      }

      ${
        lastVoiceTranscript
          ? `<div style="font-size:11px;color:#86efac;background:#0e2218;padding:8px 10px;border-radius:8px;margin-bottom:12px;">
              Spoken Input: "${lastVoiceTranscript}"
            </div>`
          : ''
      }

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-voice" style="flex:1;padding
cat << 'EOF' > src/main.ts
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'

interface ChatCard {
  id: string
  title: string
  isUser?: boolean
  unreadCount: number
  summary: string
  replies: string[]
}

type ScreenMode = 'LOADING' | 'FEED' | 'REPLY' | 'RECORDING' | 'TRANSCRIBING' | 'SENDING' | 'SENT' | 'ERROR'

const BACKEND_URL = 'http://localhost:3001'
const bridge = await waitForEvenAppBridge()

let mode: ScreenMode = 'LOADING'
let cards: ChatCard[] = []
let dmOnly = false
let chatIdx = 0
let replyIdx = 0
let statusNote = ''
let lastVoiceTranscript = ''
let pcmChunks: Uint8Array[] = []
let speechRecognition: any = null
let speechTranscript = ''
let pageCreated = false

function getVisibleCards(): ChatCard[] {
  if (!dmOnly) return cards
  const dms = cards.filter((c) => c.isUser)
  return dms.length > 0 ? dms : cards
}

function getActiveCard(): ChatCard | undefined {
  const list = getVisibleCards()
  if (list.length === 0) return undefined
  if (chatIdx >= list.length) chatIdx = 0
  return list[chatIdx]
}

function formatBadge(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? ' (99+)' : ` (${count})`
}

function wrapText(text: string, maxLen = 46, maxLines = 3): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxLen) {
      current = (current + ' ' + w).trim()
    } else {
      if (current) lines.push(current)
      current = w.slice(0, maxLen)
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines).join('\n')
}

function encodeWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  if (totalBytes === 0) return ''

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  let binary = ''
  const step = 0x8000
  for (let i = 0; i < out.length; i += step) {
    binary += String.fromCharCode(...out.subarray(i, i + step))
  }
  return btoa(binary)
}

function buildScreenText(): string {
  if (mode === 'LOADING') {
    return 'PULSEGLANCE G2 // SYNCING\n\nFetching Telegram chats & AI digest...\nPlease wait a moment.'
  }

  if (mode === 'ERROR') {
    return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 46, 2)}\n\n[Click] Retry`
  }

  const list = getVisibleCards()
  const card = getActiveCard()
  if (!card) {
    return 'PULSEGLANCE G2\n\nNo active chats found.\n\n[Long Press] Refresh'
  }

  if (mode === 'RECORDING') {
    const liveHint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak reply (auto-translates to chat lang)...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${liveHint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }

  if (mode === 'TRANSCRIBING') {
    return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching chat language...\nTo: ${card.title.slice(0, 28)}`
  }

  if (mode === 'SENDING') {
    return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n"${(card.replies[replyIdx] || '').slice(0, 44)}"`
  }

  if (mode === 'SENT') {
    return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  }

  if (mode === 'REPLY') {
    const total = card.replies.length || 1
    const replyText = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${total}]\n\n${wrapText(replyText, 46, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice`
  }

  const tag = card.isUser ? 'DM' : 'CH'
  const header = `[${chatIdx + 1}/${list.length} ${tag}] ${card.title.slice(0, 21)}${formatBadge(card.unreadCount)}`
  const body = wrapText(card.summary, 46, 3)
  return `${header}\n${body}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

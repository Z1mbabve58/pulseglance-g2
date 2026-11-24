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
              'You summarize Telegram messages for Even G2 smart glasses (576x288 HUD). Return ONLY valid JSON: {"summary":"max 115 chars concise summary in chat language","replies":["reply 1 max 42 chars","reply 2 max 42 chars","reply 3 max 42 chars"]}.',
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
                  text: `Transcribe this voice message spoken by the user as a reply to Telegram chat "${chatTitle}" (context: "${summary}"). Clean up filler words and format as a natural, concise Telegram message (max 110 chars) in the same language spoken. Return ONLY valid JSON: {"transcript":"...","reply":"..."}.`,
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
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'system',
              content:
                'Polish the user voice transcript into a clean, natural Telegram reply (max 110 chars) in the same language. Return ONLY the final reply text.',
            },
            {
              role: 'user',
              content: `Chat: ${chatTitle}\nContext: ${summary}\nVoice transcript: ${hintClean}`,
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
    reply: 'Принял, скоро отвечу подробнее!',
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

app.get('/api/digest', async (_req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 15 })
    const filtered = dialogs
      .filter((d) => d.title && d.message?.message)
      .sort((a, b) => (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0))
      .slice(0, 6)

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
    console.log(`PulseGlance G2 Backend running on http://localhost:${port}`)
  })
}

start()

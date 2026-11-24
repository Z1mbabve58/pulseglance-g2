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
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'system',
              content:
                'Detect the language of the chat context. Convert the user voice transcript into a clean, natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian to natural English if the chat context is English). Return ONLY the final reply text.',
            },
            {
              role: 'user',
              content: `Chat: ${chatTitle}\nChat context: ${summary}\nUser voice transcript: ${hintClean}`,
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
    const dialogs = await client.getDialogs({ limit: 50 })
    const valid = dialogs.filter((d) => d.title && d.message?.message)

    const humanDms = valid
      .filter((d) => d.isUser && !(d.entity as any)?.bot && !(d.entity as any)?.self)
      .slice(0, 5)

    const groupsAndChannels = valid
      .filter((d) => !d.isUser || Boolean((d.entity as any)?.bot))
      .slice(0, 4)

    const selected = [...humanDms, ...groupsAndChannels]

    const cards = []
    for (const d of selected) {
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
      const isDirectPerson = Boolean(d.isUser && !(d.entity as any)?.bot)
      cards.push({
        id,
        title: d.title || 'Chat',
        isUser: isDirectPerson,
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

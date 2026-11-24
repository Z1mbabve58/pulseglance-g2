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

const savedSession = fs.existsSync('.tg_session') ? fs.readFileSync('.tg_session', 'utf-8').trim() : ''
const client = new TelegramClient(new sessions.StringSession(savedSession), apiId, apiHash, {
  connectionRetries: 5,
})

const dialogEntities = new Map<string, any>()

function trimAtWord(str: string, maxLen: number): string {
  const clean = str.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  const sliced = clean.slice(0, maxLen - 1)
  const lastSpace = sliced.lastIndexOf(' ')
  return (lastSpace > maxLen * 0.5 ? sliced.slice(0, lastSpace) : sliced) + '…'
}

function parseJsonBlock(raw: string): any {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const jsonSlice = start !== -1 && end !== -1 ? cleaned.slice(start, end + 1) : cleaned
  return JSON.parse(jsonSlice)
}

function buildSmartFallback(rawLatest: string, isOut: boolean) {
  const text = rawLatest.replace(/^(Я|[^:]{1,28}):\s*/, '').replace(/\s+/g, ' ').trim()
  const isRu = /[а-яА-ЯёЁ]/.test(text)
  const isQuestion = text.includes('?')
  const hasLink = /https?:\/\//i.test(text)

  const prefix = isOut ? (isRu ? 'Вы: ' : 'You: ') : ''
  const summary = trimAtWord(`${prefix}${text}`, 155)
  const fullDigest = trimAtWord(`${prefix}${text}`, 360)

  let replies: string[]
  if (isRu) {
    if (isQuestion) replies = ['Да, всё верно!', 'Сейчас уточню и напишу', 'Давай обсудим чуть позже']
    else if (hasLink) replies = ['Спасибо, сейчас открою!', 'Гляну ссылку и отпишусь', 'Принял, изучаю']
    else if (isOut) replies = ['Есть апдейт по этому?', 'На связи, если что пиши', 'Жду твоего ответа']
    else replies = ['Понял, спасибо за инфу!', 'Супер, принято', 'Сейчас посмотрю и отвечу']
  } else {
    if (isQuestion) replies = ['Yes, sounds good!', 'Let me check and get back to you', 'Can we discuss shortly?']
    else if (hasLink) replies = ['Thanks, checking the link now!', 'Got it, taking a look', 'Saved, will review soon']
    else if (isOut) replies = ['Any update on this?', 'Following up when you are free', 'Let me know your thoughts']
    else replies = ['Got it, thanks for the update!', 'Sounds great, on it', 'Will review and reply shortly']
  }

  return { summary, fullDigest, replies }
}

async function summarizeAndDraft(chatTitle: string, messagesText: string, latestText: string, isOut: boolean) {
  const fallback = buildSmartFallback(latestText, isOut)
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
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You summarize the NEWEST Telegram messages for Even G2 smart glasses. Messages are ordered oldest to newest ("Я" = user, otherwise contact name). Focus on the LATEST message(s). Never cut words mid-way. Return ONLY valid JSON: {"hudSummary":"complete 1-2 short sentences max 150 chars in the language of the latest message","fullDigest":"complete summary of latest messages max 340 chars","replies":["specific reply 1 max 45 chars","specific reply 2 max 45 chars","specific reply 3 max 45 chars"]}.',
          },
          {
            role: 'user',
            content: `Chat: ${chatTitle}\nMessages (oldest -> newest):\n${messagesText}\n\nNewest message:\n${latestText}`,
          },
        ],
        temperature: 0.3,
      }),
    })
    const data: any = await res.json()
    if (!res.ok || data?.error) {
      console.error(`[AI ERROR] HTTP ${res.status}:`, data?.error?.message || JSON.stringify(data))
      return fallback
    }
    const parsed = parseJsonBlock(data?.choices?.[0]?.message?.content || '')
    if (parsed?.hudSummary && Array.isArray(parsed?.replies) && parsed.replies.length > 0) {
      return {
        summary: trimAtWord(String(parsed.hudSummary), 165),
        fullDigest: trimAtWord(String(parsed.fullDigest || parsed.hudSummary), 380),
        replies: parsed.replies.slice(0, 3).map((r: any) => trimAtWord(String(r), 55)),
      }
    }
  } catch (err: any) {
    console.error('[AI EXCEPTION]:', err?.message || err)
  }
  return fallback
}

async function processVoiceReply(chatTitle: string, summary: string, audioBase64?: string, transcriptHint?: string) {
  const hintClean = (transcriptHint || '').trim()
  if (!openrouterKey) {
    const text = hintClean || 'Ок, понял, скоро вернусь с ответом!'
    return { transcript: text, reply: text }
  }

  const langPrompt = `Detect the language of the chat context ("${summary}"). Transcribe the user's voice input (Russian or English), clean filler words, and write a concise natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian speech to natural English if the chat is in English). Return ONLY JSON: {"transcript":"spoken","reply":"final reply"}.`

  if (audioBase64 && audioBase64.length > 100) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `Chat: "${chatTitle}". ${langPrompt}` },
                { type: 'input_audio', input_audio: { data: audioBase64, format: 'wav' } },
              ],
            },
          ],
          temperature: 0.2,
        }),
      })
      const data: any = await res.json()
      const parsed = parseJsonBlock(data?.choices?.[0]?.message?.content || '')
      if (parsed?.reply) {
        return { transcript: String(parsed.transcript || parsed.reply), reply: trimAtWord(String(parsed.reply), 120) }
      }
    } catch (err) {
      console.error('AI audio error:', err)
    }
  }

  if (hintClean) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            {
              role: 'system',
              content:
                'Detect the language of the chat context. Convert the voice transcript into a natural Telegram reply (max 110 chars) IN THE SAME LANGUAGE AS THE CHAT CONTEXT (translate Russian to English if the chat is in English). Return ONLY the final reply text.',
            },
            { role: 'user', content: `Chat: ${chatTitle}\nContext: ${summary}\nTranscript: ${hintClean}` },
          ],
          temperature: 0.2,
        }),
      })
      const data: any = await res.json()
      const polished = data?.choices?.[0]?.message?.content?.trim()
      if (polished) return { transcript: hintClean, reply: trimAtWord(polished, 120) }
    } catch (err) {
      console.error('AI text error:', err)
    }
    return { transcript: hintClean, reply: trimAtWord(hintClean, 120) }
  }

  return { transcript: 'Голосовое подтверждение', reply: 'Got it, will follow up shortly!' }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

app.get('/api/digest', async (_req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 200 })
    const getTitle = (d: any) =>
      (d.title || d.entity?.firstName || d.entity?.username || 'Direct Message').trim()

    const isMainFolder = (d: any) => !d.archived && d.folderId !== 1
    const isHumanDm = (d: any) =>
      Boolean((d.isUser || d.entity?.className === 'User') && !d.entity?.bot && isMainFolder(d))

    const sortByUnreadAndNewest = (a: any, b: any) => {
      const unreadDiff = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
      if (unreadDiff !== 0) return unreadDiff
      return (b.date || 0) - (a.date || 0)
    }

    const humanDms = dialogs.filter((d) => isHumanDm(d) && d.message).sort(sortByUnreadAndNewest).slice(0, 5)
    const groups = dialogs.filter((d) => !isHumanDm(d) && isMainFolder(d) && d.message).sort(sortByUnreadAndNewest).slice(0, 10)

    const selected = [...humanDms, ...groups]
    const cards: any[] = []

    for (let i = 0; i < selected.length; i += 5) {
      const batch = selected.slice(i, i + 5)
      const results = await Promise.all(
        batch.map(async (d) => {
          try {
            const id = String(d.id)
            const title = getTitle(d)
            if (d.entity) dialogEntities.set(id, d.entity)

            const fetched = await client.getMessages(d.inputEntity || d.entity || d.id, { limit: 15 })
            const allMsgs = [...fetched]
            if (d.message && !allMsgs.some((m) => m.id === d.message?.id)) {
              allMsgs.push(d.message)
            }
            allMsgs.sort((a: any, b: any) => (a.date || 0) - (b.date || 0))

            const messages = allMsgs
              .map((m: any) => {
                const raw = (m.message || '').trim()
                const txt = raw || (m.media ? '[Media / Voice / Sticker]' : '')
                if (!txt) return null
                let senderName = m.out ? 'Я' : title
                if (!m.out && !isHumanDm(d) && m.sender) {
                  senderName = m.sender.firstName || m.sender.title || m.sender.username || title
                }
                return {
                  sender: senderName,
                  text: trimAtWord(txt, 240),
                  out: Boolean(m.out),
                }
              })
              .filter(Boolean) as { sender: string; text: string; out: boolean }[]

            const recentLines = messages.slice(-6).map((m) => `${m.sender}: ${m.text}`)
            const lastMsgObj = allMsgs[allMsgs.length - 1] || d.message
            const isOut = Boolean(lastMsgObj?.out)
            const latestLine = recentLines[recentLines.length - 1] || `${isOut ? 'Я' : title}: [Media]`
            const textBlock = recentLines.length > 0 ? recentLines.join('\n') : latestLine

            const ai = await summarizeAndDraft(title, textBlock, latestLine, isOut)

            return {
              id,
              title,
              isUser: isHumanDm(d),
              unreadCount: d.unreadCount || 0,
              summary: ai.summary,
              fullDigest: ai.fullDigest,
              replies: ai.replies,
              messages,
            }
          } catch (itemErr) {
            console.error('Skip dialog due to error:', itemErr)
            return null
          }
        })
      )
      cards.push(...results.filter(Boolean))
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
    const result = await processVoiceReply(chatTitle || 'Chat', summary || '', audioBase64, transcriptHint)
    res.json({ ok: true, ...result })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body
    if (!chatId || !text) return res.status(400).json({ ok: false, error: 'Missing chatId or text' })
    const target = dialogEntities.get(String(chatId)) || chatId
    await client.sendMessage(target, { message: text })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

async function start() {
  await client.connect()
  app.listen(port, () => console.log(`PulseGlance G2 Backend running on http://localhost:${port}`))
}

start()

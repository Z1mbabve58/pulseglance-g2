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
  unreadCount: number
  summary: string
  replies: string[]
}

type ScreenMode = 'LOADING' | 'FEED' | 'REPLY' | 'RECORDING' | 'TRANSCRIBING' | 'SENDING' | 'SENT' | 'ERROR'

const BACKEND_URL = 'http://localhost:3001'
const bridge = await waitForEvenAppBridge()

let mode: ScreenMode = 'LOADING'
let cards: ChatCard[] = []
let chatIdx = 0
let replyIdx = 0
let statusNote = ''
let lastVoiceTranscript = ''
let pcmChunks: Uint8Array[] = []
let speechRecognition: any = null
let speechTranscript = ''
let pageCreated = false

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

  const card = cards[chatIdx]
  if (!card) {
    return 'PULSEGLANCE G2\n\nNo active chats found.\n\n[Long Press] Refresh'
  }

  if (mode === 'RECORDING') {
    const liveHint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak your reply into G2 mic...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${liveHint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }

  if (mode === 'TRANSCRIBING') {
    return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & crafting reply...\nTo: ${card.title.slice(0, 28)}`
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

  const header = `[${chatIdx + 1}/${cards.length}] ${card.title.slice(0, 25)}${formatBadge(card.unreadCount)}`
  const body = wrapText(card.summary, 46, 3)
  return `${header}\n${body}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return

  const card = cards[chatIdx]
  const activeReply = card?.replies[replyIdx] || ''

  root.innerHTML = `
    <div style="max-width:520px;margin:20px auto;padding:18px;border:1px solid #1e3a2b;border-radius:14px;background:#0b130f;box-shadow:0 8px 30px rgba(0,0,0,0.45);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #173023;padding-bottom:10px;margin-bottom:14px;">
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:0.6px;color:#4ade80;">PULSEGLANCE G2</div>
          <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Live Telegram & AI HUD</div>
        </div>
        <span style="font-size:11px;padding:4px 9px;border-radius:999px;background:#132a1e;color:#4ade80;border:1px solid #22543d;">
          ${mode}
        </span>
      </div>

      <div style="background:#050806;border:1px solid #1c3b2b;border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.5;color:#4ade80;white-space:pre-wrap;">${buildScreenText()}</div>

      ${
        card
          ? `<div style="font-size:12px;color:#a7f3d0;margin-bottom:12px;">
              <div style="opacity:0.7;margin-bottom:4px;">Active Chat (${chatIdx + 1}/${cards.length}): <strong>${card.title}</strong>${formatBadge(card.unreadCount)}</div>
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
              Last Voice Input: "${lastVoiceTranscript}"
            </div>`
          : ''
      }

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-voice" style="flex:1;padding:9px 12px;border-radius:8px;border:1px solid #2f6f4e;background:#143323;color:#4ade80;font-family:inherit;font-size:12px;cursor:pointer;">
          ${mode === 'RECORDING' ? 'Stop & AI Draft' : 'Voice Reply (Hold Sim)'}
        </button>
        <button id="btn-refresh" style="padding:9px 12px;border-radius:8px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:12px;cursor:pointer;">
          Sync TG
        </button>
      </div>
    </div>
  `

  document.getElementById('btn-voice')?.addEventListener('click', () => {
    if (mode === 'RECORDING') {
      void finishVoiceRecording()
    } else {
      void startVoiceRecording()
    }
  })

  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    void loadDigest()
  })
}

async function render(): Promise<void> {
  const content = buildScreenText()
  renderCompanion()

  const container = new TextContainerProperty({
    xPosition: 12,
    yPosition: 12,
    width: 552,
    height: 264,
    borderWidth: 1,
    borderColor: 12,
    paddingLength: 10,
    containerID: 1,
    containerName: 'hud_main',
    content,
    isEventCapture: 1,
  })

  if (!pageCreated) {
    await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [container],
      })
    )
    pageCreated = true
  } else {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'hud_main',
        content,
      })
    )
  }
}

async function loadDigest(): Promise<void> {
  mode = 'LOADING'
  await render()

  try {
    const res = await fetch(`${BACKEND_URL}/api/digest`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to sync Telegram')
    cards = data.cards || []
    chatIdx = 0
    replyIdx = 0
    mode = 'FEED'
  } catch (err: any) {
    statusNote = err?.message || 'Backend unreachable'
    mode = 'ERROR'
  }
  await render()
}

async function startVoiceRecording(): Promise<void> {
  if (!cards[chatIdx]) return
  pcmChunks = []
  speechTranscript = ''
  mode = 'RECORDING'
  await render()

  try {
    await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch {
    // Simulator without physical glasses mic continues with browser speech fallback
  }

  const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (SpeechRec) {
    try {
      speechRecognition = new SpeechRec()
      speechRecognition.lang = 'ru-RU'
      speechRecognition.continuous = true
      speechRecognition.interimResults = true
      speechRecognition.onresult = (e: any) => {
        let text = ''
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0]?.transcript || ''
        }
        speechTranscript = text.trim()
        renderCompanion()
      }
      speechRecognition.start()
    } catch {
      speechRecognition = null
    }
  }
}

async function cancelVoiceRecording(): Promise<void> {
  try {
    await bridge.audioControl(false)
  } catch {
    // ignore
  }
  if (speechRecognition) {
    try {
      speechRecognition.stop()
    } catch {
      // ignore
    }
    speechRecognition = null
  }
  pcmChunks = []
  mode = 'FEED'
  await render()
}

async function finishVoiceRecording(): Promise<void> {
  try {
    await bridge.audioControl(false)
  } catch {
    // ignore
  }
  if (speechRecognition) {
    try {
      speechRecognition.stop()
    } catch {
      // ignore
    }
    speechRecognition = null
  }

  const card = cards[chatIdx]
  if (!card) {
    mode = 'FEED'
    await render()
    return
  }

  mode = 'TRANSCRIBING'
  await render()

  const audioBase64 = encodeWavBase64(pcmChunks, 16000)
  pcmChunks = []

  try {
    const res = await fetch(`${BACKEND_URL}/api/voice-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: card.id,
        chatTitle: card.title,
        summary: card.summary,
        audioBase64,
        transcriptHint: speechTranscript,
      }),
    })
    const data = await res.json()
    if (data?.ok && data?.reply) {
      lastVoiceTranscript = data.transcript || data.reply
      card.replies = [data.reply, ...card.replies.slice(0, 2)]
      replyIdx = 0
      mode = 'REPLY'
    } else {
      statusNote = data?.error || 'Voice AI failed'
      mode = 'ERROR'
    }
  } catch (err: any) {
    statusNote = err?.message || 'Voice request failed'
    mode = 'ERROR'
  }

  await render()
}

async function sendSelectedReply(): Promise<void> {
  const card = cards[chatIdx]
  const text = card?.replies[replyIdx]
  if (!card || !text) return

  mode = 'SENDING'
  await render()

  try {
    const res = await fetch(`${BACKEND_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: card.id, text }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to send')
    mode = 'SENT'
    await render()
    await new Promise((r) => setTimeout(r, 1200))
    mode = 'FEED'
  } catch (err: any) {
    statusNote = err?.message || 'Send error'
    mode = 'ERROR'
  }
  await render()
}

bridge.onEvenHubEvent(async (event: EvenHubEvent) => {
  if (event.audioEvent?.audioPcm && mode === 'RECORDING') {
    pcmChunks.push(event.audioEvent.audioPcm)
    return
  }

  const type = event.textEvent?.eventType ?? event.sysEvent?.eventType

  if (mode === 'ERROR') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) {
      await loadDigest()
    }
    return
  }

  if (mode === 'RECORDING') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) {
      await finishVoiceRecording()
    } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await cancelVoiceRecording()
    }
    return
  }

  if (mode === 'FEED') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT && cards.length > 0) {
      chatIdx = (chatIdx - 1 + cards.length) % cards.length
      replyIdx = 0
      await render()
    } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT && cards.length > 0) {
      chatIdx = (chatIdx + 1) % cards.length
      replyIdx = 0
      await render()
    } else if ((type === OsEventTypeList.CLICK_EVENT || type === undefined) && cards.length > 0) {
      replyIdx = 0
      mode = 'REPLY'
      await render()
    } else if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      if (cards.length > 0) {
        await startVoiceRecording()
      } else {
        await loadDigest()
      }
    } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await bridge.shutDownPageContainer(1)
    }
    return
  }

  if (mode === 'REPLY') {
    const repliesLen = cards[chatIdx]?.replies.length || 1
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
      replyIdx = (replyIdx - 1 + repliesLen) % repliesLen
      await render()
    } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      replyIdx = (replyIdx + 1) % repliesLen
      await render()
    } else if (type === OsEventTypeList.CLICK_EVENT || type === undefined) {
      await sendSelectedReply()
    } else if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      await startVoiceRecording()
    } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      mode = 'FEED'
      await render()
    }
  }
})

void loadDigest()

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getVisibleCards(): ChatCard[] {
  if (!dmOnly) return cards
  const dms = cards.filter((c) => c.isUser)
  return dms
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
    const liveHint = speechTranscript
      ? `\nHeard: "${speechTranscript.slice(-42)}"`
      : '\nSpeak reply (auto-translates to chat lang)...'
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

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return

  const list = getVisibleCards()
  const card = getActiveCard()
  const isRec = mode === 'RECORDING'
  const statusColor = isRec ? '#f87171' : mode === 'SENT' ? '#34d399' : '#4ade80'

  const repliesHtml = card
    ? card.replies
        .map((rep, idx) => {
          const active = idx === replyIdx
          return `<div data-reply-idx="${idx}" class="reply-pill" style="padding:10px 12px;border-radius:10px;border:1px solid ${
            active ? '#34d399' : '#183326'
          };background:${
            active ? 'linear-gradient(135deg,#123524,#0d261a)' : '#0a1510'
          };color:${active ? '#ecfdf5' : '#86efac'};font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s;">
            <span>${idx === 0 && lastVoiceTranscript ? '🎙 ' : ''}${escapeHtml(rep)}</span>
            <span style="font-size:10px;opacity:0.75;padding:2px 6px;border-radius:6px;background:#07110c;">${
              active ? 'SELECTED' : `#${idx + 1}`
            }</span>
          </div>`
        })
        .join('')
    : ''

  root.innerHTML = `
    <div style="min-height:100vh;background:radial-gradient(circle at 50% 0%,#0f291e 0%,#050907 65%);padding:24px 16px;box-sizing:border-box;">
      <div style="max-width:620px;margin:0 auto;padding:22px;border:1px solid #1d3b2c;border-radius:20px;background:rgba(9,18,14,0.94);box-shadow:0 20px 60px rgba(0,0,0,0.7),0 0 40px rgba(74,222,128,0.06);">
        
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${statusColor};box-shadow:0 0 12px ${statusColor};"></div>
            <div>
              <div style="font-size:16px;font-weight:800;letter-spacing:1px;color:#ecfdf5;">PULSEGLANCE <span style="color:#4ade80;">G2</span></div>
              <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Waveguide Telegram & AI Voice HUD</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="font-size:10px;padding:4px 10px;border-radius:999px;background:#0f261b;color:#34d399;border:1px solid #1f4d36;font-weight:600;">MTProto LIVE</span>
            <span style="font-size:10px;padding:4px 10px;border-radius:999px;background:#132a1e;color:${statusColor};border:1px solid #22543d;font-weight:700;">${mode}</span>
          </div>
        </div>

        <div style="padding:14px;border-radius:18px;background:linear-gradient(180deg,#18221d 0%,#0c120f 100%);border:1px solid #2b3f35;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08),0 12px 30px rgba(0,0,0,0.6);margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6ee7b7;opacity:0.65;margin-bottom:8px;padding:0 4px;">
            <span>EVEN G2 WAVEGUIDE DISPLAY • 576×288</span>
            <span>${card ? `${card.isUser ? 'DIRECT MESSAGE' : 'CHANNEL / GROUP'} • ${chatIdx + 1}/${list.length}` : 'STANDBY'}</span>
          </div>
          <div style="background:radial-gradient(circle at 50% 45%,#0b2618 0%,#030a06 85%);border:1px solid #1d4d35;border-radius:12px;padding:18px 20px;min-height:132px;display:flex;align-items:center;box-shadow:inset 0 0 28px rgba(74,222,128,0.12);">
            <pre style="margin:0;width:100%;font-family:'SF Mono',Menlo,monospace;font-size:13.5px;line-height:1.55;color:#4ade80;text-shadow:0 0 10px rgba(74,222,128,0.55);white-space:pre-wrap;">${escapeHtml(buildScreenText())}</pre>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px;">
          <button id="btn-prev" style="padding:10px 8px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;">◀ Prev Chat</button>
          <button id="btn-next" style="padding:10px 8px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;">Next Chat ▶</button>
          <button id="btn-voice" style="padding:10px 8px;border-radius:10px;border:1px solid ${
            isRec ? '#ef4444' : '#2f6f4e'
          };background:${isRec ? '#451212' : '#133323'};color:${
    isRec ? '#fca5a5' : '#4ade80'
  };font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">${isRec ? '⏹ Stop & AI' : '🎙 Voice Reply'}</button>
          <button id="btn-send" style="padding:10px 8px;border-radius:10px;border:1px solid #34d399;background:linear-gradient(135deg,#10b981,#059669);color:#03150d;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;">Send Reply ↵</button>
        </div>

        ${
          card
            ? `<div style="margin-bottom:14px;">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#6ee7b7;margin-bottom:6px;">
                  <span>ACTIVE CHAT: <strong style="color:#ecfdf5;">${escapeHtml(card.title)}${formatBadge(card.unreadCount)}</strong></span>
                  <span style="opacity:0.7;">AI Digest</span>
                </div>
                <div style="background:#0b1711;padding:12px;border-radius:10px;border:1px solid #193527;font-size:12.5px;line-height:1.5;color:#d1fae5;">${escapeHtml(card.summary)}</div>
              </div>
              <div style="margin-bottom:14px;">
                <div style="font-size:11px;color:#6ee7b7;margin-bottom:6px;">SMART & VOICE REPLIES (Click to select, Enter to send):</div>
                <div style="display:flex;flex-direction:column;gap:7px;">${repliesHtml}</div>
              </div>`
            : ''
        }

        ${
          lastVoiceTranscript
            ? `<div style="font-size:11px;color:#86efac;background:#0c2217;border:1px solid #1e4632;padding:8px 12px;border-radius:9px;margin-bottom:14px;">
                🎙 Spoken Input: "${escapeHtml(lastVoiceTranscript)}"
              </div>`
            : ''
        }

        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #162e22;padding-top:12px;gap:8px;flex-wrap:wrap;">
          <div style="font-size:10.5px;color:#6ee7b7;opacity:0.65;">Keys: ←/→ Chats • ↑/↓ Replies • Space Voice • Enter Send</div>
          <div style="display:flex;gap:8px;">
            <button id="btn-filter" style="padding:7px 12px;border-radius:8px;border:1px solid #244735;background:#0f1c16;color:#6ee7b7;font-family:inherit;font-size:11px;cursor:pointer;">
              ${dmOnly ? 'Filter: DMs Only' : 'Filter: All Chats'}
            </button>
            <button id="btn-refresh" style="padding:7px 12px;border-radius:8px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:11px;cursor:pointer;">
              ↻ Sync
            </button>
          </div>
        </div>

      </div>
    </div>
  `

  document.getElementById('btn-prev')?.addEventListener('click', () => {
    if (list.length === 0) return
    chatIdx = (chatIdx - 1 + list.length) % list.length
    replyIdx = 0
    if (mode !== 'RECORDING') mode = 'FEED'
    void render()
  })

  document.getElementById('btn-next')?.addEventListener('click', () => {
    if (list.length === 0) return
    chatIdx = (chatIdx + 1) % list.length
    replyIdx = 0
    if (mode !== 'RECORDING') mode = 'FEED'
    void render()
  })

  document.getElementById('btn-voice')?.addEventListener('click', () => {
    if (mode === 'RECORDING') {
      void finishVoiceRecording()
    } else {
      void startVoiceRecording()
    }
  })

  document.getElementById('btn-send')?.addEventListener('click', () => {
    void sendSelectedReply()
  })

  document.querySelectorAll('.reply-pill').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number((el as HTMLElement).dataset.replyIdx || 0)
      replyIdx = idx
      mode = 'REPLY'
      void render()
    })
  })

  document.getElementById('btn-filter')?.addEventListener('click', () => {
    dmOnly = !dmOnly
    chatIdx = 0
    replyIdx = 0
    void render()
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
  if (!getActiveCard()) return
  pcmChunks = []
  speechTranscript = ''
  mode = 'RECORDING'
  await render()

  try {
    await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch {
    // Simulator fallback
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

  const card = getActiveCard()
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
  const card = getActiveCard()
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

window.addEventListener('keydown', (e) => {
  const list = getVisibleCards()
  const active = getActiveCard()
  if (e.key === 'ArrowRight' && list.length > 0) {
    chatIdx = (chatIdx + 1) % list.length
    replyIdx = 0
    mode = 'FEED'
    void render()
  } else if (e.key === 'ArrowLeft' && list.length > 0) {
    chatIdx = (chatIdx - 1 + list.length) % list.length
    replyIdx = 0
    mode = 'FEED'
    void render()
  } else if (e.key === 'ArrowDown' && active) {
    replyIdx = (replyIdx + 1) % (active.replies.length || 1)
    mode = 'REPLY'
    void render()
  } else if (e.key === 'ArrowUp' && active) {
    const len = active.replies.length || 1
    replyIdx = (replyIdx - 1 + len) % len
    mode = 'REPLY'
    void render()
  } else if (e.code === 'Space') {
    e.preventDefault()
    if (mode === 'RECORDING') void finishVoiceRecording()
    else void startVoiceRecording()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void sendSelectedReply()
  }
})

bridge.onEvenHubEvent(async (event: EvenHubEvent) => {
  if (event.audioEvent?.audioPcm && mode === 'RECORDING') {
    pcmChunks.push(event.audioEvent.audioPcm)
    return
  }

  const type = event.textEvent?.eventType ?? event.sysEvent?.eventType

  if (mode === 'ERROR') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await loadDigest()
    return
  }
  if (mode === 'RECORDING') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await finishVoiceRecording()
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) await cancelVoiceRecording()
    return
  }

  const list = getVisibleCards()
  if (mode === 'FEED') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT && list.length > 0) {
      chatIdx = (chatIdx - 1 + list.length) % list.length
      replyIdx = 0
      await render()
    } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT && list.length > 0) {
      chatIdx = (chatIdx + 1) % list.length
      replyIdx = 0
      await render()
    } else if ((type === OsEventTypeList.CLICK_EVENT || type === undefined) && list.length > 0) {
      replyIdx = 0
      mode = 'REPLY'
      await render()
    } else if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      if (list.length > 0) await startVoiceRecording()
      else await loadDigest()
    } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await bridge.shutDownPageContainer(1)
    }
    return
  }

  if (mode === 'REPLY') {
    const active = getActiveCard()
    const repliesLen = active?.replies.length || 1
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

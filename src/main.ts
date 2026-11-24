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
  fullDigest?: string
  replies: string[]
}

type ScreenMode = 'LOADING' | 'FEED' | 'REPLY' | 'RECORDING' | 'TRANSCRIBING' | 'SENDING' | 'SENT' | 'ERROR'

const BACKEND_URL = 'http://localhost:3001'
let bridge: any = null
try {
  bridge = await Promise.race([
    waitForEvenAppBridge(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
  ])
} catch {
  bridge = null
}

let mode: ScreenMode = 'LOADING'
let cards: ChatCard[] = []
let activeTab: 'DMS' | 'GROUPS' = 'DMS'
let chatIdx = 0
let replyIdx = 0
let statusNote = ''
let lastVoiceTranscript = ''
let pcmChunks: Uint8Array[] = []
let speechRecognition: any = null
let speechTranscript = ''
let pageCreated = false

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const getVisibleCards = () =>
  activeTab === 'DMS' ? cards.filter((c) => Boolean(c.isUser)) : cards.filter((c) => !c.isUser)

function getActiveCard(): ChatCard | undefined {
  const list = getVisibleCards()
  if (list.length === 0) return undefined
  if (chatIdx >= list.length) chatIdx = 0
  return list[chatIdx]
}

const formatBadge = (n: number) => (n <= 0 ? '' : n > 99 ? ' (99+)' : ` (${n})`)

function wrapText(text: string, maxLen = 48, maxLines = 4): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length <= maxLen) cur = (cur + ' ' + w).trim()
    else {
      if (cur) lines.push(cur)
      cur = w.slice(0, maxLen)
    }
  }
  if (cur) lines.push(cur)
  if (lines.length <= maxLines) return lines.join('\n')
  const trimmed = lines.slice(0, maxLines)
  trimmed[maxLines - 1] = trimmed[maxLines - 1].replace(/\s+\S*$/, '') + '…'
  return trimmed.join('\n')
}

function encodeWavBase64(chunks: Uint8Array[], rate = 16000): string {
  const total = chunks.reduce((a, c) => a + c.byteLength, 0)
  if (!total) return ''
  const buf = new ArrayBuffer(44 + total)
  const v = new DataView(buf)
  const wr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  wr(0, 'RIFF'); v.setUint32(4, 36 + total, true); wr(8, 'WAVE'); wr(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); wr(36, 'data'); v.setUint32(40, total, true)
  const out = new Uint8Array(buf)
  let off = 44
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  let bin = ''
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
  return btoa(bin)
}

function buildScreenText(): string {
  if (mode === 'LOADING') return 'PULSEGLANCE G2 // SYNCING\n\nFetching 5 DMs & 10 Groups...\nPlease wait a moment.'
  if (mode === 'ERROR') return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 48, 2)}\n\n[Click] Retry`
  const list = getVisibleCards()
  const card = getActiveCard()
  if (!card) return `PULSEGLANCE G2 // ${activeTab}\n\nNo chats in this tab.\nSwitch tab or press Sync.`
  if (mode === 'RECORDING') {
    const hint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-42)}"` : '\nSpeak reply (auto-translates)...'
    return `PULSEGLANCE G2 // VOICE INPUT\nTo: ${card.title.slice(0, 28)}${hint}\n\n[Click] Done & AI Draft  [2x] Cancel`
  }
  if (mode === 'TRANSCRIBING') return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching language...\nTo: ${card.title.slice(0, 28)}`
  if (mode === 'SENDING') return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n"${(card.replies[replyIdx] || '').slice(0, 44)}"`
  if (mode === 'SENT') return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  if (mode === 'REPLY') {
    const rep = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${card.replies.length || 1}]\n\n${wrapText(rep, 48, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice`
  }
  const tag = activeTab === 'DMS' ? 'DM' : 'GRP'
  return `[${tag} ${chatIdx + 1}/${list.length}] ${card.title.slice(0, 22)}${formatBadge(card.unreadCount)}\n${wrapText(card.summary, 48, 4)}\n[Scroll] Next [Click] Reply [Hold] Voice`
}

function renderCompanion(): void {
  const root = document.getElementById('app')
  if (!root) return
  const dmCount = cards.filter((c) => Boolean(c.isUser)).length
  const grpCount = cards.filter((c) => !c.isUser).length
  const list = getVisibleCards()
  const card = getActiveCard()
  const isRec = mode === 'RECORDING'
  const stCol = isRec ? '#f87171' : mode === 'SENT' ? '#34d399' : '#4ade80'

  const repliesHtml = card
    ? card.replies.map((rep, idx) => {
        const act = idx === replyIdx
        return `<div data-reply-idx="${idx}" class="reply-pill" style="padding:10px 12px;border-radius:10px;border:1px solid ${act ? '#34d399' : '#183326'};background:${act ? '#123524' : '#0a1510'};color:${act ? '#ecfdf5' : '#86efac'};font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
          <span>${idx === 0 && lastVoiceTranscript ? '🎙 ' : ''}${esc(rep)}</span>
          <span style="font-size:10px;opacity:0.75;padding:2px 6px;border-radius:6px;background:#07110c;">${act ? 'SELECTED' : `#${idx + 1}`}</span>
        </div>`
      }).join('')
    : ''

  root.innerHTML = `
    <div style="min-height:100vh;background:radial-gradient(circle at 50% 0%,#0f291e 0%,#050907 65%);padding:24px 16px;box-sizing:border-box;">
      <div style="max-width:620px;margin:0 auto;padding:22px;border:1px solid #1d3b2c;border-radius:20px;background:rgba(9,18,14,0.94);box-shadow:0 20px 60px rgba(0,0,0,0.7);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${stCol};box-shadow:0 0 12px ${stCol};"></div>
            <div>
              <div style="font-size:16px;font-weight:800;letter-spacing:1px;color:#ecfdf5;">PULSEGLANCE <span style="color:#4ade80;">G2</span></div>
              <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Waveguide Telegram & AI Voice HUD</div>
            </div>
          </div>
          <span style="font-size:10px;padding:4px 10px;border-radius:999px;background:#132a1e;color:${stCol};border:1px solid #22543d;font-weight:700;">${mode}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:5px;border-radius:12px;background:#07110c;border:1px solid #183426;margin-bottom:14px;">
          <button id="tab-dms" style="padding:9px;border-radius:9px;border:1px solid ${activeTab === 'DMS' ? '#34d399' : 'transparent'};background:${activeTab === 'DMS' ? '#133826' : 'transparent'};color:${activeTab === 'DMS' ? '#ecfdf5' : '#6ee7b7'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">👤 DMs Only (${dmCount})</button>
          <button id="tab-groups" style="padding:9px;border-radius:9px;border:1px solid ${activeTab === 'GROUPS' ? '#34d399' : 'transparent'};background:${activeTab === 'GROUPS' ? '#133826' : 'transparent'};color:${activeTab === 'GROUPS' ? '#ecfdf5' : '#6ee7b7'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">👥 Groups Only (${grpCount})</button>
        </div>

        <div style="padding:14px;border-radius:18px;background:#0e1612;border:1px solid #2b3f35;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#6ee7b7;opacity:0.65;margin-bottom:8px;">
            <span>EVEN G2 WAVEGUIDE DISPLAY • 576×288</span>
            <span>${card ? `${activeTab} • ${chatIdx + 1}/${list.length}` : 'EMPTY TAB'}</span>
          </div>
          <div style="background:#040d08;border:1px solid #1d4d35;border-radius:12px;padding:18px;min-height:132px;display:flex;align-items:center;">
            <pre style="margin:0;width:100%;font-family:'SF Mono',Menlo,monospace;font-size:13.5px;line-height:1.55;color:#4ade80;text-shadow:0 0 10px rgba(74,222,128,0.5);white-space:pre-wrap;">${esc(buildScreenText())}</pre>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">
          <button id="btn-prev" style="padding:10px 8px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;">◀ Prev</button>
          <button id="btn-next" style="padding:10px 8px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;">Next ▶</button>
          <button id="btn-voice" style="padding:10px 8px;border-radius:10px;border:1px solid ${isRec ? '#ef4444' : '#2f6f4e'};background:${isRec ? '#451212' : '#133323'};color:${isRec ? '#fca5a5' : '#4ade80'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">${isRec ? '⏹ Stop' : '🎙 Voice'}</button>
          <button id="btn-send" style="padding:10px 8px;border-radius:10px;border:1px solid #34d399;background:#10b981;color:#03150d;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;">Send ↵</button>
        </div>

        ${card ? `<div style="margin-bottom:14px;">
          <div style="font-size:11px;color:#6ee7b7;margin-bottom:6px;">ACTIVE: <strong style="color:#ecfdf5;">${esc(card.title)}${formatBadge(card.unreadCount)}</strong></div>
          <div style="background:#0b1711;padding:12px;border-radius:10px;border:1px solid #193527;font-size:12.5px;line-height:1.5;color:#d1fae5;">${esc(card.fullDigest || card.summary)}</div>
        </div>
        <div style="margin-bottom:14px;display:flex;flex-direction:column;gap:7px;">${repliesHtml}</div>` : ''}

        ${lastVoiceTranscript ? `<div style="font-size:11px;color:#86efac;background:#0c2217;border:1px solid #1e4632;padding:8px 12px;border-radius:9px;margin-bottom:14px;">🎙 Spoken: "${esc(lastVoiceTranscript)}"</div>` : ''}

        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #162e22;padding-top:12px;">
          <span style="font-size:10.5px;color:#6ee7b7;opacity:0.65;">Tab • ←/→ Chats • ↑/↓ Replies • Space Voice • Enter Send</span>
          <button id="btn-refresh" style="padding:7px 14px;border-radius:8px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;">↻ Sync</button>
        </div>
      </div>
    </div>`

  document.getElementById('tab-dms')?.addEventListener('click', () => { activeTab = 'DMS'; chatIdx = 0; replyIdx = 0; if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('tab-groups')?.addEventListener('click', () => { activeTab = 'GROUPS'; chatIdx = 0; replyIdx = 0; if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-prev')?.addEventListener('click', () => { if (!list.length) return; chatIdx = (chatIdx - 1 + list.length) % list.length; replyIdx = 0; if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-next')?.addEventListener('click', () => { if (!list.length) return; chatIdx = (chatIdx + 1) % list.length; replyIdx = 0; if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-voice')?.addEventListener('click', () => { if (mode === 'RECORDING') void finishVoiceRecording(); else void startVoiceRecording() })
  document.getElementById('btn-send')?.addEventListener('click', () => { void sendSelectedReply() })
  document.querySelectorAll('.reply-pill').forEach((el) => el.addEventListener('click', () => { replyIdx = Number((el as HTMLElement).dataset.replyIdx || 0); mode = 'REPLY'; void render() }))
  document.getElementById('btn-refresh')?.addEventListener('click', () => { void loadDigest() })
}

async function render(): Promise<void> {
  const content = buildScreenText()
  renderCompanion()
  if (!bridge) return
  try {
    const container = new TextContainerProperty({
      xPosition: 12, yPosition: 12, width: 552, height: 264,
      borderWidth: 1, borderColor: 12, paddingLength: 10,
      containerID: 1, containerName: 'hud_main', content, isEventCapture: 1,
    })
    if (!pageCreated) {
      await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }))
      pageCreated = true
    } else {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'hud_main', content }))
    }
  } catch {}
}

async function loadDigest(): Promise<void> {
  mode = 'LOADING'
  await render()
  try {
    const res = await fetch(`${BACKEND_URL}/api/digest`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to sync')
    cards = data.cards || []
    chatIdx = 0; replyIdx = 0; mode = 'FEED'
  } catch (err: any) {
    statusNote = err?.message || 'Backend unreachable'
    mode = 'ERROR'
  }
  await render()
}

async function startVoiceRecording(): Promise<void> {
  if (!getActiveCard()) return
  pcmChunks = []; speechTranscript = ''; mode = 'RECORDING'
  await render()
  try { await bridge?.audioControl(true, AudioInputSource.Glasses) } catch {}
  const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (SpeechRec) {
    try {
      speechRecognition = new SpeechRec()
      speechRecognition.lang = 'ru-RU'; speechRecognition.continuous = true; speechRecognition.interimResults = true
      speechRecognition.onresult = (e: any) => {
        let t = ''
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0]?.transcript || ''
        speechTranscript = t.trim(); renderCompanion()
      }
      speechRecognition.start()
    } catch { speechRecognition = null }
  }
}

async function cancelVoiceRecording(): Promise<void> {
  try { await bridge?.audioControl(false) } catch {}
  try { speechRecognition?.stop() } catch {}
  speechRecognition = null; pcmChunks = []; mode = 'FEED'
  await render()
}

async function finishVoiceRecording(): Promise<void> {
  try { await bridge?.audioControl(false) } catch {}
  try { speechRecognition?.stop() } catch {}
  speechRecognition = null
  const card = getActiveCard()
  if (!card) { mode = 'FEED'; await render(); return }
  mode = 'TRANSCRIBING'; await render()
  const audioBase64 = encodeWavBase64(pcmChunks, 16000)
  pcmChunks = []
  try {
    const res = await fetch(`${BACKEND_URL}/api/voice-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: card.id, chatTitle: card.title, summary: card.fullDigest || card.summary, audioBase64, transcriptHint: speechTranscript }),
    })
    const data = await res.json()
    if (data?.ok && data?.reply) {
      lastVoiceTranscript = data.transcript || data.reply
      card.replies = [data.reply, ...card.replies.slice(0, 2)]
      replyIdx = 0; mode = 'REPLY'
    } else { statusNote = data?.error || 'Voice AI failed'; mode = 'ERROR' }
  } catch (err: any) { statusNote = err?.message || 'Voice request failed'; mode = 'ERROR' }
  await render()
}

async function sendSelectedReply(): Promise<void> {
  const card = getActiveCard()
  const text = card?.replies[replyIdx]
  if (!card || !text) return
  mode = 'SENDING'; await render()
  try {
    const res = await fetch(`${BACKEND_URL}/api/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: card.id, text }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to send')
    mode = 'SENT'; await render()
    await new Promise((r) => setTimeout(r, 1200))
    mode = 'FEED'
  } catch (err: any) { statusNote = err?.message || 'Send error'; mode = 'ERROR' }
  await render()
}

window.addEventListener('keydown', (e) => {
  const list = getVisibleCards(); const active = getActiveCard()
  if (e.key === 'Tab') { e.preventDefault(); activeTab = activeTab === 'DMS' ? 'GROUPS' : 'DMS'; chatIdx = 0; replyIdx = 0; mode = 'FEED'; void render() }
  else if (e.key === 'ArrowRight' && list.length) { chatIdx = (chatIdx + 1) % list.length; replyIdx = 0; mode = 'FEED'; void render() }
  else if (e.key === 'ArrowLeft' && list.length) { chatIdx = (chatIdx - 1 + list.length) % list.length; replyIdx = 0; mode = 'FEED'; void render() }
  else if (e.key === 'ArrowDown' && active) { replyIdx = (replyIdx + 1) % (active.replies.length || 1); mode = 'REPLY'; void render() }
  else if (e.key === 'ArrowUp' && active) { const l = active.replies.length || 1; replyIdx = (replyIdx - 1 + l) % l; mode = 'REPLY'; void render() }
  else if (e.code === 'Space') { e.preventDefault(); if (mode === 'RECORDING') void finishVoiceRecording(); else void startVoiceRecording() }
  else if (e.key === 'Enter') { e.preventDefault(); void sendSelectedReply() }
})

bridge?.onEvenHubEvent(async (event: EvenHubEvent) => {
  if (event.audioEvent?.audioPcm && mode === 'RECORDING') { pcmChunks.push(event.audioEvent.audioPcm); return }
  const type = event.textEvent?.eventType ?? event.sysEvent?.eventType
  if (mode === 'ERROR') { if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await loadDigest(); return }
  if (mode === 'RECORDING') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await finishVoiceRecording()
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) await cancelVoiceRecording()
    return
  }
  const list = getVisibleCards()
  if (mode === 'FEED') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT && list.length) { chatIdx = (chatIdx - 1 + list.length) % list.length; replyIdx = 0; await render() }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT && list.length) { chatIdx = (chatIdx + 1) % list.length; replyIdx = 0; await render() }
    else if ((type === OsEventTypeList.CLICK_EVENT || type === undefined) && list.length) { replyIdx = 0; mode = 'REPLY'; await render() }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) { if (list.length) await startVoiceRecording(); else await loadDigest() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { await bridge?.shutDownPageContainer(1) }
    return
  }
  if (mode === 'REPLY') {
    const active = getActiveCard(); const len = active?.replies.length || 1
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) { replyIdx = (replyIdx - 1 + len) % len; await render() }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) { replyIdx = (replyIdx + 1) % len; await render() }
    else if (type === OsEventTypeList.CLICK_EVENT || type === undefined) { await sendSelectedReply() }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) { await startVoiceRecording() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { mode = 'FEED'; await render() }
  }
})

void loadDigest()

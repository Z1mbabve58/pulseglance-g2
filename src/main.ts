import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { Glasses3DViewer } from './glasses3d'

interface ChatMessage {
  id?: number
  sender: string
  text: string
  out: boolean
  hasImage?: boolean
  urls?: string[]
}

interface ChatCard {
  id: string
  title: string
  isUser?: boolean
  unreadCount: number
  summary: string
  fullDigest?: string
  replies: string[]
  messages?: ChatMessage[]
}

interface AttachmentItem {
  type: 'IMAGE' | 'LINK'
  label: string
  url: string
  sender: string
}

type ScreenMode = 'LOADING' | 'FEED' | 'HISTORY' | 'MEDIA' | 'REPLY' | 'RECORDING' | 'TRANSCRIBING' | 'SENDING' | 'SENT' | 'ERROR'

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
let mediaIdx = 0
let msgScrollEnd = 0
let lightboxUrl = ''
let statusNote = ''
let sendingLabel = ''
let pcmChunks: Uint8Array[] = []
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let recordedChunks: BlobPart[] = []
let speechRecognition: any = null
let speechTranscript = ''
let pageCreated = false

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function linkifyEscaped(raw: string): string {
  return esc(raw).replace(
    /(https?:\/\/[^\s<>"')]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#34d399;text-decoration:underline;word-break:break-all;">$1</a>'
  )
}

const getVisibleCards = () =>
  activeTab === 'DMS' ? cards.filter((c) => Boolean(c.isUser)) : cards.filter((c) => !c.isUser)

function getActiveCard(): ChatCard | undefined {
  const list = getVisibleCards()
  if (list.length === 0) return undefined
  if (chatIdx >= list.length) chatIdx = 0
  return list[chatIdx]
}

function getChatAttachments(card?: ChatCard): AttachmentItem[] {
  if (!card?.messages) return []
  const items: AttachmentItem[] = []
  for (const m of card.messages) {
    if (m.hasImage && m.id) {
      items.push({
        type: 'IMAGE',
        label: `📷 Photo from ${m.sender}`,
        url: `${BACKEND_URL}/api/media/${encodeURIComponent(card.id)}/${m.id}`,
        sender: m.sender,
      })
    }
    for (const u of m.urls || []) {
      const cleanHost = u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 34)
      items.push({
        type: 'LINK',
        label: `🔗 ${cleanHost}`,
        url: u,
        sender: m.sender,
      })
    }
  }
  return items
}

function resetChatCursor(): void {
  replyIdx = 0
  mediaIdx = 0
  msgScrollEnd = (getActiveCard()?.messages || []).length
}

function getHistoryWindow(card?: ChatCard): { start: number; end: number; total: number; slice: ChatMessage[] } {
  const msgs = card?.messages || []
  const total = msgs.length
  if (total === 0) return { start: 0, end: 0, total: 0, slice: [] }
  const end = Math.min(total, Math.max(Math.min(3, total), msgScrollEnd || total))
  const start = Math.max(0, end - 3)
  return { start, end, total, slice: msgs.slice(start, end) }
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const res = String(reader.result || '')
      resolve(res.includes(',') ? res.split(',')[1] : '')
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function buildScreenText(): string {
  if (mode === 'LOADING') return 'PULSEGLANCE G2 // SYNCING\n\nFetching 5 DMs & 10 Groups...\nPlease wait a moment.'
  if (mode === 'ERROR') return `PULSEGLANCE G2 // ERROR\n\n${wrapText(statusNote, 48, 2)}\n\n[Click] Retry`
  const list = getVisibleCards()
  const card = getActiveCard()
  if (!card) return `PULSEGLANCE G2 // ${activeTab}\n\nNo chats in this tab.\nSwitch tab or press Sync.`

  if (mode === 'MEDIA') {
    const atts = getChatAttachments(card)
    if (atts.length === 0) {
      return `MEDIA & LINKS // ${card.title.slice(0, 22)}\n\nNo images or links in recent messages.\n\n[Click] Reply  [2x] Back`
    }
    if (mediaIdx >= atts.length) mediaIdx = 0
    const cur = atts[mediaIdx]
    return `MEDIA [${mediaIdx + 1}/${atts.length}] ${card.title.slice(0, 21)}\n\n${wrapText(cur.label, 48, 2)}\n\n[Scroll] Next [Click/O] Open [2x] Back`
  }

  if (mode === 'HISTORY') {
    const { start, end, total, slice } = getHistoryWindow(card)
    if (total === 0) return `THREAD // ${card.title.slice(0, 26)}\n\n${wrapText(card.summary, 48, 3)}\n\n[Click] Reply [Hold] Voice [2x] Back`
    const header = `THREAD [${start + 1}-${end}/${total}] ${card.title.slice(0, 19)}`
    const body = slice
      .map((m) => {
        const badge = m.hasImage ? ' [IMG]' : m.urls?.length ? ' [URL]' : ''
        return wrapText(`${m.out ? 'Я' : m.sender.slice(0, 10)}${badge}: ${m.text}`, 48, 2)
      })
      .join('\n')
    return `${header}\n${body}\n[Scroll] History [Click] Reply [O] Media`
  }

  if (mode === 'RECORDING') {
    const hint = speechTranscript ? `\nHeard: "${speechTranscript.slice(-40)}"` : '\nRecording voice note (mic active)...'
    return `PULSEGLANCE G2 // VOICE NOTE\nTo: ${card.title.slice(0, 28)}${hint}\n\n[Click] Send Audio  [2x] Cancel`
  }
  if (mode === 'TRANSCRIBING') return `PULSEGLANCE G2 // AI VOICE\n\nTranscribing & matching language...\nTo: ${card.title.slice(0, 28)}`
  if (mode === 'SENDING') return `PULSEGLANCE G2 // SENDING\n\nTo: ${card.title.slice(0, 28)}\n${sendingLabel || 'Delivering message...'}`
  if (mode === 'SENT') return `PULSEGLANCE G2 // SENT ✓\n\nDelivered to ${card.title.slice(0, 28)}\nReturning to feed...`
  if (mode === 'REPLY') {
    const rep = card.replies[replyIdx] || 'Ок, принял!'
    return `REPLY -> ${card.title.slice(0, 22)} [${replyIdx + 1}/${card.replies.length || 1}]\n\n${wrapText(rep, 48, 2)}\n\n[Scroll] Next [Click] Send [Hold] Voice`
  }
  const tag = activeTab === 'DMS' ? 'DM' : 'GRP'
  const attCount = getChatAttachments(card).length
  const attBadge = attCount > 0 ? ` [${attCount} media]` : ''
  return `[${tag} ${chatIdx + 1}/${list.length}] ${card.title.slice(0, 18)}${formatBadge(card.unreadCount)}${attBadge}\n${wrapText(card.summary, 48, 4)}\n[Scroll] Chat [Click] Thread [M] Media`
}

let glasses3d: Glasses3DViewer | null = null

function ensureGlasses3D(): Glasses3DViewer {
  if (glasses3d) return glasses3d
  glasses3d = new Glasses3DViewer({
    onTap: () => {
      if (mode === 'RECORDING') void finishVoiceRecording(true)
      else if (mode === 'FEED') { resetChatCursor(); mode = 'HISTORY'; void render() }
      else if (mode === 'HISTORY') { replyIdx = 0; mode = 'REPLY'; void render() }
      else if (mode === 'MEDIA') openSelectedAttachment()
      else if (mode === 'REPLY') void sendSelectedReply()
    },
    onScroll: (dir) => {
      const list = getVisibleCards()
      const active = getActiveCard()
      if (mode === 'FEED' && list.length) {
        chatIdx = (chatIdx + dir + list.length) % list.length
        resetChatCursor(); void render()
      } else if (mode === 'HISTORY') {
        scrollHistory(dir)
      } else if (mode === 'MEDIA') {
        const a = getChatAttachments(active)
        if (a.length) { mediaIdx = (mediaIdx + dir + a.length) % a.length; void render() }
      } else if (mode === 'REPLY' && active) {
        const l = active.replies.length || 1
        replyIdx = (replyIdx + dir + l) % l; void render()
      }
    },
    onHold: () => {
      if (mode === 'RECORDING') void finishVoiceRecording(true)
      else void startVoiceRecording()
    },
  })
  return glasses3d
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
  const win = getHistoryWindow(card)
  const atts = getChatAttachments(card)

  const threadHtml = card && win.total > 0
    ? (card.messages || []).map((m, idx) => {
        const inHud = idx >= win.start && idx < win.end
        const imgUrl = m.hasImage && m.id ? `${BACKEND_URL}/api/media/${encodeURIComponent(card.id)}/${m.id}` : ''
        const linkPills = (m.urls || [])
          .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:5px;margin-right:6px;padding:3px 8px;border-radius:6px;background:#0d2b1d;border:1px solid #2b6649;color:#6ee7b7;font-size:10.5px;text-decoration:none;">🔗 ${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32))} ↗</a>`)
          .join('')

        return `<div class="${inHud ? 'hud-active-msg' : ''}" style="padding:8px 10px;border-radius:9px;margin-bottom:6px;border:1px solid ${inHud ? '#2e6f4e' : '#152b20'};background:${m.out ? (inHud ? '#123323' : '#0c2217') : (inHud ? '#0e2419' : '#08130e')};color:#d1fae5;font-size:12px;line-height:1.45;">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:${m.out ? '#4ade80' : '#6ee7b7'};margin-bottom:3px;font-weight:700;">
            <span>${esc(m.sender)}</span>
            ${inHud ? '<span style="opacity:0.8;">ON HUD</span>' : ''}
          </div>
          <div>${linkifyEscaped(m.text)}</div>
          ${imgUrl ? `<div style="margin-top:6px;"><img data-lightbox="${esc(imgUrl)}" class="chat-thumb" src="${esc(imgUrl)}" alt="Photo" style="max-width:100%;max-height:150px;border-radius:8px;border:1px solid #2a5c43;cursor:zoom-in;display:block;" /></div>` : ''}
          ${linkPills ? `<div>${linkPills}</div>` : ''}
        </div>`
      }).join('')
    : `<div style="font-size:12px;color:#6ee7b7;opacity:0.75;">${linkifyEscaped(card?.fullDigest || card?.summary || '')}</div>`

  const repliesHtml = card
    ? card.replies.map((rep, idx) => {
        const act = idx === replyIdx
        return `<div data-reply-idx="${idx}" class="reply-pill" style="padding:9px 12px;border-radius:10px;border:1px solid ${act ? '#34d399' : '#183326'};background:${act ? '#123524' : '#0a1510'};color:${act ? '#ecfdf5' : '#86efac'};font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
          <span>${esc(rep)}</span>
          <span style="font-size:10px;opacity:0.75;padding:2px 6px;border-radius:6px;background:#07110c;">${act ? 'SELECTED' : `#${idx + 1}`}</span>
        </div>`
      }).join('')
    : ''

  const lightboxHtml = lightboxUrl
    ? `<div id="lightbox-overlay" style="position:fixed;inset:0;background:rgba(2,8,5,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;">
        <img src="${esc(lightboxUrl)}" style="max-width:92vw;max-height:80vh;border-radius:14px;border:1px solid #34d399;box-shadow:0 20px 60px rgba(0,0,0,0.85);" />
        <button id="btn-close-lightbox" style="margin-top:14px;padding:8px 18px;border-radius:10px;border:1px solid #34d399;background:#123524;color:#ecfdf5;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">✕ Close Preview (Esc)</button>
      </div>`
    : ''

  root.innerHTML = `
    ${lightboxHtml}
    <div style="min-height:100vh;background:radial-gradient(circle at 50% 0%,#0f291e 0%,#050907 65%);padding:20px 16px;box-sizing:border-box;">
      <div style="max-width:620px;margin:0 auto;padding:20px;border:1px solid #1d3b2c;border-radius:20px;background:rgba(9,18,14,0.94);box-shadow:0 20px 60px rgba(0,0,0,0.7);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${stCol};box-shadow:0 0 12px ${stCol};"></div>
            <div>
              <div style="font-size:16px;font-weight:800;letter-spacing:1px;color:#ecfdf5;">PULSEGLANCE <span style="color:#4ade80;">G2</span></div>
              <div style="font-size:11px;color:#6ee7b7;opacity:0.75;">Even Realities G2 • Waveguide Telegram & AI Voice HUD</div>
            </div>
          </div>
          <span style="font-size:10px;padding:4px 10px;border-radius:999px;background:#132a1e;color:${stCol};border:1px solid #22543d;font-weight:700;">${mode}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:5px;border-radius:12px;background:#07110c;border:1px solid #183426;margin-bottom:12px;">
          <button id="tab-dms" style="padding:8px;border-radius:9px;border:1px solid ${activeTab === 'DMS' ? '#34d399' : 'transparent'};background:${activeTab === 'DMS' ? '#133826' : 'transparent'};color:${activeTab === 'DMS' ? '#ecfdf5' : '#6ee7b7'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">👤 DMs Only (${dmCount})</button>
          <button id="tab-groups" style="padding:8px;border-radius:9px;border:1px solid ${activeTab === 'GROUPS' ? '#34d399' : 'transparent'};background:${activeTab === 'GROUPS' ? '#133826' : 'transparent'};color:${activeTab === 'GROUPS' ? '#ecfdf5' : '#6ee7b7'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;">👥 Groups Only (${grpCount})</button>
        </div>

        <div id="g2-3d-mount" style="margin-bottom:12px;"></div>

        ${isRec ? `
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin-bottom:14px;">
          <button id="btn-voice-send" style="padding:10px 8px;border-radius:10px;border:1px solid #34d399;background:#10b981;color:#03150d;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;">🎙 Send Voice Note ↵</button>
          <button id="btn-voice-text" style="padding:10px 8px;border-radius:10px;border:1px solid #2f6f4e;background:#133323;color:#86efac;font-family:inherit;font-size:11.5px;font-weight:700;cursor:pointer;">📝 To Text</button>
          <button id="btn-voice-cancel" style="padding:10px 8px;border-radius:10px;border:1px solid #ef4444;background:#451212;color:#fca5a5;font-family:inherit;font-size:11.5px;font-weight:700;cursor:pointer;">✕ Cancel</button>
        </div>` : `
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:14px;">
          <button id="btn-prev" style="padding:9px 3px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;">◀ Chat</button>
          <button id="btn-next" style="padding:9px 3px;border-radius:10px;border:1px solid #234735;background:#0e1d16;color:#a7f3d0;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;">Chat ▶</button>
          <button id="btn-hist" style="padding:9px 3px;border-radius:10px;border:1px solid ${mode === 'HISTORY' ? '#34d399' : '#234735'};background:${mode === 'HISTORY' ? '#143826' : '#0e1d16'};color:#ecfdf5;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;">📖 Thread</button>
          <button id="btn-media" style="padding:9px 3px;border-radius:10px;border:1px solid ${mode === 'MEDIA' ? '#34d399' : '#234735'};background:${mode === 'MEDIA' ? '#143826' : '#0e1d16'};color:#a7f3d0;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;">🖼 Media${atts.length ? ` (${atts.length})` : ''}</button>
          <button id="btn-voice" style="padding:9px 3px;border-radius:10px;border:1px solid #2f6f4e;background:#133323;color:#4ade80;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;">🎙 Voice</button>
          <button id="btn-send" style="padding:9px 3px;border-radius:10px;border:1px solid #34d399;background:#10b981;color:#03150d;font-family:inherit;font-size:11px;font-weight:800;cursor:pointer;">Send ↵</button>
        </div>`}

        ${card ? `<div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#6ee7b7;margin-bottom:6px;">
            <span>THREAD: <strong style="color:#ecfdf5;">${esc(card.title)}${formatBadge(card.unreadCount)}</strong> ${win.total ? `(${win.start + 1}-${win.end} of ${win.total})` : ''}</span>
            <div style="display:flex;gap:6px;">
              ${atts.length ? `<button id="btn-open-att" style="padding:3px 9px;border-radius:6px;border:1px solid #34d399;background:#123524;color:#ecfdf5;font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;">Open Media/Link [O]</button>` : ''}
              <button id="btn-msg-up" style="padding:3px 9px;border-radius:6px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:10.5px;cursor:pointer;">▲ Older</button>
              <button id="btn-msg-down" style="padding:3px 9px;border-radius:6px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:10.5px;cursor:pointer;">▼ Newer</button>
            </div>
          </div>
          <div id="thread-box" style="max-height:210px;overflow-y:auto;background:#07100c;padding:8px;border-radius:10px;border:1px solid #193527;">${threadHtml}</div>
        </div>
        <div style="margin-bottom:12px;display:flex;flex-direction:column;gap:6px;">${repliesHtml}</div>` : ''}

        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #162e22;padding-top:10px;">
          <span style="font-size:10.5px;color:#6ee7b7;opacity:0.65;">Tab • ←/→ Chats • ↑/↓ Scroll • M Media • O Open • Space Voice • Enter Send</span>
          <button id="btn-refresh" style="padding:6px 12px;border-radius:8px;border:1px solid #244735;background:#0f1c16;color:#a7f3d0;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;">↻ Sync</button>
        </div>
      </div>
    </div>`

  const mount3d = document.getElementById('g2-3d-mount')
  const viewer = ensureGlasses3D()
  viewer.updateScreen(buildScreenText(), mode === 'RECORDING')
  if (mount3d && viewer.domElement.parentElement !== mount3d) {
    mount3d.appendChild(viewer.domElement)
  }

  const threadBox = document.getElementById('thread-box')
  const activeEl = threadBox?.querySelector('.hud-active-msg') as HTMLElement | null
  if (threadBox && activeEl) threadBox.scrollTop = Math.max(0, activeEl.offsetTop - threadBox.offsetTop - 8)

  document.getElementById('btn-close-lightbox')?.addEventListener('click', () => { lightboxUrl = ''; renderCompanion() })
  document.getElementById('lightbox-overlay')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'lightbox-overlay') { lightboxUrl = ''; renderCompanion() } })
  document.querySelectorAll('.chat-thumb').forEach((el) => el.addEventListener('click', () => { lightboxUrl = (el as HTMLElement).dataset.lightbox || ''; renderCompanion() }))
  document.getElementById('tab-dms')?.addEventListener('click', () => { activeTab = 'DMS'; chatIdx = 0; resetChatCursor(); if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('tab-groups')?.addEventListener('click', () => { activeTab = 'GROUPS'; chatIdx = 0; resetChatCursor(); if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-prev')?.addEventListener('click', () => { if (!list.length) return; chatIdx = (chatIdx - 1 + list.length) % list.length; resetChatCursor(); if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-next')?.addEventListener('click', () => { if (!list.length) return; chatIdx = (chatIdx + 1) % list.length; resetChatCursor(); if (mode !== 'RECORDING') mode = 'FEED'; void render() })
  document.getElementById('btn-hist')?.addEventListener('click', () => { mode = mode === 'HISTORY' ? 'FEED' : 'HISTORY'; void render() })
  document.getElementById('btn-media')?.addEventListener('click', () => { mode = mode === 'MEDIA' ? 'FEED' : 'MEDIA'; mediaIdx = 0; void render() })
  document.getElementById('btn-open-att')?.addEventListener('click', () => { openSelectedAttachment() })
  document.getElementById('btn-msg-up')?.addEventListener('click', () => { scrollHistory(-1) })
  document.getElementById('btn-msg-down')?.addEventListener('click', () => { scrollHistory(1) })
  document.getElementById('btn-voice')?.addEventListener('click', () => { void startVoiceRecording() })
  document.getElementById('btn-voice-send')?.addEventListener('click', () => { void finishVoiceRecording(true) })
  document.getElementById('btn-voice-text')?.addEventListener('click', () => { void finishVoiceRecording(false) })
  document.getElementById('btn-voice-cancel')?.addEventListener('click', () => { void cancelVoiceRecording() })
  document.getElementById('btn-send')?.addEventListener('click', () => { void sendSelectedReply() })
  document.querySelectorAll('.reply-pill').forEach((el) => el.addEventListener('click', () => { replyIdx = Number((el as HTMLElement).dataset.replyIdx || 0); mode = 'REPLY'; void render() }))
  document.getElementById('btn-refresh')?.addEventListener('click', () => { void loadDigest() })
}

function openSelectedAttachment(): void {
  const atts = getChatAttachments(getActiveCard())
  if (!atts.length) return
  if (mediaIdx >= atts.length) mediaIdx = 0
  const item = atts[mediaIdx]
  if (item.type === 'IMAGE') {
    lightboxUrl = item.url
    renderCompanion()
  } else {
    window.open(item.url, '_blank', 'noopener,noreferrer')
  }
}

function scrollHistory(delta: number): void {
  const msgs = getActiveCard()?.messages || []
  if (!msgs.length) return
  const minEnd = Math.min(3, msgs.length)
  msgScrollEnd = Math.max(minEnd, Math.min(msgs.length, (msgScrollEnd || msgs.length) + delta))
  if (mode !== 'RECORDING') mode = 'HISTORY'
  void render()
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
  mode = 'LOADING'; await render()
  try {
    const res = await fetch(`${BACKEND_URL}/api/digest`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to sync')
    cards = data.cards || []
    chatIdx = 0; resetChatCursor(); mode = 'FEED'
  } catch (err: any) { statusNote = err?.message || 'Backend unreachable'; mode = 'ERROR' }
  await render()
}

function stopMediaCapture(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const rec = mediaRecorder
    mediaRecorder = null
    const cleanup = () => { mediaStream?.getTracks().forEach((t) => t.stop()); mediaStream = null }
    if (!rec || rec.state === 'inactive') {
      cleanup()
      resolve(recordedChunks.length ? new Blob(recordedChunks, { type: 'audio/ogg' }) : null)
      return
    }
    rec.onstop = () => {
      const mime = rec.mimeType || 'audio/webm'
      const blob = recordedChunks.length ? new Blob(recordedChunks, { type: mime }) : null
      cleanup()
      resolve(blob)
    }
    try { rec.stop() } catch { cleanup(); resolve(null) }
  })
}

async function startVoiceRecording(): Promise<void> {
  if (!getActiveCard()) return
  pcmChunks = []; recordedChunks = []; speechTranscript = ''; mode = 'RECORDING'
  await render()
  try { await bridge?.audioControl(true, AudioInputSource.Glasses) } catch {}
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream)
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data) }
    mediaRecorder.start(200)
  } catch {}
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
  speechRecognition = null
  await stopMediaCapture()
  pcmChunks = []; recordedChunks = []; mode = 'FEED'
  await render()
}

async function finishVoiceRecording(sendAsAudio = true): Promise<void> {
  try { await bridge?.audioControl(false) } catch {}
  try { speechRecognition?.stop() } catch {}
  speechRecognition = null
  const blob = await stopMediaCapture()
  const card = getActiveCard()
  if (!card) { mode = 'FEED'; await render(); return }

  let audioBase64 = ''
  let mimeType = 'audio/ogg'
  if (pcmChunks.length > 0) {
    audioBase64 = encodeWavBase64(pcmChunks, 16000)
    mimeType = 'audio/wav'
  } else if (blob && blob.size > 0) {
    audioBase64 = await blobToBase64(blob)
    mimeType = blob.type || 'audio/webm'
  }
  pcmChunks = []; recordedChunks = []

  if (sendAsAudio) {
    if (!audioBase64) { statusNote = 'No audio captured — allow microphone in Chrome'; mode = 'ERROR'; await render(); return }
    sendingLabel = 'Sending real voice message...'
    mode = 'SENDING'; await render()
    try {
      const res = await fetch(`${BACKEND_URL}/api/send-voice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: card.id, audioBase64, mimeType }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Voice note send failed')
      mode = 'SENT'; await render()
      await new Promise((r) => setTimeout(r, 1200))
      mode = 'FEED'
    } catch (err: any) { statusNote = err?.message || 'Voice send error'; mode = 'ERROR' }
    await render()
    return
  }

  mode = 'TRANSCRIBING'; await render()
  try {
    const res = await fetch(`${BACKEND_URL}/api/voice-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: card.id, chatTitle: card.title, summary: card.fullDigest || card.summary, audioBase64, transcriptHint: speechTranscript }),
    })
    const data = await res.json()
    if (data?.ok && data?.reply) {
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
  sendingLabel = `"${text.slice(0, 42)}"`
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
  if (e.key === 'Escape') {
    if (lightboxUrl) { e.preventDefault(); lightboxUrl = ''; renderCompanion(); return }
    if (mode === 'RECORDING') { e.preventDefault(); void cancelVoiceRecording(); return }
  }
  if (e.key === 'Tab') { e.preventDefault(); glasses3d?.triggerGesture('SCROLL'); activeTab = activeTab === 'DMS' ? 'GROUPS' : 'DMS'; chatIdx = 0; resetChatCursor(); mode = 'FEED'; void render() }
  else if (e.key === 'ArrowRight' && list.length) { glasses3d?.triggerGesture('SCROLL'); chatIdx = (chatIdx + 1) % list.length; resetChatCursor(); mode = 'FEED'; void render() }
  else if (e.key === 'ArrowLeft' && list.length) { glasses3d?.triggerGesture('SCROLL'); chatIdx = (chatIdx - 1 + list.length) % list.length; resetChatCursor(); mode = 'FEED'; void render() }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (mode === 'REPLY' && active) { const l = active.replies.length || 1; replyIdx = (replyIdx - 1 + l) % l; void render() }
    else if (mode === 'MEDIA') { const a = getChatAttachments(active); if (a.length) { mediaIdx = (mediaIdx - 1 + a.length) % a.length; void render() } }
    else scrollHistory(-1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (mode === 'REPLY' && active) { replyIdx = (replyIdx + 1) % (active.replies.length || 1); void render() }
    else if (mode === 'MEDIA') { const a = getChatAttachments(active); if (a.length) { mediaIdx = (mediaIdx + 1) % a.length; void render() } }
    else scrollHistory(1)
  } else if (e.key.toLowerCase() === 'm') { mode = mode === 'MEDIA' ? 'FEED' : 'MEDIA'; mediaIdx = 0; void render() }
  else if (e.key.toLowerCase() === 'o') { openSelectedAttachment() }
  else if (e.code === 'Space') { e.preventDefault(); glasses3d?.triggerGesture('HOLD'); if (mode === 'RECORDING') void finishVoiceRecording(true); else void startVoiceRecording() }
  else if (e.key === 'Enter') {
    e.preventDefault(); glasses3d?.triggerGesture('TAP');
    if (mode === 'RECORDING') void finishVoiceRecording(true)
    else if (mode === 'MEDIA') openSelectedAttachment()
    else void sendSelectedReply()
  }
})

bridge?.onEvenHubEvent(async (event: EvenHubEvent) => {
  if (event.audioEvent?.audioPcm && mode === 'RECORDING') { pcmChunks.push(event.audioEvent.audioPcm); return }
  const type = event.textEvent?.eventType ?? event.sysEvent?.eventType
  if (mode === 'ERROR') { if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await loadDigest(); return }
  if (mode === 'RECORDING') {
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) await finishVoiceRecording(true)
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) await cancelVoiceRecording()
    return
  }
  const list = getVisibleCards()
  if (mode === 'FEED') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT && list.length) { chatIdx = (chatIdx - 1 + list.length) % list.length; resetChatCursor(); await render() }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT && list.length) { chatIdx = (chatIdx + 1) % list.length; resetChatCursor(); await render() }
    else if ((type === OsEventTypeList.CLICK_EVENT || type === undefined) && list.length) { resetChatCursor(); mode = 'HISTORY'; await render() }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) { if (list.length) await startVoiceRecording(); else await loadDigest() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { await bridge?.shutDownPageContainer(1) }
    return
  }
  if (mode === 'HISTORY') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) { scrollHistory(-1) }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) { scrollHistory(1) }
    else if (type === OsEventTypeList.CLICK_EVENT || type === undefined) { replyIdx = 0; mode = 'REPLY'; await render() }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) { await startVoiceRecording() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { mode = 'FEED'; await render() }
    return
  }
  if (mode === 'MEDIA') {
    const a = getChatAttachments(getActiveCard())
    if (type === OsEventTypeList.SCROLL_TOP_EVENT && a.length) { mediaIdx = (mediaIdx - 1 + a.length) % a.length; await render() }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT && a.length) { mediaIdx = (mediaIdx + 1) % a.length; await render() }
    else if (type === OsEventTypeList.CLICK_EVENT || type === undefined) { openSelectedAttachment() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { mode = 'FEED'; await render() }
    return
  }
  if (mode === 'REPLY') {
    const active = getActiveCard(); const len = active?.replies.length || 1
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) { replyIdx = (replyIdx - 1 + len) % len; await render() }
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) { replyIdx = (replyIdx + 1) % len; await render() }
    else if (type === OsEventTypeList.CLICK_EVENT || type === undefined) { await sendSelectedReply() }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) { await startVoiceRecording() }
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { mode = 'HISTORY'; await render() }
  }
})

void loadDigest()

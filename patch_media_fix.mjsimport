cat << 'EOF' > fix_main.mjs
import fs from 'fs'
let m = fs.readFileSync('src/main.ts', 'utf8')
if (!m.includes('function getHudImage()')) {
  const fn = `function getHudImage(): { url: string; full: boolean } {
  if (pinnedLensUrl) return { url: pinnedLensUrl, full: true }
  if (lightboxUrl) return { url: lightboxUrl, full: true }
  const card = getActiveCard(); if (!card) return { url: '', full: false }
  if (mode === 'MEDIA') { const a = getChatAttachments(card)[mediaIdx]; return a?.type === 'IMAGE' ? { url: a.url, full: true } : { url: '', full: false } }
  const src = mode === 'HISTORY' ? getHistoryWindow(card).slice : (card.messages || [])
  for (let i = src.length - 1; i >= 0; i--) if (src[i]?.hasImage && src[i].id) return { url: \`\${BACKEND_URL}/api/media/\${encodeURIComponent(card.id)}/\${src[i].id}\`, full: false }
  return { url: '', full: false }
}\n\n`
  m = m.replace('function renderCompanion(): void {', fn + 'function renderCompanion(): void {')
  m = m.replace("viewer.updateScreen(buildScreenText(), mode === 'RECORDING')", "const hi = getHudImage(); viewer.updateScreen(buildScreenText(), mode === 'RECORDING', hi.url, hi.full)")
  fs.writeFileSync('src/main.ts', m)
}
EOF
node fix_main.mjs && rm fix_main.mjs && npm run build && evenhub pack app.json dist && mv out.ehpk pulseglance-g2.ehpk && git add . && git commit -m "fix: declare missing HUD image fields in Glasses3DViewer" && git push
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
npx tsx server/index.ts
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type GestureKind = 'TAP' | 'SCROLL' | 'HOLD' | 'BACK'

export interface GlassesCallbacks {
  onTap: () => void
  onScroll: (dir: number) => void
  onHold: () => void
  onBack?: () => void
}

const HUD_THEMES = [
  { name: 'Even Green', css: '#4ade80', glow: '#22c55e', hex: 0x34d399 },
  { name: 'Pure White', css: '#f8fafc', glow: '#cbd5e1', hex: 0xe2e8f0 },
  { name: 'Ice Cyan', css: '#38bdf8', glow: '#0ea5e9', hex: 0x38bdf8 },
  { name: 'Warm Amber', css: '#fbbf24', glow: '#f59e0b', hex: 0xfbbf24 },
]

interface HotspotDef {
  label: string
  hint: string
  localPos: THREE.Vector3
  kind: GestureKind
  run: () => void
}

function pantoShape(sc = 1): THREE.Shape {
  const s = new THREE.Shape()
  const w = 1.18 * sc
  const t = 0.86 * sc
  const b = 0.96 * sc
  s.moveTo(-w * 0.72, t)
  s.bezierCurveTo(-w * 0.2, t * 1.08, w * 0.35, t * 1.06, w * 0.78, t * 0.92)
  s.bezierCurveTo(w * 1.08, t * 0.78, w * 1.06, -b * 0.15, w * 0.84, -b * 0.68)
  s.bezierCurveTo(w * 0.58, -b * 1.05, -w * 0.45, -b * 1.05, -w * 0.78, -b * 0.66)
  s.bezierCurveTo(-w * 1.06, -b * 0.25, -w * 1.05, t * 0.75, -w * 0.72, t)
  return s
}

function lensGeo(): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(pantoShape(0.92), 36)
  g.computeBoundingBox()
  const bb = g.boundingBox!
  const p = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < p.count; i++) {
    uv.setXY(
      i,
      (p.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
      (p.getY(i) - bb.min.y) / (bb.max.y - bb.min.y)
    )
  }
  uv.needsUpdate = true
  return g
}

function wrapPx(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxL: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const c = cur ? `${cur} ${w}` : w
    if (ctx.measureText(c).width <= maxW) {
      cur = c
    } else {
      if (cur) lines.push(cur)
      cur = w
      if (lines.length >= maxL) break
    }
  }
  if (cur && lines.length < maxL) lines.push(cur)
  if (lines.length === maxL && lines.join(' ').length < text.replace(/\s+/g, ' ').trim().length) {
    lines[maxL - 1] = lines[maxL - 1].replace(/\s+\S*$/, '') + '…'
  }
  return lines
}

export class Glasses3DViewer {
  public readonly domElement: HTMLDivElement
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 580 / 345, 0.1, 50)
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  private controls: OrbitControls
  private glassesGroup = new THREE.Group()
  private sensorMat: THREE.MeshStandardMaterial
  private hudMat: THREE.MeshBasicMaterial
  private pulseRing: THREE.Mesh
  private pulseMat: THREE.MeshBasicMaterial
  private lensCanvas = document.createElement('canvas')
  private lensTex: THREE.CanvasTexture
  private badgeEl = document.createElement('div')
  private viewBtn = document.createElement('button')
  private colorBtn = document.createElement('button')
  private pinsBtn = document.createElement('button')
  private hotspotLayer = document.createElement('div')
  private hotspotEls: { def: HotspotDef; el: HTMLButtonElement }[] = []
  private showPins = true
  private viewIdx = 0
  private themeIdx = 0
  private cameraAnimating = false
  private desiredCamPos = new THREE.Vector3(0, 0.16, -4.65)
  private desiredTarget = new THREE.Vector3(0, 0.02, 0.1)
  private flashUntil = 0
  private isRecording = false
  private hoveringTemple = false
  private lastText = ''
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private templeTargets: THREE.Object3D[] = []
  private holdTimer: number | null = null
  private holdFired = false
  private camDir = new THREE.Vector3()
  private projVec = new THREE.Vector3()

  constructor(cb: GlassesCallbacks) {
    this.domElement = document.createElement('div')
    this.domElement.style.cssText =
      'position:relative;width:100%;height:345px;border-radius:16px;overflow:hidden;border:1px solid #1d4230;background:radial-gradient(circle at 22% 28%,rgba(16,65,48,0.34) 0%,transparent 48%),radial-gradient(circle at 78% 68%,rgba(15,45,62,0.32) 0%,transparent 52%),radial-gradient(circle at 50% 45%,#08140f 0%,#020504 88%);cursor:grab;user-select:none;'

    this.camera.position.copy(this.desiredCamPos)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(580, 345)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.25
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;'
    this.domElement.appendChild(this.renderer.domElement)

    new ResizeObserver(() => {
      const w = this.domElement.clientWidth || 580
      const h = this.domElement.clientHeight || 345
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h, false)
    }).observe(this.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.075
    this.controls.enablePan = false
    this.controls.enableZoom = true
    this.controls.zoomSpeed = 0.85
    this.controls.minDistance = 1.2
    this.controls.maxDistance = 8.5
    this.controls.target.copy(this.desiredTarget)
    this.controls.addEventListener('start', () => {
      this.cameraAnimating = false
    })

    this.scene.add(new THREE.AmbientLight(0xdbeafe, 0.85))
    const k1 = new THREE.DirectionalLight(0xffffff, 2.1)
    k1.position.set(3, 4, 5)
    this.scene.add(k1)
    const k2 = new THREE.DirectionalLight(0xcffafe, 1.35)
    k2.position.set(-2.5, 2.5, -5)
    this.scene.add(k2)
    const k3 = new THREE.DirectionalLight(0x34d399, 1.1)
    k3.position.set(4, -1, -3)
    this.scene.add(k3)

    this.lensCanvas.width = 1024
    this.lensCanvas.height = 512
    this.lensTex = new THREE.CanvasTexture(this.lensCanvas)
    this.lensTex.colorSpace = THREE.SRGBColorSpace
    this.lensTex.anisotropy = 4

    this.sensorMat = new THREE.MeshStandardMaterial({
      color: 0x3b4842,
      metalness: 0.78,
      roughness: 0.22,
      emissive: HUD_THEMES[0].hex,
      emissiveIntensity: 0.3,
    })
    this.hudMat = new THREE.MeshBasicMaterial({
      map: this.lensTex,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    })
    this.pulseMat = new THREE.MeshBasicMaterial({
      color: HUD_THEMES[0].hex,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    this.pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.14, 24), this.pulseMat)
    this.pulseRing.rotation.y = Math.PI / 2

    this.buildFrame()
    this.glassesGroup.add(this.pulseRing)
    this.scene.add(this.glassesGroup)

    this.hotspotLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;'
    this.badgeEl.style.cssText =
      'position:absolute;top:10px;left:12px;padding:4px 10px;border-radius:999px;background:rgba(4,12,9,0.78);border:1px solid #24573e;color:#6ee7b7;font-size:10px;font-weight:700;pointer-events:none;'
    this.badgeEl.textContent = 'WEARER POV • WAVEGUIDE ACTIVE'

    const topR = document.createElement('div')
    topR.style.cssText = 'position:absolute;top:9px;right:10px;display:flex;gap:5px;z-index:5;'
    const bCss =
      'padding:4px 8px;border-radius:8px;border:1px solid #285640;background:rgba(8,22,16,0.85);color:#ecfdf5;font-family:inherit;font-size:10px;font-weight:700;cursor:pointer;'

    this.colorBtn.style.cssText = bCss
    this.colorBtn.textContent = '🎨 Green [C]'
    this.colorBtn.onclick = (e) => {
      e.stopPropagation()
      this.cycleTheme()
    }

    this.pinsBtn.style.cssText = bCss
    this.pinsBtn.textContent = '🎯 Controls'
    this.pinsBtn.onclick = (e) => {
      e.stopPropagation()
      this.showPins = !this.showPins
      this.pinsBtn.style.opacity = this.showPins ? '1' : '0.5'
      this.hotspotLayer.style.display = this.showPins ? 'block' : 'none'
    }

    this.viewBtn.style.cssText = bCss
    this.viewBtn.textContent = '🔍 Close-Up [V]'
    this.viewBtn.onclick = (e) => {
      e.stopPropagation()
      this.toggleView()
    }

    topR.append(this.colorBtn, this.pinsBtn, this.viewBtn)

    const hint = document.createElement('div')
    hint.style.cssText =
      'position:absolute;bottom:8px;left:12px;right:12px;display:flex;justify-content:space-between;font-size:9.5px;color:#94a3b8;opacity:0.8;pointer-events:none;'
    hint.innerHTML =
      '<span>Click temple switches • Drag to orbit front/back • Wheel: Zoom</span><span>Optical Micro-LED Waveguide</span>'

    this.domElement.append(this.hotspotLayer, this.badgeEl, topR, hint)

    this.createHotspots(cb)
    this.bindInputs(cb)
    this.updateScreen('PULSEGLANCE G2 // READY\nConnecting to Telegram…', false)
    this.animate()
  }

  private buildFrame(): void {
    const fMat = new THREE.MeshStandardMaterial({ color: 0x222726, metalness: 0.38, roughness: 0.44 })
    const pMat = new THREE.MeshStandardMaterial({ color: 0x181d1c, metalness: 0.25, roughness: 0.52 })
    const gMat = new THREE.MeshPhysicalMaterial({
      color: 0x0c1b18,
      transparent: true,
      opacity: 0.26,
      roughness: 0.06,
      metalness: 0.08,
      side: THREE.DoubleSide,
    })

    const outer = pantoShape(1)
    outer.holes.push(pantoShape(0.91))
    const rimGeo = new THREE.ExtrudeGeometry(outer, {
      depth: 0.13,
      bevelEnabled: true,
      bevelThickness: 0.024,
      bevelSize: 0.022,
      bevelSegments: 4,
    })
    rimGeo.center()
    const lGeo = lensGeo()

    for (const side of [-1, 1]) {
      const x = side * 1.38
      const rim = new THREE.Mesh(rimGeo, fMat)
      rim.position.set(x, 0, 0)
      this.glassesGroup.add(rim)

      const glass = new THREE.Mesh(lGeo, gMat)
      glass.position.set(x, 0, 0)
      this.glassesGroup.add(glass)

      const hud = new THREE.Mesh(lGeo, this.hudMat)
      hud.position.set(x, 0, -0.016)
      hud.rotation.y = Math.PI
      this.glassesGroup.add(hud)

      const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.17, 0.2), this.sensorMat)
      hinge.position.set(side * 2.58, 0.34, -0.05)
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.055, 1.5), this.sensorMat)
      bar.position.set(side * 2.75, 0.31, -0.95)
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 2.7), fMat)
      arm.position.set(side * 2.7, 0.3, -1.42)
      const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.95, 8, 16), pMat)
      pod.rotation.x = Math.PI / 2 + 0.18
      pod.position.set(side * 2.72, 0.12, -2.85)

      this.glassesGroup.add(hinge, bar, arm, pod)
      this.templeTargets.push(hinge, bar, arm, pod)
    }

    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.16, 0.15), fMat)
    bridge.position.set(0, 0.36, 0.01)
    this.glassesGroup.add(bridge)
  }

  private createHotspots(cb: GlassesCallbacks): void {
    const defs: HotspotDef[] = [
      {
        label: '▲ Prev',
        hint: 'Right Temple Swipe Back: previous chat or older message',
        localPos: new THREE.Vector3(-2.72, 0.56, -0.35),
        kind: 'SCROLL',
        run: () => cb.onScroll(-1),
      },
      {
        label: '⚡ Tap',
        hint: 'Right Temple Tap: open thread, replies, or send',
        localPos: new THREE.Vector3(-2.72, 0.28, -0.82),
        kind: 'TAP',
        run: () => cb.onTap(),
      },
      {
        label: '▼ Next',
        hint: 'Right Temple Swipe Forward: next chat or newer message',
        localPos: new THREE.Vector3(-2.72, -0.02, -1.25),
        kind: 'SCROLL',
        run: () => cb.onScroll(1),
      },
      {
        label: '↩ Back',
        hint: 'Left Temple Double Tap: go back or cancel',
        localPos: new THREE.Vector3(2.72, 0.48, -0.45),
        kind: 'BACK',
        run: () => cb.onBack?.(),
      },
      {
        label: '🎙 Voice',
        hint: 'Left Temple Hold: record & send Telegram voice note',
        localPos: new THREE.Vector3(2.72, 0.06, -1.05),
        kind: 'HOLD',
        run: () => cb.onHold(),
      },
    ]

    for (const def of defs) {
      const btn = document.createElement('button')
      btn.title = def.hint
      btn.textContent = def.label
      btn.style.cssText =
        'position:absolute;transform:translate(-50%,-50%);pointer-events:auto;padding:4px 9px;border-radius:999px;border:1px solid rgba(74,222,128,0.55);background:rgba(5,16,12,0.84);color:#ecfdf5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;font-size:10.5px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.45);'
      btn.onpointerenter = () => {
        this.badgeEl.textContent = def.hint.toUpperCase().slice(0, 56)
      }
      btn.onclick = (e) => {
        e.stopPropagation()
        this.pulseAt(def.localPos)
        this.triggerGesture(def.kind)
        def.run()
      }
      this.hotspotLayer.appendChild(btn)
      this.hotspotEls.push({ def, el: btn })
    }
  }

  private pulseAt(pos: THREE.Vector3): void {
    this.pulseRing.position.set(pos.x < 0 ? -2.79 : 2.79, pos.y, pos.z)
    this.pulseRing.scale.setScalar(0.6)
    this.pulseMat.opacity = 0.95
  }

  private hitTemple(e: PointerEvent | WheelEvent): boolean {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObjects(this.templeTargets, false).length > 0
  }

  private bindInputs(cb: GlassesCallbacks): void {
    const el = this.renderer.domElement
    el.addEventListener('pointermove', (e) => {
      const o = this.hitTemple(e)
      if (o !== this.hoveringTemple) {
        this.hoveringTemple = o
        el.style.cursor = o ? 'pointer' : 'grab'
      }
    })
    el.addEventListener('pointerdown', (e) => {
      if (!this.hitTemple(e)) return
      this.holdFired = false
      this.holdTimer = window.setTimeout(() => {
        this.holdFired = true
        this.pulseAt(new THREE.Vector3(2.72, 0.25, -0.95))
        this.triggerGesture('HOLD')
        cb.onHold()
      }, 450)
    })
    el.addEventListener('pointerup', (e) => {
      if (this.holdTimer !== null) {
        clearTimeout(this.holdTimer)
        this.holdTimer = null
      }
      if (!this.holdFired && this.hitTemple(e)) {
        this.pulseAt(new THREE.Vector3(-2.72, 0.31, -0.82))
        this.triggerGesture('TAP')
        cb.onTap()
      }
    })
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.hitTemple(e) || Math.abs(e.deltaY) < 4) return
        e.preventDefault()
        e.stopImmediatePropagation()
        this.pulseAt(new THREE.Vector3(-2.72, 0.31, -0.82))
        this.triggerGesture('SCROLL')
        cb.onScroll(e.deltaY > 0 ? 1 : -1)
      },
      { passive: false, capture: true }
    )
  }

  public cycleTheme(): void {
    this.themeIdx = (this.themeIdx + 1) % HUD_THEMES.length
    const t = HUD_THEMES[this.themeIdx]
    this.colorBtn.textContent = `🎨 ${t.name.split(' ')[1] || t.name} [C]`
    this.colorBtn.style.borderColor = t.css
    this.pulseMat.color.setHex(t.hex)
    for (const h of this.hotspotEls) h.el.style.borderColor = t.css
    const prev = this.lastText
    this.lastText = ''
    this.updateScreen(prev, this.isRecording)
  }

  public toggleView(): void {
    this.viewIdx = (this.viewIdx + 1) % 3
    if (this.viewIdx === 0) {
      this.viewBtn.textContent = '🔍 Close-Up [V]'
      this.desiredTarget.set(0, 0.02, 0.1)
      this.desiredCamPos.set(0, 0.16, -4.65)
    } else if (this.viewIdx === 1) {
      this.viewBtn.textContent = '🕶 3D Front [V]'
      this.desiredTarget.set(-1.38, 0.02, 0.15)
      this.desiredCamPos.set(-1.38, 0.04, -2.25)
    } else {
      this.viewBtn.textContent = '👁 Wearer POV [V]'
      this.desiredTarget.set(0, 0, -0.5)
      this.desiredCamPos.set(2.05, 0.52, 5.1)
    }
    this.cameraAnimating = true
  }

  public triggerGesture(kind: GestureKind): void {
    this.flashUntil = performance.now() + 550
    const map: Record<GestureKind, string> = {
      TAP: '⚡ TEMPLE TAP • OPEN / SEND',
      SCROLL: '↕ TEMPLE SWIPE • NAVIGATE',
      HOLD: '🎙 TEMPLE HOLD • VOICE NOTE',
      BACK: '↩ DOUBLE TAP • BACK',
    }
    this.badgeEl.textContent = map[kind]
    this.badgeEl.style.borderColor = kind === 'HOLD' ? '#f87171' : HUD_THEMES[this.themeIdx].css
    this.badgeEl.style.color = kind === 'HOLD' ? '#fca5a5' : '#ecfdf5'
  }

  public updateScreen(text: string, recording: boolean): void {
    if (text === this.lastText && recording === this.isRecording) return
    this.lastText = text
    this.isRecording = recording
    const ctx = this.lensCanvas.getContext('2d')
    if (!ctx) return

    const W = 1024
    const H = 512
    const theme = HUD_THEMES[this.themeIdx]
    const fg = recording ? '#fca5a5' : theme.css
    const glow = recording ? '#ef4444' : theme.glow
    const ff = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",sans-serif'

    ctx.clearRect(0, 0, W, H)

    const rad = ctx.createRadialGradient(W * 0.5, H * 0.48, 30, W * 0.5, H * 0.48, 420)
    rad.addColorStop(0, recording ? 'rgba(239,68,68,0.11)' : 'rgba(74,222,128,0.06)')
    rad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = rad
    ctx.fillRect(0, 0, W, H)

    const raw = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const header = raw[0] || 'PULSEGLANCE G2'
    const footer = raw.length > 1 && raw[raw.length - 1].startsWith('[') ? raw[raw.length - 1] : ''
    const bodyRaw = raw.slice(1, footer ? -1 : undefined)
    const sx = 115
    const sw = W - sx * 2

    ctx.textBaseline = 'top'
    ctx.shadowColor = glow
    ctx.shadowBlur = 14
    ctx.fillStyle = fg
    ctx.beginPath()
    ctx.arc(sx + 8, 96, 6, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = `600 24px ${ff}`
    ctx.globalAlpha = 0.88
    ctx.fillText(header.slice(0, 44), sx + 26, 82)

    const lg = ctx.createLinearGradient(sx, 0, sx + sw, 0)
    lg.addColorStop(0, fg)
    lg.addColorStop(0.85, fg)
    lg.addColorStop(1, 'transparent')
    ctx.strokeStyle = lg
    ctx.globalAlpha = 0.28
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(sx, 124)
    ctx.lineTo(sx + sw, 124)
    ctx.stroke()

    ctx.globalAlpha = 0.98
    ctx.font = `500 31px ${ff}`
    ctx.shadowBlur = 16
    const lines: string[] = []
    for (const p of bodyRaw) {
      for (const l of wrapPx(ctx, p, sw, 3)) {
        if (lines.length < 5) lines.push(l)
      }
    }
    lines.forEach((l, i) => ctx.fillText(l, sx, 146 + i * 44))

    if (footer) {
      ctx.globalAlpha = 0.56
      ctx.font = `500 20px ${ff}`
      ctx.shadowBlur = 8
      ctx.fillText(footer.replace(/\[/g, '').replace(/\]/g, ' ·').slice(0, 56), sx, 412)
    }

    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
    this.lensTex.needsUpdate = true
  }

  private updateHotspots(): void {
    if (!this.showPins) return
    const w = this.domElement.clientWidth || 580
    const h = this.domElement.clientHeight || 345
    for (const { def, el } of this.hotspotEls) {
      this.projVec.copy(def.localPos)
      this.glassesGroup.localToWorld(this.projVec)
      this.projVec.project(this.camera)
      if (this.projVec.z > 1) {
        el.style.opacity = '0'
        el.style.pointerEvents = 'none'
        continue
      }
      el.style.left = `${Math.max(46, Math.min(w - 46, (this.projVec.x * 0.5 + 0.5) * w))}px`
      el.style.top = `${Math.max(48, Math.min(h - 36, (-this.projVec.y * 0.5 + 0.5) * h))}px`
      el.style.opacity = '1'
      el.style.pointerEvents = 'auto'
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate)
    const now = performance.now()
    const flashing = now < this.flashUntil
    const theme = HUD_THEMES[this.themeIdx]

    if (this.cameraAnimating) {
      this.camera.position.lerp(this.desiredCamPos, 0.1)
      this.controls.target.lerp(this.desiredTarget, 0.1)
      if (this.camera.position.distanceTo(this.desiredCamPos) < 0.015) {
        this.camera.position.copy(this.desiredCamPos)
        this.controls.target.copy(this.desiredTarget)
        this.cameraAnimating = false
      }
    }

    this.camera.getWorldDirection(this.camDir)
    const alpha = THREE.MathUtils.smoothstep(this.camDir.z, 0.08, 0.52)
    this.hudMat.opacity = alpha * 0.98

    if (this.pulseMat.opacity > 0.01) {
      this.pulseRing.scale.multiplyScalar(1.06)
      this.pulseMat.opacity *= 0.9
    } else {
      this.pulseMat.opacity = 0
    }

    this.sensorMat.emissive.setHex(this.isRecording ? 0xef4444 : theme.hex)
    this.sensorMat.emissiveIntensity = this.isRecording
      ? 1.2 + Math.sin(now * 0.012) * 0.5
      : flashing
      ? 1.7
      : this.hoveringTemple
      ? 0.8
      : 0.25

    if (!flashing && !this.isRecording) {
      this.badgeEl.textContent =
        alpha > 0.35
          ? `WEARER POV • ${theme.name.toUpperCase()} WAVEGUIDE`
          : 'FRONT VIEW • ZERO LIGHT LEAK (ORBIT BEHIND)'
      this.badgeEl.style.color = alpha > 0.35 ? theme.css : '#94a3b8'
    }

    this.glassesGroup.position.y =
      this.viewIdx === 2 && !this.cameraAnimating ? Math.sin(now * 0.0016) * 0.03 : 0

    this.controls.update()
    this.updateHotspots()
    this.renderer.render(this.scene, this.camera)
  }
}
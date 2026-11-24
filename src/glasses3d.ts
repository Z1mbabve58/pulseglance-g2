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
  anchor: THREE.Object3D
  localPos: THREE.Vector3
  kind: GestureKind
  run: () => void
}

function crownPantoShape(sc = 1): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(-0.62 * sc, 0.85 * sc)
  s.bezierCurveTo(-0.22 * sc, 0.90 * sc, 0.22 * sc, 0.90 * sc, 0.62 * sc, 0.85 * sc)
  s.bezierCurveTo(0.95 * sc, 0.80 * sc, 1.12 * sc, 0.56 * sc, 1.10 * sc, 0.14 * sc)
  s.bezierCurveTo(1.07 * sc, -0.52 * sc, 0.68 * sc, -0.96 * sc, 0.0, -0.97 * sc)
  s.bezierCurveTo(-0.68 * sc, -0.96 * sc, -1.07 * sc, -0.52 * sc, -1.10 * sc, 0.14 * sc)
  s.bezierCurveTo(-1.12 * sc, 0.56 * sc, -0.95 * sc, 0.80 * sc, -0.62 * sc, 0.85 * sc)
  return s
}

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const hw = w / 2
  const hh = h / 2
  s.moveTo(-hw + r, -hh)
  s.lineTo(hw - r, -hh)
  s.quadraticCurveTo(hw, -hh, hw, -hh + r)
  s.lineTo(hw, hh - r)
  s.quadraticCurveTo(hw, hh, hw - r, hh)
  s.lineTo(-hw + r, hh)
  s.quadraticCurveTo(-hw, hh, -hw, hh - r)
  s.lineTo(-hw, -hh + r)
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh)
  return s
}

function lensGeo(): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(crownPantoShape(0.89), 40)
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

function createTempleLabelTex(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, 512, 64)
  ctx.fillStyle = 'rgba(215, 224, 220, 0.42)'
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 24, 34)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
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
  private camera = new THREE.PerspectiveCamera(36, 580 / 350, 0.1, 60)
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  private controls: OrbitControls
  private glassesGroup = new THREE.Group()
  private leftPivot = new THREE.Group()
  private rightPivot = new THREE.Group()
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
  private foldProgress = 1
  private targetFold = 1
  private hasAutoUnfolded = false
  private foldBtn = document.createElement("button")
  private cameraAnimating = false
  private desiredCamPos = new THREE.Vector3(0, 0.04, 6.25)
  private desiredTarget = new THREE.Vector3(0, -0.04, -0.1)
  private zoomKeyDir = 0
  private flashUntil = 0
  private isRecording = false
  private hoveringTemple = false
  private lastText = ''
  private lastImageUrl = ''
  private lastFullImage = false
  private imgCache = new Map<string, HTMLImageElement>()
  private imgLoading = new Set<string>()
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private templeTargets: THREE.Object3D[] = []
  private holdTimer: number | null = null
  private holdFired = false
  private camDir = new THREE.Vector3()
  private projVec = new THREE.Vector3()
  private zoomOffset = new THREE.Vector3()

  constructor(cb: GlassesCallbacks) {
    this.domElement = document.createElement('div')
    this.domElement.style.cssText =
      'position:relative;width:100%;height:350px;border-radius:16px;overflow:hidden;border:1px solid #1d4230;background:radial-gradient(circle at 22% 25%,rgba(18,70,52,0.34) 0%,transparent 50%),radial-gradient(circle at 78% 72%,rgba(16,46,64,0.30) 0%,transparent 52%),radial-gradient(circle at 50% 45%,#0b1713 0%,#030605 88%);cursor:grab;user-select:none;'

    this.camera.position.copy(this.desiredCamPos)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(580, 350)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.28
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;'
    this.domElement.appendChild(this.renderer.domElement)

    new ResizeObserver(() => {
      const w = this.domElement.clientWidth || 580
      const h = this.domElement.clientHeight || 350
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
    this.controls.minDistance = 1.15
    this.controls.maxDistance = 9.0
    this.controls.target.copy(this.desiredTarget)

    // Unfold temples smoothly the moment the user starts rotating the 3D glasses
    this.controls.addEventListener('start', () => {
      this.cameraAnimating = false
      if (!this.hasAutoUnfolded && this.targetFold > 0.5) {
        this.hasAutoUnfolded = true
        this.targetFold = 0
      }
    })

    this.scene.add(new THREE.AmbientLight(0xe2e8f0, 1.05))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(2.5, 4.5, 6)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xcffafe, 1.4)
    fill.position.set(-3, 2, -5.5)
    this.scene.add(fill)
    const rim = new THREE.DirectionalLight(0x34d399, 0.95)
    rim.position.set(4, -2, -3)
    this.scene.add(rim)

    this.lensCanvas.width = 1024
    this.lensCanvas.height = 512
    this.lensTex = new THREE.CanvasTexture(this.lensCanvas)
    this.lensTex.colorSpace = THREE.SRGBColorSpace
    this.lensTex.anisotropy = 4

    this.sensorMat = new THREE.MeshStandardMaterial({
      color: 0x6b7270,
      metalness: 0.55,
      roughness: 0.34,
      emissive: HUD_THEMES[0].hex,
      emissiveIntensity: 0.14,
    })
    this.hudMat = new THREE.MeshBasicMaterial({
      map: this.lensTex,
      transparent: true,
      opacity: 0,
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
      'position:absolute;top:10px;left:12px;padding:4px 10px;border-radius:999px;background:rgba(4,12,9,0.8);border:1px solid #24573e;color:#94a3b8;font-size:10px;font-weight:700;pointer-events:none;'
    this.badgeEl.textContent = 'EVEN G2 FOLDED • DRAG TO UNFOLD & ORBIT'

    const topR = document.createElement('div')
    topR.style.cssText = 'position:absolute;top:9px;right:10px;display:flex;gap:4px;z-index:5;'
    const bCss =
      'padding:4px 7px;border-radius:8px;border:1px solid #285640;background:rgba(8,22,16,0.86);color:#ecfdf5;font-family:inherit;font-size:10px;font-weight:700;cursor:pointer;'

    const zInBtn = document.createElement('button')
    zInBtn.style.cssText = bCss
    zInBtn.title = 'Zoom In (+)'
    zInBtn.textContent = '＋'
    zInBtn.onclick = (e) => {
      e.stopPropagation()
      this.zoomBy(-0.75)
    }

    const zOutBtn = document.createElement('button')
    zOutBtn.style.cssText = bCss
    zOutBtn.title = 'Zoom Out (-)'
    zOutBtn.textContent = '－'
    zOutBtn.onclick = (e) => {
      e.stopPropagation()
      this.zoomBy(0.75)
    }

    this.colorBtn.style.cssText = bCss
    this.colorBtn.textContent = '🎨 Green [C]'
    this.colorBtn.onclick = (e) => {
      e.stopPropagation()
      this.cycleTheme()
    }

    this.pinsBtn.style.cssText = bCss
    this.pinsBtn.textContent = '🎯'
    this.pinsBtn.title = 'Toggle Temple Controls'
    this.pinsBtn.onclick = (e) => {
      e.stopPropagation()
      this.showPins = !this.showPins
      this.pinsBtn.style.opacity = this.showPins ? '1' : '0.45'
      this.hotspotLayer.style.display = this.showPins ? 'block' : 'none'
    }

    this.viewBtn.style.cssText = bCss
    this.viewBtn.textContent = '👁 Wearer POV [V]'
    this.viewBtn.onclick = (e) => {
      e.stopPropagation()
      this.toggleView()
    }

    this.foldBtn.style.cssText = bCss
    this.foldBtn.textContent = "📂 Open [F]"
    this.foldBtn.onclick = (e) => { e.stopPropagation(); this.hasAutoUnfolded = true; this.targetFold = this.targetFold > 0.5 ? 0 : 1 }
    topR.append(this.foldBtn, zInBtn, zOutBtn, this.colorBtn, this.pinsBtn, this.viewBtn)

    const hint = document.createElement('div')
    hint.style.cssText =
      'position:absolute;bottom:8px;left:12px;right:12px;display:flex;justify-content:space-between;font-size:9.5px;color:#94a3b8;opacity:0.8;pointer-events:none;'
    hint.innerHTML =
      '<span>Drag: Unfold & Orbit • +/- Keys: Zoom • V: POV • F: Fold</span><span>Even G2 Optical Waveguide</span>'

    this.domElement.append(this.hotspotLayer, this.badgeEl, topR, hint)

    this.createHotspots(cb)
    this.bindInputs(cb)
    this.updateScreen('PULSEGLANCE G2 // READY\nConnecting to Telegram…', false)
    this.animate()
  }

  private buildTempleMesh(side: -1 | 1, frameMat: THREE.Material, podMat: THREE.Material): THREE.Group {
    const pivot = new THREE.Group()
    pivot.position.set(side * 2.54, 0.34, -0.09)

    // Sculpted side-profile temple arm (straight front + smooth downward bend behind ear)
    const armShape = new THREE.Shape()
    armShape.moveTo(0, 0.115)
    armShape.lineTo(2.15, 0.115)
    armShape.quadraticCurveTo(2.68, 0.11, 3.12, -0.10)
    armShape.lineTo(3.72, -0.38)
    armShape.lineTo(3.64, -0.54)
    armShape.lineTo(3.02, -0.25)
    armShape.quadraticCurveTo(2.60, -0.07, 2.12, -0.075)
    armShape.lineTo(0, -0.075)
    armShape.closePath()

    const armGeo = new THREE.ExtrudeGeometry(armShape, {
      depth: 0.085,
      bevelEnabled: true,
      bevelThickness: 0.014,
      bevelSize: 0.012,
      bevelSegments: 3,
    })
    armGeo.translate(0, 0, -0.0425)
    const armMesh = new THREE.Mesh(armGeo, frameMat)
    armMesh.rotation.y = Math.PI / 2
    pivot.add(armMesh)
    this.templeTargets.push(armMesh)

    // Subtle touch sensor strip along outer temple
    const touchStrip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.055, 1.35), this.sensorMat)
    touchStrip.position.set(side * 0.058, 0.02, -0.92)
    pivot.add(touchStrip)
    this.templeTargets.push(touchStrip)

    // Inner temple inscription visible through lenses when folded
    const labelTex = createTempleLabelTex(side === -1 ? 'Even G2   Mod.01' : 'Designed by Even Realities')
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTex,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const labelPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.18), labelMat)
    labelPlane.position.set(-side * 0.06, 0.02, -1.15)
    labelPlane.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2
    pivot.add(labelPlane)

    // Signature Even G2 flat rounded battery/audio pod at temple tip
    const podShape = roundedRectShape(1.56, 0.44, 0.18)
    const podGeo = new THREE.ExtrudeGeometry(podShape, {
      depth: 0.125,
      bevelEnabled: true,
      bevelThickness: 0.032,
      bevelSize: 0.028,
      bevelSegments: 4,
    })
    podGeo.translate(0, 0, -0.0625)
    const podHolder = new THREE.Group()
    podHolder.position.set(0, -0.60, -4.18)
    podHolder.rotation.y = Math.PI / 2
    const podMesh = new THREE.Mesh(podGeo, podMat)
    podMesh.rotation.z = -0.39
    podHolder.add(podMesh)
    pivot.add(podHolder)
    this.templeTargets.push(podMesh)

    return pivot
  }

  private buildFrame(): void {
    const fMat = new THREE.MeshStandardMaterial({ color: 0x2c3130, metalness: 0.28, roughness: 0.48 })
    const pMat = new THREE.MeshStandardMaterial({ color: 0x232726, metalness: 0.22, roughness: 0.56 })
    const padMat = new THREE.MeshPhysicalMaterial({
      color: 0xd1d5db,
      transparent: true,
      opacity: 0.45,
      roughness: 0.15,
    })
    const gMat = new THREE.MeshPhysicalMaterial({
      color: 0x10221c,
      transparent: true,
      opacity: 0.22,
      roughness: 0.05,
      metalness: 0.08,
      side: THREE.DoubleSide,
    })

    const outer = crownPantoShape(1.0)
    outer.holes.push(crownPantoShape(0.875))
    const rimGeo = new THREE.ExtrudeGeometry(outer, {
      depth: 0.12,
      bevelEnabled: true,
      bevelThickness: 0.026,
      bevelSize: 0.024,
      bevelSegments: 4,
    })
    rimGeo.center()
    const lGeo = lensGeo()

    // Sleek sculpted keyhole bridge
    const bridgeShape = new THREE.Shape()
    bridgeShape.moveTo(-0.42, 0.46)
    bridgeShape.quadraticCurveTo(0, 0.52, 0.42, 0.46)
    bridgeShape.lineTo(0.42, 0.26)
    bridgeShape.quadraticCurveTo(0, 0.34, -0.42, 0.26)
    bridgeShape.closePath()
    const bridgeGeo = new THREE.ExtrudeGeometry(bridgeShape, {
      depth: 0.11,
      bevelEnabled: true,
      bevelThickness: 0.022,
      bevelSize: 0.02,
      bevelSegments: 3,
    })
    bridgeGeo.translate(0, 0, -0.055)
    this.glassesGroup.add(new THREE.Mesh(bridgeGeo, fMat))

    // Endpiece lugs + flush metallic grey hinge inlays
    const lugGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.48, 0.28, 0.08), {
      depth: 0.12,
      bevelEnabled: true,
      bevelThickness: 0.022,
      bevelSize: 0.018,
      bevelSegments: 3,
    })
    lugGeo.translate(0, 0, -0.06)

    const inlayGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.29, 0.155, 0.035), {
      depth: 0.02,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.006,
      bevelSegments: 2,
    })

    for (const side of [-1, 1] as const) {
      const x = side * 1.38
      const rim = new THREE.Mesh(rimGeo, fMat)
      rim.position.set(x, 0, 0)
      this.glassesGroup.add(rim)

      const glass = new THREE.Mesh(lGeo, gMat)
      glass.position.set(x, 0, 0)
      this.glassesGroup.add(glass)

      const hud = new THREE.Mesh(lGeo, this.hudMat)
      hud.position.set(x, 0, -0.018)
      hud.rotation.y = Math.PI
      this.glassesGroup.add(hud)

      // Translucent nose pad nub peeking inside lower inner rim
      const nosePad = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.13, 6, 10), padMat)
      nosePad.position.set(side * 0.42, -0.16, -0.06)
      nosePad.rotation.z = side * 0.35
      this.glassesGroup.add(nosePad)

      // Outer lug & front metallic grey rectangular hinge accent
      const lug = new THREE.Mesh(lugGeo, fMat)
      lug.position.set(side * 2.52, 0.34, 0)
      this.glassesGroup.add(lug)
      this.templeTargets.push(lug)

      const inlay = new THREE.Mesh(inlayGeo, this.sensorMat)
      inlay.position.set(side * 2.56, 0.34, 0.068)
      this.glassesGroup.add(inlay)
      this.templeTargets.push(inlay)
    }

    this.leftPivot = this.buildTempleMesh(-1, fMat, pMat)
    this.rightPivot = this.buildTempleMesh(1, fMat, pMat)
    this.glassesGroup.add(this.leftPivot, this.rightPivot)
  }

  private createHotspots(cb: GlassesCallbacks): void {
    const defs: HotspotDef[] = [
      {
        label: '▲ Prev',
        hint: 'Right Temple Swipe Back: previous chat or older message',
        anchor: this.leftPivot,
        localPos: new THREE.Vector3(-0.18, 0.24, -0.45),
        kind: 'SCROLL',
        run: () => cb.onScroll(-1),
      },
      {
        label: '⚡ Tap',
        hint: 'Right Temple Tap: open thread, replies, or send',
        anchor: this.leftPivot,
        localPos: new THREE.Vector3(-0.18, 0.02, -0.95),
        kind: 'TAP',
        run: () => cb.onTap(),
      },
      {
        label: '▼ Next',
        hint: 'Right Temple Swipe Forward: next chat or newer message',
        anchor: this.leftPivot,
        localPos: new THREE.Vector3(-0.18, -0.22, -1.45),
        kind: 'SCROLL',
        run: () => cb.onScroll(1),
      },
      {
        label: '↩ Back',
        hint: 'Left Temple Double Tap: go back or cancel',
        anchor: this.rightPivot,
        localPos: new THREE.Vector3(0.18, 0.22, -0.55),
        kind: 'BACK',
        run: () => cb.onBack?.(),
      },
      {
        label: '🎙 Voice',
        hint: 'Left Temple Hold: record & send Telegram voice note',
        anchor: this.rightPivot,
        localPos: new THREE.Vector3(0.18, -0.14, -1.15),
        kind: 'HOLD',
        run: () => cb.onHold(),
      },
    ]

    for (const def of defs) {
      const btn = document.createElement('button')
      btn.title = def.hint
      btn.textContent = def.label
      btn.style.cssText =
        'position:absolute;transform:translate(-50%,-50%);pointer-events:auto;padding:4px 9px;border-radius:999px;border:1px solid rgba(74,222,128,0.55);background:rgba(5,16,12,0.84);color:#ecfdf5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;font-size:10.5px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.45);transition:opacity 0.2s;'
      btn.onpointerenter = () => {
        this.badgeEl.textContent = def.hint.toUpperCase().slice(0, 56)
      }
      btn.onclick = (e) => {
        e.stopPropagation()
        const wp = def.localPos.clone()
        def.anchor.localToWorld(wp)
        this.glassesGroup.worldToLocal(wp)
        this.pulseAt(wp)
        this.triggerGesture(def.kind)
        def.run()
      }
      this.hotspotLayer.appendChild(btn)
      this.hotspotEls.push({ def, el: btn })
    }
  }

  private pulseAt(pos: THREE.Vector3): void {
    this.pulseRing.position.copy(pos)
    this.pulseRing.scale.setScalar(0.6)
    this.pulseMat.opacity = 0.95
  }

  private hitTemple(e: PointerEvent | WheelEvent): boolean {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObjects(this.templeTargets, false).length > 0
  }

  private zoomBy(delta: number): void {
    this.cameraAnimating = false
    this.zoomOffset.copy(this.camera.position).sub(this.controls.target)
    const dist = this.zoomOffset.length()
    const nextDist = THREE.MathUtils.clamp(dist + delta, this.controls.minDistance, this.controls.maxDistance)
    this.zoomOffset.setLength(nextDist)
    this.camera.position.copy(this.controls.target).add(this.zoomOffset)
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
        this.targetFold = 0
        this.triggerGesture('HOLD')
        cb.onHold()
      }, 450)
    })
    el.addEventListener('pointerup', (e) => {
      if (this.holdTimer !== null) {
        clearTimeout(this.holdTimer)
        this.holdTimer = null
      }
      if (!this.holdFired && this.hitTemple(e) && this.foldProgress < 0.4) {
        this.triggerGesture('TAP')
        cb.onTap()
      }
    })
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.foldProgress > 0.4 || !this.hitTemple(e) || Math.abs(e.deltaY) < 4) return
        e.preventDefault()
        e.stopImmediatePropagation()
        this.triggerGesture('SCROLL')
        cb.onScroll(e.deltaY > 0 ? 1 : -1)
      },
      { passive: false, capture: true }
    )

    // Smooth keyboard zoom (+ / - keys work on both RU and EN keyboard layouts) & F to fold/unfold
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault()
        this.zoomKeyDir = -1
      } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        this.zoomKeyDir = 1
      } else if (e.code === 'KeyF') {
        this.hasAutoUnfolded = true; this.targetFold = this.targetFold > 0.5 ? 0 : 1
      }
    })
    window.addEventListener('keyup', (e) => {
      if (
        e.code === 'Equal' ||
        e.code === 'NumpadAdd' ||
        e.code === 'Minus' ||
        e.code === 'NumpadSubtract'
      ) {
        this.zoomKeyDir = 0
      }
    })
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
    this.updateScreen(prev, this.isRecording, this.lastImageUrl, this.lastFullImage)
  }

  public toggleView(): void {
    this.viewIdx = (this.viewIdx + 1) % 3
    if (this.viewIdx === 0) {
      this.viewBtn.textContent = '👁 Wearer POV [V]'
      this.targetFold = 1
      this.desiredTarget.set(0, -0.04, -0.1)
      this.desiredCamPos.set(0, 0.04, 6.25)
    } else if (this.viewIdx === 1) {
      this.viewBtn.textContent = '🔍 Close-Up [V]'
      this.targetFold = 0
      this.desiredTarget.set(0, 0.02, 0.1)
      this.desiredCamPos.set(0, 0.15, -4.65)
    } else {
      this.viewBtn.textContent = '🕶 Folded Hero [V]'
      this.targetFold = 0
      this.desiredTarget.set(-1.38, 0.02, 0.15)
      this.desiredCamPos.set(-1.38, 0.04, -2.25)
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

  public updateScreen(text: string, recording: boolean, imageUrl = '', fullImage = false): void {
    if (
      text === this.lastText &&
      recording === this.isRecording &&
      imageUrl === this.lastImageUrl &&
      fullImage === this.lastFullImage
    ) {
      return
    }
    this.lastText = text
    this.isRecording = recording
    this.lastImageUrl = imageUrl
    this.lastFullImage = fullImage

    if (imageUrl && !this.imgCache.has(imageUrl) && !this.imgLoading.has(imageUrl)) {
      this.imgLoading.add(imageUrl)
      const fetchUrl = `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}hud=1`
      fetch(fetchUrl, { mode: 'cors' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((blob) => {
          const objUrl = URL.createObjectURL(blob)
          const img = new Image()
          img.onload = () => {
            URL.revokeObjectURL(objUrl)
            this.imgLoading.delete(imageUrl)
            this.imgCache.set(imageUrl, img)
            if (this.lastImageUrl === imageUrl) this.redrawHud()
          }
          img.onerror = () => {
            URL.revokeObjectURL(objUrl)
            this.imgLoading.delete(imageUrl)
          }
          img.src = objUrl
        })
        .catch((err) => {
          this.imgLoading.delete(imageUrl)
          console.warn('[HUD Image Fetch Error]', err)
        })
    }

    this.redrawHud()
  }

  private drawOpticalPhoto(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    boxX: number,
    boxY: number,
    boxW: number,
    boxH: number,
    fg: string
  ): void {
    if (!img.naturalWidth || !img.naturalHeight) return
    const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight)
    const dw = Math.max(1, Math.round(img.naturalWidth * scale))
    const dh = Math.max(1, Math.round(img.naturalHeight * scale))
    const dx = Math.round(boxX + (boxW - dw) / 2)
    const dy = Math.round(boxY + (boxH - dh) / 2)

    const off = document.createElement('canvas')
    off.width = dw
    off.height = dh
    const octx = off.getContext('2d')
    if (!octx) return

    octx.fillStyle = '#000'
    octx.fillRect(0, 0, dw, dh)
    octx.filter = 'grayscale(100%) contrast(1.25) brightness(1.34)'
    octx.drawImage(img, 0, 0, dw, dh)
    octx.filter = 'none'
    octx.globalCompositeOperation = 'multiply'
    octx.fillStyle = fg
    octx.fillRect(0, 0, dw, dh)

    ctx.save()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 0.96
    ctx.drawImage(off, dx, dy, dw, dh)

    const c = 14
    ctx.strokeStyle = fg
    ctx.globalAlpha = 0.6
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(dx, dy + c); ctx.lineTo(dx, dy); ctx.lineTo(dx + c, dy)
    ctx.moveTo(dx + dw - c, dy); ctx.lineTo(dx + dw, dy); ctx.lineTo(dx + dw, dy + c)
    ctx.moveTo(dx, dy + dh - c); ctx.lineTo(dx, dy + dh); ctx.lineTo(dx + c, dy + dh)
    ctx.moveTo(dx + dw - c, dy + dh); ctx.lineTo(dx + dw, dy + dh); ctx.lineTo(dx + dw, dy + dh - c)
    ctx.stroke()
    ctx.restore()
  }

  private redrawHud(): void {
    const ctx = this.lensCanvas.getContext('2d')
    if (!ctx) return

    const W = 1024
    const H = 512
    const theme = HUD_THEMES[this.themeIdx]
    const fg = this.isRecording ? '#fca5a5' : theme.css
    const glow = this.isRecording ? '#ef4444' : theme.glow
    const ff = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",sans-serif'

    ctx.clearRect(0, 0, W, H)

    const rad = ctx.createRadialGradient(W * 0.5, H * 0.48, 30, W * 0.5, H * 0.48, 410)
    rad.addColorStop(0, this.isRecording ? 'rgba(239,68,68,0.10)' : 'rgba(74,222,128,0.05)')
    rad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = rad
    ctx.fillRect(0, 0, W, H)

    const raw = this.lastText.split('\n').map((l) => l.trim()).filter(Boolean)
    const header = raw[0] || 'PULSEGLANCE G2'
    const footer = raw.length > 1 && raw[raw.length - 1].startsWith('[') ? raw[raw.length - 1] : ''
    const bodyRaw = raw.slice(1, footer ? -1 : undefined)

    const sx = 128
    const sw = W - sx * 2
    const loadedImg = this.lastImageUrl ? this.imgCache.get(this.lastImageUrl) : undefined
    const isLoadingImg = Boolean(this.lastImageUrl && !loadedImg && this.imgLoading.has(this.lastImageUrl))

    ctx.textBaseline = 'top'
    ctx.shadowColor = glow
    ctx.shadowBlur = 10
    ctx.fillStyle = fg
    ctx.beginPath()
    ctx.arc(sx + 6, 97, 4.5, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = `600 18px ${ff}`
    ctx.globalAlpha = 0.88
    ctx.fillText(header.slice(0, 56), sx + 20, 88)

    const lg = ctx.createLinearGradient(sx, 0, sx + sw, 0)
    lg.addColorStop(0, fg)
    lg.addColorStop(0.85, fg)
    lg.addColorStop(1, 'transparent')
    ctx.strokeStyle = lg
    ctx.globalAlpha = 0.25
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(sx, 114)
    ctx.lineTo(sx + sw, 114)
    ctx.stroke()

    if (loadedImg && this.lastFullImage) {
      this.drawOpticalPhoto(ctx, loadedImg, 165, 128, 694, 268, fg)
    } else if (isLoadingImg && this.lastFullImage) {
      ctx.globalAlpha = 0.72
      ctx.fillStyle = fg
      ctx.font = `500 20px ${ff}`
      ctx.fillText('Loading photo to optical waveguide…', sx, 235)
    } else if (loadedImg) {
      const textW = 445
      ctx.globalAlpha = 0.96
      ctx.fillStyle = fg
      ctx.font = `500 20px ${ff}`
      ctx.shadowBlur = 11
      const lines: string[] = []
      for (const p of bodyRaw) {
        for (const l of wrapPx(ctx, p, textW, 4)) {
          if (lines.length < 8) lines.push(l)
        }
      }
      lines.forEach((l, i) => ctx.fillText(l, sx, 130 + i * 29))
      this.drawOpticalPhoto(ctx, loadedImg, sx + textW + 24, 128, sw - textW - 24, 258, fg)
    } else {
      ctx.globalAlpha = 0.96
      ctx.fillStyle = fg
      ctx.font = `500 22px ${ff}`
      ctx.shadowBlur = 12
      const lines: string[] = []
      for (const p of bodyRaw) {
        for (const l of wrapPx(ctx, p, sw, 4)) {
          if (lines.length < 8) lines.push(l)
        }
      }
      lines.forEach((l, i) => ctx.fillText(l, sx, 130 + i * 31))
    }

    if (footer) {
      ctx.globalAlpha = 0.55
      ctx.fillStyle = fg
      ctx.font = `500 15px ${ff}`
      ctx.shadowBlur = 6
      ctx.fillText(footer.replace(/\[/g, '').replace(/\]/g, ' ·').slice(0, 72), sx, 412)
    }

    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
    this.lensTex.needsUpdate = true
  }

  private updateHotspots(): void {
    if (!this.showPins) return
    const openAlpha = THREE.MathUtils.smoothstep(1 - this.foldProgress, 0.55, 0.95)
    const w = this.domElement.clientWidth || 580
    const h = this.domElement.clientHeight || 350

    for (const { def, el } of this.hotspotEls) {
      if (openAlpha < 0.05) {
        el.style.opacity = '0'
        el.style.pointerEvents = 'none'
        continue
      }
      this.projVec.copy(def.localPos)
      def.anchor.localToWorld(this.projVec)
      this.projVec.project(this.camera)
      if (this.projVec.z > 1) {
        el.style.opacity = '0'
        el.style.pointerEvents = 'none'
        continue
      }
      el.style.left = `${Math.max(46, Math.min(w - 46, (this.projVec.x * 0.5 + 0.5) * w))}px`
      el.style.top = `${Math.max(48, Math.min(h - 36, (-this.projVec.y * 0.5 + 0.5) * h))}px`
      el.style.opacity = String(openAlpha)
      el.style.pointerEvents = 'auto'
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate)
    const now = performance.now()
    const flashing = now < this.flashUntil
    const theme = HUD_THEMES[this.themeIdx]

    // Smooth temple fold/unfold hinge animation
    this.foldProgress += (this.targetFold - this.foldProgress) * 0.085
    if (Math.abs(this.targetFold - this.foldProgress) < 0.001) this.foldProgress = this.targetFold
    this.rightPivot.rotation.y = this.foldProgress * 1.49
    this.leftPivot.rotation.y = -this.foldProgress * 1.42
    const fLbl = this.targetFold > 0.5 ? "📂 Open [F]" : "🕶 Fold [F]"
    if (this.foldBtn.textContent !== fLbl) this.foldBtn.textContent = fLbl

    // Continuous buttery keyboard zoom (+ / -)
    if (this.zoomKeyDir !== 0) {
      this.zoomBy(this.zoomKeyDir * 0.08)
    }

    if (this.cameraAnimating) {
      this.camera.position.lerp(this.desiredCamPos, 0.1)
      this.controls.target.lerp(this.desiredTarget, 0.1)
      if (this.camera.position.distanceTo(this.desiredCamPos) < 0.015) {
        this.camera.position.copy(this.desiredCamPos)
        this.controls.target.copy(this.desiredTarget)
        this.cameraAnimating = false
      }
    }

    // Directional optical waveguide fade: visible only when looking from behind lenses (-Z)
    this.camera.getWorldDirection(this.camDir)
    const behindAlpha = THREE.MathUtils.smoothstep(this.camDir.z, 0.08, 0.52)
    this.hudMat.opacity = behindAlpha * 0.98

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
      ? 0.65
      : 0.14

    if (!flashing && !this.isRecording) {
      if (behindAlpha > 0.35) {
        this.badgeEl.textContent = `WEARER POV • ${theme.name.toUpperCase()} WAVEGUIDE`
        this.badgeEl.style.color = theme.css
      } else if (this.foldProgress > 0.6) {
        this.badgeEl.textContent = 'EVEN G2 FOLDED • DRAG TO UNFOLD & ORBIT'
        this.badgeEl.style.color = '#94a3b8'
      } else {
        this.badgeEl.textContent = 'FRONT VIEW • ZERO LIGHT LEAK (ORBIT BEHIND)'
        this.badgeEl.style.color = '#94a3b8'
      }
    }

    this.controls.update()
    this.updateHotspots()
    this.renderer.render(this.scene, this.camera)
  }
}
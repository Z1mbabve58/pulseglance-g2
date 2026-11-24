import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type GestureKind = 'TAP' | 'SCROLL' | 'HOLD'

export interface GlassesCallbacks {
  onTap: () => void
  onScroll: (dir: number) => void
  onHold: () => void
}

function createPantoLensShape(scale = 1): THREE.Shape {
  const s = new THREE.Shape()
  const w = 1.18 * scale
  const hTop = 0.86 * scale
  const hBot = 0.96 * scale
  s.moveTo(-w * 0.72, hTop)
  s.bezierCurveTo(-w * 0.2, hTop * 1.08, w * 0.35, hTop * 1.06, w * 0.78, hTop * 0.92)
  s.bezierCurveTo(w * 1.08, hTop * 0.78, w * 1.06, -hBot * 0.15, w * 0.84, -hBot * 0.68)
  s.bezierCurveTo(w * 0.58, -hBot * 1.05, -w * 0.45, -hBot * 1.05, -w * 0.78, -hBot * 0.66)
  s.bezierCurveTo(-w * 1.06, -hBot * 0.25, -w * 1.05, hTop * 0.75, -w * 0.72, hTop)
  return s
}

function createNormalizedLensGeo(): THREE.ShapeGeometry {
  const shape = createPantoLensShape(0.92)
  const geo = new THREE.ShapeGeometry(shape, 32)
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  const pos = geo.attributes.position
  const uv = geo.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x)
    const v = (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y)
    uv.setXY(i, u, v)
  }
  uv.needsUpdate = true
  return geo
}

export class Glasses3DViewer {
  public readonly domElement: HTMLDivElement
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls
  private glassesGroup: THREE.Group
  private sensorMat: THREE.MeshStandardMaterial
  private hudMat: THREE.MeshBasicMaterial
  private lensCanvas: HTMLCanvasElement
  private lensTex: THREE.CanvasTexture
  private badgeEl: HTMLDivElement
  private viewBtn: HTMLButtonElement
  private povMode = false
  private cameraAnimating = false
  private desiredCamPos = new THREE.Vector3(1.85, 0.55, 5.1)
  private desiredTarget = new THREE.Vector3(0, 0, -0.5)
  private flashUntil = 0
  private isRecording = false
  private hoveringTemple = false
  private lastText = ''
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private templeTargets: THREE.Object3D[] = []
  private holdTimer: number | null = null
  private holdFired = false
  private camWorldDir = new THREE.Vector3()

  constructor(callbacks: GlassesCallbacks) {
    this.domElement = document.createElement('div')
    this.domElement.style.cssText =
      'position:relative;width:100%;height:275px;border-radius:14px;overflow:hidden;border:1px solid #1d4d35;background:radial-gradient(circle at 50% 42%,#0d261a 0%,#030906 85%);cursor:grab;'

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(34, 580 / 275, 0.1, 50)
    this.camera.position.copy(this.desiredCamPos)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(580, 275)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;'
    this.domElement.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.enablePan = false
    this.controls.enableZoom = true
    this.controls.zoomSpeed = 0.85
    this.controls.minDistance = 1.15
    this.controls.maxDistance = 8.5
    this.controls.target.copy(this.desiredTarget)
    this.controls.addEventListener('start', () => {
      this.cameraAnimating = false
    })

    this.scene.add(new THREE.AmbientLight(0xd1fae5, 0.9))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
    keyLight.position.set(3, 4, 5)
    this.scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x34d399, 1.3)
    rimLight.position.set(-4, 2, -3)
    this.scene.add(rimLight)

    this.lensCanvas = document.createElement('canvas')
    this.lensCanvas.width = 576
    this.lensCanvas.height = 288
    this.lensTex = new THREE.CanvasTexture(this.lensCanvas)
    this.lensTex.colorSpace = THREE.SRGBColorSpace

    this.sensorMat = new THREE.MeshStandardMaterial({
      color: 0x3b4842,
      metalness: 0.75,
      roughness: 0.25,
      emissive: 0x10b981,
      emissiveIntensity: 0.25,
    })

    this.hudMat = new THREE.MeshBasicMaterial({
      map: this.lensTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    })

    this.glassesGroup = new THREE.Group()
    this.buildFrame()
    this.scene.add(this.glassesGroup)

    this.badgeEl = document.createElement('div')
    this.badgeEl.style.cssText =
      'position:absolute;top:10px;left:12px;padding:4px 10px;border-radius:999px;background:rgba(6,20,13,0.85);border:1px solid #24573e;color:#6ee7b7;font-size:10px;font-weight:700;letter-spacing:0.6px;pointer-events:none;transition:all 0.15s;'
    this.badgeEl.textContent = 'FRONT VIEW • ORBIT BEHIND LENSES TO SEE HUD'
    this.domElement.appendChild(this.badgeEl)

    this.viewBtn = document.createElement('button')
    this.viewBtn.style.cssText =
      'position:absolute;top:9px;right:10px;padding:4px 10px;border-radius:8px;border:1px solid #2d6a4c;background:rgba(12,34,23,0.9);color:#ecfdf5;font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;'
    this.viewBtn.textContent = '👁 POV Lens [V]'
    this.viewBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleView()
    })
    this.domElement.appendChild(this.viewBtn)

    const hintEl = document.createElement('div')
    hintEl.style.cssText =
      'position:absolute;bottom:8px;left:12px;right:12px;display:flex;justify-content:space-between;font-size:9.5px;color:#6ee7b7;opacity:0.7;pointer-events:none;'
    hintEl.innerHTML = '<span>Drag: Orbit behind glasses • Wheel: Zoom • Temple Wheel: Scroll chats</span><span>Directional Waveguide</span>'
    this.domElement.appendChild(hintEl)

    this.bindInteractions(callbacks)
    this.updateScreen('PULSEGLANCE G2 // READY', false)
    this.animate()
  }

  private buildFrame(): void {
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x262b29,
      metalness: 0.35,
      roughness: 0.48,
    })
    const podMat = new THREE.MeshStandardMaterial({
      color: 0x1d2220,
      metalness: 0.25,
      roughness: 0.55,
    })
    const lensGlassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b2218,
      transparent: true,
      opacity: 0.48,
      roughness: 0.08,
      metalness: 0.12,
      side: THREE.DoubleSide,
    })

    const outer = createPantoLensShape(1.0)
    const innerHole = createPantoLensShape(0.91)
    outer.holes.push(innerHole)

    const rimGeo = new THREE.ExtrudeGeometry(outer, {
      depth: 0.13,
      bevelEnabled: true,
      bevelThickness: 0.025,
      bevelSize: 0.022,
      bevelSegments: 4,
    })
    rimGeo.center()

    const lensGeo = createNormalizedLensGeo()

    for (const side of [-1, 1]) {
      const xOff = side * 1.38
      const rim = new THREE.Mesh(rimGeo, frameMat)
      rim.position.set(xOff, 0, 0)
      this.glassesGroup.add(rim)

      const glass = new THREE.Mesh(lensGeo, lensGlassMat)
      glass.position.set(xOff, 0, 0)
      this.glassesGroup.add(glass)

      // Single-sided inner waveguide layer facing -Z (wearer's eyes only)
      const hudInner = new THREE.Mesh(lensGeo, this.hudMat)
      hudInner.position.set(xOff, 0, -0.016)
      hudInner.rotation.y = Math.PI
      this.glassesGroup.add(hudInner)

      const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.17, 0.2), this.sensorMat)
      hinge.position.set(side * 2.58, 0.34, -0.05)
      this.glassesGroup.add(hinge)
      this.templeTargets.push(hinge)

      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 2.7), frameMat)
      arm.position.set(side * 2.7, 0.3, -1.42)
      this.glassesGroup.add(arm)
      this.templeTargets.push(arm)

      const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.95, 8, 16), podMat)
      pod.rotation.x = Math.PI / 2 + 0.18
      pod.position.set(side * 2.72, 0.12, -2.85)
      this.glassesGroup.add(pod)
      this.templeTargets.push(pod)
    }

    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.16, 0.15), frameMat)
    bridge.position.set(0, 0.36, 0.01)
    this.glassesGroup.add(bridge)
  }

  private hitTemple(e: PointerEvent | WheelEvent): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObjects(this.templeTargets, false).length > 0
  }

  private bindInteractions(callbacks: GlassesCallbacks): void {
    const el = this.renderer.domElement

    el.addEventListener('pointermove', (e) => {
      const over = this.hitTemple(e)
      if (over !== this.hoveringTemple) {
        this.hoveringTemple = over
        el.style.cursor = over ? 'pointer' : 'grab'
      }
    })

    el.addEventListener('pointerdown', (e) => {
      if (!this.hitTemple(e)) return
      this.holdFired = false
      this.holdTimer = window.setTimeout(() => {
        this.holdFired = true
        this.triggerGesture('HOLD')
        callbacks.onHold()
      }, 460)
    })

    el.addEventListener('pointerup', (e) => {
      if (this.holdTimer !== null) {
        clearTimeout(this.holdTimer)
        this.holdTimer = null
      }
      if (!this.holdFired && this.hitTemple(e)) {
        this.triggerGesture('TAP')
        callbacks.onTap()
      }
    })

    // Capture phase: wheel on temple scrolls chats without zooming; wheel elsewhere only zooms camera
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.hitTemple(e)) return
        if (Math.abs(e.deltaY) < 4) return
        e.preventDefault()
        e.stopImmediatePropagation()
        this.triggerGesture('SCROLL')
        callbacks.onScroll(e.deltaY > 0 ? 1 : -1)
      },
      { passive: false, capture: true }
    )
  }

  public toggleView(): void {
    this.povMode = !this.povMode
    this.viewBtn.textContent = this.povMode ? '🕶 3D Frame [V]' : '👁 POV Lens [V]'
    if (this.povMode) {
      this.desiredTarget.set(-1.38, 0.02, 0.4)
      this.desiredCamPos.set(-1.38, 0.02, -2.18)
    } else {
      this.desiredTarget.set(0, 0, -0.5)
      this.desiredCamPos.set(1.85, 0.55, 5.1)
    }
    this.cameraAnimating = true
  }

  public triggerGesture(kind: GestureKind): void {
    this.flashUntil = performance.now() + 550
    const labels: Record<GestureKind, string> = {
      TAP: '⚡ TEMPLE TAP • OPEN / SEND',
      SCROLL: '↕ TEMPLE SCROLL • NAVIGATE',
      HOLD: '🎙 TEMPLE HOLD • VOICE NOTE',
    }
    this.badgeEl.textContent = labels[kind]
    this.badgeEl.style.borderColor = kind === 'HOLD' ? '#f87171' : '#34d399'
    this.badgeEl.style.color = kind === 'HOLD' ? '#fca5a5' : '#ecfdf5'
  }

  public updateScreen(text: string, recording: boolean): void {
    if (text === this.lastText && recording === this.isRecording) return
    this.lastText = text
    this.isRecording = recording

    const ctx = this.lensCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, 576, 288)

    ctx.fillStyle = recording ? 'rgba(42, 8, 8, 0.78)' : 'rgba(3, 22, 13, 0.74)'
    ctx.fillRect(0, 0, 576, 288)

    ctx.strokeStyle = recording ? 'rgba(248, 113, 113, 0.7)' : 'rgba(74, 222, 128, 0.6)'
    ctx.lineWidth = 3
    ctx.strokeRect(14, 14, 548, 260)

    ctx.font = '600 20px "SF Mono", Menlo, monospace'
    ctx.fillStyle = recording ? '#fca5a5' : '#4ade80'
    ctx.shadowColor = recording ? '#ef4444' : '#22c55e'
    ctx.shadowBlur = 10

    const lines = text.split('\n').slice(0, 8)
    lines.forEach((line, idx) => {
      ctx.fillText(line.slice(0, 44), 30, 54 + idx * 30)
    })
    ctx.shadowBlur = 0
    this.lensTex.needsUpdate = true
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate)
    const now = performance.now()
    const flashing = now < this.flashUntil

    if (this.cameraAnimating) {
      this.camera.position.lerp(this.desiredCamPos, 0.1)
      this.controls.target.lerp(this.desiredTarget, 0.1)
      if (this.camera.position.distanceTo(this.desiredCamPos) < 0.015) {
        this.camera.position.copy(this.desiredCamPos)
        this.controls.target.copy(this.desiredTarget)
        this.cameraAnimating = false
      }
    }

    // Directional waveguide optical fade: visible only when viewing from behind the lenses (-Z)
    this.camera.getWorldDirection(this.camWorldDir)
    const behindAlignment = this.camWorldDir.z
    const waveguideAlpha = THREE.MathUtils.smoothstep(behindAlignment, 0.08, 0.55)
    this.hudMat.opacity = waveguideAlpha * 0.97

    if (this.isRecording) {
      this.sensorMat.emissive.setHex(0xef4444)
      this.sensorMat.emissiveIntensity = 1.2 + Math.sin(now * 0.012) * 0.5
    } else if (flashing) {
      this.sensorMat.emissive.setHex(0x34d399)
      this.sensorMat.emissiveIntensity = 1.6
    } else if (this.hoveringTemple) {
      this.sensorMat.emissive.setHex(0x34d399)
      this.sensorMat.emissiveIntensity = 0.7
    } else {
      this.sensorMat.emissive.setHex(0x10b981)
      this.sensorMat.emissiveIntensity = 0.25
    }

    if (!flashing && !this.isRecording) {
      if (this.hoveringTemple) {
        this.badgeEl.textContent = 'TEMPLE SENSOR • TAP / SCROLL / HOLD'
        this.badgeEl.style.borderColor = '#34d399'
        this.badgeEl.style.color = '#ecfdf5'
      } else if (waveguideAlpha > 0.35) {
        this.badgeEl.textContent = 'WEARER POV • WAVEGUIDE HUD ACTIVE'
        this.badgeEl.style.borderColor = '#2e6f4e'
        this.badgeEl.style.color = '#4ade80'
      } else {
        this.badgeEl.textContent = 'FRONT VIEW • ORBIT BEHIND LENSES TO SEE HUD'
        this.badgeEl.style.borderColor = '#24573e'
        this.badgeEl.style.color = '#6ee7b7'
      }
    }

    if (!this.povMode && !this.cameraAnimating) {
      this.glassesGroup.position.y = Math.sin(now * 0.0016) * 0.03
    } else {
      this.glassesGroup.position.y = 0
    }

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}

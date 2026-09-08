import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  type VRMAnimation
} from '@pixiv/three-vrm-animation'
import { AVATAR_INTENTS, resolveStartupAvatarAnimation } from '@shared/avatar'
import type { AvatarActivity, AvatarBootstrap, AvatarCapabilities, AvatarCommand, AvatarIntent } from '@shared/avatar'
import type { AvatarLookTarget } from '@shared/avatar'
import { AvatarMotionController } from './AvatarMotionController'
import { AvatarExpressionController } from './AvatarExpressionController'
import { AvatarClipAdapter } from './AvatarClipAdapter'

type AssetLoader = (assetId: string) => Promise<Uint8Array>

export class AvatarScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100)
  private readonly lookTarget = new THREE.Object3D()
  private readonly desiredLookTarget = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private framingBounds: THREE.Box3 | null = null
  private readonly clock = new THREE.Clock()
  private readonly resizeObserver: ResizeObserver
  private readonly container: HTMLElement
  private animationFrame = 0
  private loadVersion = 0
  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private motion: AvatarMotionController | null = null
  private expressions: AvatarExpressionController | null = null
  private clipAdapter: AvatarClipAdapter | null = null
  private activity: AvatarActivity = 'idle'
  private embeddedClips = new Map<string, THREE.AnimationClip>()
  private animationClips = new Map<string, Promise<THREE.AnimationClip>>()
  private model: AvatarBootstrap['model'] | null = null
  private loadAsset: AssetLoader | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.container.appendChild(this.renderer.domElement)
    this.scene.add(this.lookTarget)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.5))
    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.set(1.5, 2.8, 2.2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x9bbcff, 1.0)
    fill.position.set(-2, 1.2, 1)
    this.scene.add(fill)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.animate()
  }

  async load(bootstrap: AvatarBootstrap, loadAsset: AssetLoader): Promise<AvatarCapabilities> {
    const version = ++this.loadVersion
    this.disposeModel()
    this.model = bootstrap.model
    this.loadAsset = loadAsset
    const gltf = await this.parseAsset(await loadAsset(bootstrap.model.id))
    if (version !== this.loadVersion) {
      VRMUtils.deepDispose(gltf.scene)
      throw new Error('Avatar model load was superseded.')
    }
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('The selected file is not a valid VRM model.')

    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)
    VRMUtils.combineMorphs(vrm)
    this.clipAdapter = new AvatarClipAdapter(vrm)
    VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse(object => { object.frustumCulled = false })

    this.vrm = vrm
    this.scene.add(vrm.scene)
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    const overrides: Partial<Record<AvatarIntent, string>> = {}
    for (const animation of bootstrap.model.animations) {
      if (animation.intent) overrides[animation.intent] = animation.name
    }
    const motion = new AvatarMotionController(vrm, this.mixer, name => this.resolveClip(name), overrides)
    this.motion = motion
    this.expressions = vrm.expressionManager ? new AvatarExpressionController(vrm.expressionManager) : null
    this.embeddedClips = new Map()
    for (const clip of gltf.animations) {
      if (!clip.name) continue
      try { this.embeddedClips.set(clip.name, this.clipAdapter.adapt(clip)) }
      catch (error) { console.warn(`Avatar embedded animation ${clip.name} is invalid.`, error) }
    }
    this.frameModel(vrm.scene)
    this.setLookTarget({ x: 0, y: 0, tracking: false })
    this.lookTarget.position.copy(this.desiredLookTarget)

    const configured = bootstrap.model.animations.filter(animation =>
      animation.source === 'vrma' || this.embeddedClips.has(animation.clipName || animation.name)
    ).map(animation => animation.name)
    const animations = [...new Set([...configured, ...this.embeddedClips.keys()])]
    const expressions = vrm.expressionManager
      ? Object.keys(vrm.expressionManager.expressionMap)
      : []
    const preferredIdle = resolveStartupAvatarAnimation(bootstrap.model, animations) ?? overrides.idle
    const idle = await motion.initialize(preferredIdle)
    if (version !== this.loadVersion) throw new Error('Avatar model load was superseded.')
    const checked = await Promise.allSettled(configured.map(name => this.resolveClip(name)))
    for (let i = 0; i < checked.length; i++) {
      if (checked[i].status === 'rejected') {
        const index = animations.indexOf(configured[i])
        if (index >= 0) animations.splice(index, 1)
        console.warn(`Avatar animation ${configured[i]} is unavailable.`, checked[i])
      }
    }
    if (version !== this.loadVersion) throw new Error('Avatar model load was superseded.')
    motion.setActivity(this.activity)
    if (!animations.includes(idle.name)) animations.push(idle.name)
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget
    return {
      animations,
      expressions,
      defaultAnimation: idle.name,
      intents: [...AVATAR_INTENTS]
    }
  }

  async handle(command: AvatarCommand): Promise<void> {
    if (command.type === 'show_message') return
    if (!this.vrm) throw new Error('Avatar model is not ready.')
    if (command.type === 'perform') {
      await this.motion?.perform(command.intent, command.intensity)
      const emotion = command.emotion ?? (command.intent === 'sad' ? 'sad'
        : command.intent === 'greet' || command.intent === 'celebrate' ? 'happy' : undefined)
      if (emotion) this.expressions?.emotion(emotion, command.intensity)
      return
    }
    if (command.type === 'play_animation') {
      await this.motion?.play(command.animation, command.loop)
      return
    }
    if (command.type === 'set_expression') {
      this.expressions?.expression(command.expression, command.value)
      return
    }
    if (command.type === 'reset_pose') {
      this.expressions?.reset()
      await this.motion?.reset()
    }
  }

  setLookTarget(target: AvatarLookTarget): void {
    const x = THREE.MathUtils.clamp(target.x, -2.5, 2.5)
    const y = THREE.MathUtils.clamp(target.y, -2.5, 2.5)
    this.camera.updateMatrixWorld()
    const point = new THREE.Vector3(x, y, 0.5).unproject(this.camera)
    const direction = point.sub(this.camera.position).normalize()
    // Put the target on a plane in front of the face, never a fixed distance
    // behind the model (which can invert eye direction on small VRMs).
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head')
    const headPosition = head?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3()
    if (target.tracking === false) {
      this.desiredLookTarget.set(this.camera.position.x, headPosition.y, this.camera.position.z)
      return
    }
    const distance = Math.max(0.05, (this.camera.position.z - headPosition.z) * 0.6)
    this.desiredLookTarget.copy(this.camera.position).addScaledVector(direction, distance / Math.max(0.01, -direction.z))
  }

  setActivity(activity: AvatarActivity): void {
    this.activity = activity
    this.motion?.setActivity(activity)
  }

  hitTest(clientX: number, clientY: number): boolean {
    if (!this.vrm) return false
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false
    this.raycaster.setFromCamera(new THREE.Vector2(
      (clientX - rect.left) / rect.width * 2 - 1,
      1 - (clientY - rect.top) / rect.height * 2
    ), this.camera)
    return this.raycaster.intersectObject(this.vrm.scene, true).some(hit => hit.object.visible)
  }

  dispose(): void {
    this.loadVersion++
    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver.disconnect()
    this.disposeModel()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private async resolveClip(name: string): Promise<THREE.AnimationClip> {
    const existing = this.embeddedClips.get(name)
    if (existing) return existing
    const config = this.model?.animations.find(animation => animation.name === name)
    if (!config) throw new Error(`Animation "${name}" is unavailable.`)
    if (config.source === 'embedded') {
      const clip = this.embeddedClips.get(config.clipName || config.name)
      if (!clip) throw new Error(`Embedded clip "${config.clipName || config.name}" was not found.`)
      return clip
    }

    let pending = this.animationClips.get(config.id)
    if (!pending) {
      pending = this.loadVrmAnimation(config.id)
      this.animationClips.set(config.id, pending)
    }
    return pending
  }

  private async loadVrmAnimation(assetId: string): Promise<THREE.AnimationClip> {
    if (!this.loadAsset || !this.vrm) throw new Error('Avatar model is not ready.')
    const vrm = this.vrm
    const version = this.loadVersion
    const gltf = await this.parseAsset(await this.loadAsset(assetId))
    if (version !== this.loadVersion) throw new Error('Avatar animation load was superseded.')
    const vrmAnimation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
    if (!vrmAnimation) throw new Error('The selected .vrma file contains no VRM animation.')
    return this.clipAdapter!.adapt(createVRMAnimationClip(vrmAnimation, vrm))
  }

  private parseAsset(bytes: Uint8Array): Promise<GLTF> {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))
    loader.register(parser => new VRMAnimationLoaderPlugin(parser))
    return loader.parseAsync(data, '')
  }

  private frameModel(root: THREE.Object3D): void {
    root.updateWorldMatrix(true, true)
    const box = this.framingBounds ??= new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const height = Math.max(size.y, 0.1)
    const width = Math.max(size.x, 0.1)
    const verticalDistance = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))
    const horizontalFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect)
    const horizontalDistance = width / (2 * Math.tan(horizontalFov / 2))
    const distance = Math.max(verticalDistance, horizontalDistance) * 1.08
    const target = new THREE.Vector3(center.x, center.y + height * 0.02, center.z)
    this.camera.position.set(target.x, target.y, box.max.z + distance)
    this.camera.near = Math.max(0.01, distance / 100)
    this.camera.far = distance * 100
    this.camera.lookAt(target)
    this.camera.updateProjectionMatrix()
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.vrm) this.frameModel(this.vrm.scene)
  }

  private animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate)
    const delta = Math.min(this.clock.getDelta(), 0.1)
    this.motion?.update(delta)
    this.expressions?.update(delta)
    this.lookTarget.position.lerp(this.desiredLookTarget, 1 - Math.exp(-12 * delta))
    this.lookTarget.updateMatrixWorld()
    this.vrm?.update(delta)
    this.renderer.render(this.scene, this.camera)
  }

  private disposeModel(): void {
    this.framingBounds = null
    this.motion?.dispose()
    this.motion = null
    this.expressions = null
    this.clipAdapter = null
    this.mixer = null
    this.animationClips.clear()
    this.embeddedClips.clear()
    if (this.vrm) {
      if (this.vrm.lookAt) this.vrm.lookAt.target = null
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
  }
}

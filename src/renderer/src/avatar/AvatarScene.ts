import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  type VRMAnimation
} from '@pixiv/three-vrm-animation'
import { resolveStartupAvatarAnimation } from '@shared/avatar'
import type { AvatarBootstrap, AvatarCapabilities, AvatarCommand } from '@shared/avatar'

type AssetLoader = (assetId: string) => Promise<Uint8Array>

export class AvatarScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100)
  private readonly clock = new THREE.Clock()
  private readonly resizeObserver: ResizeObserver
  private readonly container: HTMLElement
  private animationFrame = 0
  private loadVersion = 0
  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
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

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.7)
    key.position.set(1.5, 2.8, 2.2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x9bbcff, 1.2)
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
    VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse(object => { object.frustumCulled = false })

    this.vrm = vrm
    this.scene.add(vrm.scene)
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.embeddedClips = new Map(gltf.animations.filter(clip => !!clip.name).map(clip => [clip.name, clip]))
    this.frameModel(vrm.scene)

    const configured = bootstrap.model.animations.map(animation => animation.name)
    const animations = [...new Set([...configured, ...this.embeddedClips.keys()])]
    const expressions = vrm.expressionManager
      ? Object.keys(vrm.expressionManager.expressionMap)
      : []
    const defaultAnimation = resolveStartupAvatarAnimation(bootstrap.model, animations)
    if (defaultAnimation) await this.playAnimation(defaultAnimation, true)
    return {
      animations,
      expressions,
      defaultAnimation
    }
  }

  async handle(command: AvatarCommand): Promise<void> {
    if (command.type === 'show_message') return
    if (!this.vrm) throw new Error('Avatar model is not ready.')
    if (command.type === 'play_animation') {
      await this.playAnimation(command.animation, command.loop)
      return
    }
    if (command.type === 'set_expression') {
      this.vrm.expressionManager?.setValue(command.expression, command.value)
      return
    }
    if (command.type === 'reset_pose') {
      this.mixer?.stopAllAction()
      this.vrm.humanoid?.resetNormalizedPose()
      this.vrm.expressionManager?.resetValues()
    }
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

  private async playAnimation(name: string, loop: boolean): Promise<void> {
    const clip = await this.resolveClip(name)
    this.mixer?.stopAllAction()
    const action = this.mixer!.clipAction(clip).reset()
    if (loop) action.setLoop(THREE.LoopRepeat, Infinity)
    else {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    }
    action.play()
  }

  private async loadVrmAnimation(assetId: string): Promise<THREE.AnimationClip> {
    if (!this.loadAsset || !this.vrm) throw new Error('Avatar model is not ready.')
    const gltf = await this.parseAsset(await this.loadAsset(assetId))
    const vrmAnimation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
    if (!vrmAnimation) throw new Error('The selected .vrma file contains no VRM animation.')
    return createVRMAnimationClip(vrmAnimation, this.vrm)
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
    const box = new THREE.Box3().setFromObject(root)
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
    this.mixer?.update(delta)
    this.vrm?.update(delta)
    this.renderer.render(this.scene, this.camera)
  }

  private disposeModel(): void {
    this.mixer?.stopAllAction()
    this.mixer = null
    this.animationClips.clear()
    this.embeddedClips.clear()
    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
  }
}

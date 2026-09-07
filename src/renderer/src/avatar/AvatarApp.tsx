import { useEffect, useRef, useState } from 'react'
import { AvatarScene } from './AvatarScene'

export default function AvatarApp() {
  const stageRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<AvatarScene | null>(null)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('Loading Avatar…')

  const capturePointer = () => { void window.avatarApi.setPointerPassthrough(false) }
  const releasePointer = () => { void window.avatarApi.setPointerPassthrough(true) }

  useEffect(() => {
    if (!stageRef.current) return
    const scene = new AvatarScene(stageRef.current)
    sceneRef.current = scene
    let generation = 0

    const reload = async () => {
      const current = ++generation
      setStatus('Loading Avatar…')
      try {
        const bootstrap = await window.avatarApi.getBootstrap()
        const capabilities = await scene.load(bootstrap, assetId => window.avatarApi.getAsset(assetId))
        if (current !== generation) return
        setMessage(bootstrap.latestMessage)
        setStatus('')
        await window.avatarApi.reportCapabilities(capabilities)
      } catch (error) {
        if (current !== generation) return
        setStatus(error instanceof Error ? error.message : String(error))
        await window.avatarApi.reportCapabilities({ animations: [], expressions: [] })
      }
    }

    const reportCommand = async (id: string, error?: string) => {
      try {
        await window.avatarApi.reportCommandResult(id, error)
      } catch (reportError) {
        setStatus(reportError instanceof Error ? reportError.message : String(reportError))
      }
    }

    const unsubs = [
      window.avatarApi.onStateChanged(() => { void reload() }),
      window.avatarApi.onMessage(setMessage),
      window.avatarApi.onCommand(({ id, command }) => {
        if (command.type === 'show_message') setMessage(command.message)
        void scene.handle(command).then(async () => {
          setStatus('')
          await reportCommand(id)
        }, async error => {
          const message = error instanceof Error ? error.message : String(error)
          setStatus(message)
          await reportCommand(id, message)
        })
      })
    ]
    void reload()

    return () => {
      generation++
      unsubs.forEach(unsubscribe => unsubscribe())
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  return (
    <div className="avatar-root">
      <div
        className="avatar-drag-handle"
        title="Drag to move"
        onMouseEnter={capturePointer}
        onMouseLeave={releasePointer}
      />
      {(status || message) && (
        <div
          className={status ? 'avatar-bubble error' : 'avatar-bubble'}
          title={status || message}
          onMouseEnter={capturePointer}
          onMouseLeave={releasePointer}
        >
          {status || message}
        </div>
      )}
      <div ref={stageRef} className="avatar-stage" />
    </div>
  )
}

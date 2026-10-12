import type { MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, GripHorizontal, Maximize2, Minus, PanelRightClose, X } from 'lucide-react'
import type { PanelId } from '../../../shared/panels'
import type { PanelMode, PanelPlacement } from './layout'
import DockPanelMenu from './DockPanelMenu'
import type { PanelPortal } from './usePanelWindows'

export interface DockPanelDefinition { id: PanelId; title: string; content: ReactNode; toolbar?: ReactNode; onClose?: () => void }

export default function DockPanel({ panel, placement, portal, active, onActivate, onPlace, onDrag }: {
  panel: DockPanelDefinition; placement: PanelPlacement; portal?: PanelPortal
  onPlace: (id: PanelId, mode: PanelMode) => void
  onDrag: (id: PanelId, event: MouseEvent<HTMLElement>, resize?: boolean) => void
  active: boolean; onActivate: (id: PanelId) => void
}) {
  const { t } = useTranslation()
  const native = !!portal
  const mode = native ? 'window' : placement.mode
  return <section className={`dock-panel dock-${panel.id} is-${mode}`} data-panel={panel.id} data-mode={mode}
    onMouseDownCapture={() => onActivate(panel.id)}
    style={mode === 'floating' ? { left: placement.bounds.x, top: placement.bounds.y, width: placement.bounds.width, height: placement.bounds.height,
      zIndex: active ? 18 : 15 } : undefined}>
    <header className={`dock-panel-header${native ? ' native-drag' : ''}`} onMouseDown={native ? undefined : event => onDrag(panel.id, event)}>
      <GripHorizontal size={13} /><strong>{panel.title}</strong>
      {panel.toolbar}
      <div className="dock-panel-actions">
        {native ? <>
          <button title={t('dock.return')} aria-label={t('dock.return')} onClick={() => onPlace(panel.id, placement.home)}><PanelRightClose size={13} /></button>
          <button title={t('window.minimize')} aria-label={t('window.minimize')} onClick={() => void window.api.panels.control(portal.key, 'minimize')}><Minus size={13} /></button>
          <button title={t('window.maximize')} aria-label={t('window.maximize')} onClick={() => void window.api.panels.control(portal.key, 'maximize')}><Maximize2 size={12} /></button>
        </> : <button title={t('dock.detach')} aria-label={t('dock.detach')} onClick={() => onPlace(panel.id, 'window')}><ArrowUpRight size={13} /></button>}
        <DockPanelMenu id={panel.id} onPlace={onPlace} />
        {(panel.onClose || native) && <button title={t(panel.id === 'details' ? 'flow.close' : 'window.close')} aria-label={t(panel.id === 'details' ? 'flow.close' : 'window.close')} onClick={() => {
          if (native) onPlace(panel.id, placement.home)
          else panel.onClose?.()
        }}><X size={13} /></button>}
      </div>
    </header>
    <div className="dock-panel-content">{panel.content}</div>
    {mode === 'floating' && <div className="dock-panel-resize" aria-label={t('dock.resize')} onMouseDown={event => onDrag(panel.id, event, true)} />}
  </section>
}

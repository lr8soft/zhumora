import type { MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, GripHorizontal, Maximize2, Minus, MoreHorizontal, PanelRightClose, X } from 'lucide-react'
import type { PanelId } from '../../../shared/panels'
import { DOCK_SIDES, type PanelMode, type PanelPlacement } from './layout'
import type { PanelPortal } from './usePanelWindows'

export interface DockPanelDefinition { id: PanelId; title: string; content: ReactNode; toolbar?: ReactNode; onClose?: () => void }

export default function DockPanel({ panel, placement, portal, onPlace, onDrag }: {
  panel: DockPanelDefinition; placement: PanelPlacement; portal?: PanelPortal
  onPlace: (id: PanelId, mode: PanelMode) => void
  onDrag: (id: PanelId, event: MouseEvent<HTMLElement>, resize?: boolean) => void
}) {
  const { t } = useTranslation()
  const native = !!portal
  const mode = native ? 'window' : placement.mode
  return <section className={`dock-panel dock-${panel.id} is-${mode}`} data-panel={panel.id} data-mode={mode}
    style={mode === 'floating' ? { left: placement.bounds.x, top: placement.bounds.y, width: placement.bounds.width, height: placement.bounds.height } : undefined}>
    <header className={`dock-panel-header${native ? ' native-drag' : ''}`} onMouseDown={native ? undefined : event => onDrag(panel.id, event)}>
      <GripHorizontal size={13} /><strong>{panel.title}</strong>
      {panel.toolbar}
      <div className="dock-panel-actions">
        {native ? <>
          <button title={t('dock.return')} aria-label={t('dock.return')} onClick={() => onPlace(panel.id, placement.home)}><PanelRightClose size={13} /></button>
          <button title={t('window.minimize')} aria-label={t('window.minimize')} onClick={() => void window.api.panels.control(portal.key, 'minimize')}><Minus size={13} /></button>
          <button title={t('window.maximize')} aria-label={t('window.maximize')} onClick={() => void window.api.panels.control(portal.key, 'maximize')}><Maximize2 size={12} /></button>
        </> : <button title={t('dock.detach')} aria-label={t('dock.detach')} onClick={() => onPlace(panel.id, 'window')}><ArrowUpRight size={13} /></button>}
        <details className="dock-panel-menu"><summary aria-label={t('dock.layout')} title={t('dock.layout')}><MoreHorizontal size={14} /></summary>
          <div role="menu">{[...DOCK_SIDES, 'floating', 'window'].map(side => <button key={side} role="menuitem" onClick={event => {
            event.currentTarget.closest('details')?.removeAttribute('open'); onPlace(panel.id, side as PanelMode)
          }}>{t(`dock.${side}`)}</button>)}</div>
        </details>
        {(panel.onClose || native) && <button title={t('flow.close')} aria-label={t('flow.close')} onClick={() => {
          if (native) onPlace(panel.id, placement.home)
          else panel.onClose?.()
        }}><X size={13} /></button>}
      </div>
    </header>
    <div className="dock-panel-content">{panel.content}</div>
    {mode === 'floating' && <div className="dock-panel-resize" aria-label={t('dock.resize')} onMouseDown={event => onDrag(panel.id, event, true)} />}
  </section>
}

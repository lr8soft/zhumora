import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from 'lucide-react'
import type { PanelId } from '../../../shared/panels'
import { DOCK_SIDES, type PanelMode } from './layout'
import AnchoredPopover from './AnchoredPopover'

export default function DockPanelMenu({ id, onPlace }: { id: PanelId; onPlace: (id: PanelId, mode: PanelMode) => void }) {
  const { t } = useTranslation()
  const element = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { element.current?.removeAttribute('open'); setOpen(false) }, [])
  return <details className="dock-panel-menu" ref={element} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={t('dock.layout')} title={t('dock.layout')}><MoreHorizontal size={14} /></summary>
    {open && <AnchoredPopover onClose={close}>
      <div role="menu" className="dock-layout-options" data-menu-panel={id}>
        {[...DOCK_SIDES, 'floating', 'window'].map(side => <button key={side} role="menuitem" onClick={() => {
          close(); onPlace(id, side as PanelMode)
        }}>{t(`dock.${side}`)}</button>)}
      </div>
    </AnchoredPopover>}
  </details>
}

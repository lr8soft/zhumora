import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PANEL_IDS, type PanelId } from '../../../shared/panels'
import { useAppStore } from '../store'
import { DOCK_SIDES, initialPanelLayout, placePanel, type PanelBounds, type PanelMode, type DockSide } from './layout'
import { usePanelWindows } from './usePanelWindows'
import { usePanelDrag } from './usePanelDrag'
import { useDockSizes } from './useDockSizes'
import DockPanel, { type DockPanelDefinition } from './DockPanel'
import PanelWindowPortal from './PanelWindowPortal'
import './docking.css'

export default function DockWorkspace({ panels }: { panels: DockPanelDefinition[] }) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState(initialPanelLayout)
  const [activePanel, setActivePanel] = useState<PanelId>('conversation')
  const inputHeight = useAppStore(state => state.inputAreaHeight)
  const saveInputHeight = useAppStore(state => state.setInputAreaHeight)
  const [error, setError] = useState('')
  const restore = useCallback((id: PanelId) => setLayout(previous => placePanel(previous, id, previous[id].home)), [])
  const windows = usePanelWindows(restore)
  const place = useCallback((id: PanelId, mode: PanelMode) => {
    setError('')
    if (mode === 'window') {
      void windows.open(id, panels.find(panel => panel.id === id)!.title).then(() => {
        setLayout(previous => placePanel(previous, id, 'window'))
      }).catch(() => setError(t('dock.windowError')))
    } else {
      windows.close(id)
      setLayout(previous => placePanel(previous, id, mode))
    }
  }, [windows.open, windows.close, panels, t])
  const finish = useCallback((id: PanelId, bounds: PanelBounds, target: DockSide | null) => {
    setLayout(previous => placePanel(previous, id, target ?? 'floating', bounds))
  }, [])
  const { drag, start } = usePanelDrag(host, finish)
  const resizeDock = useCallback((side: DockSide, height: number) => {
    if (side === 'bottom' && layout.composer.mode === 'bottom') saveInputHeight(height - 31)
  }, [layout.composer.mode, saveInputHeight])
  const dockSize = useDockSizes(host, (inputHeight || 200) + 31, resizeDock)
  useEffect(() => {
    for (const id of PANEL_IDS) if (!panels.some(panel => panel.id === id)) windows.close(id)
  }, [panels, windows.close])
  const render = (panel: DockPanelDefinition) => <DockPanel key={panel.id} panel={panel} placement={layout[panel.id]}
    portal={windows.portals[panel.id]} active={activePanel === panel.id} onActivate={setActivePanel} onPlace={place} onDrag={start} />
  const inRegion = (side: DockSide) => panels.filter(panel => layout[panel.id].mode === side)
  return <div className={`dock-workspace${drag ? ' is-dragging' : ''}`} ref={host}>
    <div className="dock-regions" style={{
      gridTemplateColumns: `${inRegion('left').length ? `minmax(220px, min(${dockSize.sizes.left}px, 40%))` : '0px'} minmax(0, 1fr) ${inRegion('right').length ? `minmax(220px, min(${dockSize.sizes.right}px, 40%))` : '0px'}`,
      gridTemplateRows: `${inRegion('top').length ? `minmax(120px, min(${dockSize.sizes.top}px, 60%))` : '0px'} minmax(0, 1fr) ${inRegion('bottom').length ? `minmax(120px, min(${dockSize.sizes.bottom}px, 60%))` : '0px'}`
    }}>{DOCK_SIDES.map(side => <div key={side} className={`dock-region dock-region-${side}`} data-region={side}>
      {inRegion(side).map(render)}
      {side !== 'center' && inRegion(side).length > 0 && <div className={`dock-splitter splitter-${side}`} role="separator"
        aria-label={t('dock.resize')} aria-orientation={side === 'left' || side === 'right' ? 'vertical' : 'horizontal'}
        onMouseDown={event => dockSize.start(side, event)} />}
      {side === 'center' && !inRegion(side).length && <div className="dock-empty"><span>{t('dock.empty')}</span>
        {panels.map(panel => <button key={panel.id} onClick={() => place(panel.id, 'center')}>{t('dock.restore', { title: panel.title })}</button>)}</div>}
    </div>)}</div>
    {panels.filter(panel => layout[panel.id].mode === 'floating').map(render)}
    {panels.filter(panel => layout[panel.id].mode === 'window' && windows.portals[panel.id]).map(panel =>
      <PanelWindowPortal key={panel.id} portal={windows.portals[panel.id]!}>{render(panel)}</PanelWindowPortal>)}
    {drag?.moved && <><div className="dock-drag-preview" style={{ left: drag.bounds.x, top: drag.bounds.y, width: drag.bounds.width, height: drag.bounds.height }} />
      <div className="dock-targets">{DOCK_SIDES.map(side => <div key={side} className={`dock-target target-${side}${drag.target === side ? ' active' : ''}`}>{t(`dock.${side}`)}</div>)}</div></>}
    {error && <div className="dock-error" role="alert">{error}</div>}
  </div>
}

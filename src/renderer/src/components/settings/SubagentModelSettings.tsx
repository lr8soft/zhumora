import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, GripVertical, RefreshCw, X } from 'lucide-react'
import type { AppSettings, ProviderConfig } from '@shared/types'
import type { SubagentModelSelection } from '@shared/subagents'
import { canUseSubagentProvider } from '@shared/providerSubagents'
import { buildSubagentModelOptions } from '../../subagentModelOptions'
import { useSubagentModelCatalog } from './useSubagentModelCatalog'
import './subagentModels.css'

type Routing = Pick<AppSettings, 'subagentModels' | 'subagentDispatch'>
interface Props extends Routing {
  providers: ProviderConfig[]
  enabled: boolean
  onChange: (value: Routing) => void
}
const keyOf = (item: SubagentModelSelection) => JSON.stringify([item.providerId, item.model])

export function SubagentModelSettings({ providers, subagentModels: models, subagentDispatch: dispatch, enabled, onChange }: Props) {
  const { t } = useTranslation()
  const catalog = useSubagentModelCatalog(providers, enabled)
  const [dragged, setDragged] = useState<number | null>(null)
  const options = buildSubagentModelOptions(providers, catalog.models, models)
  const choices = options.filter(option => !option.unavailable && !models.some(item => keyOf(item) === option.value))
  const updateModels = (subagentModels: SubagentModelSelection[]) => onChange({ subagentModels, subagentDispatch: dispatch })
  const move = (from: number, to: number) => {
    if (!enabled || from === to || from < 0 || from >= models.length || to < 0 || to >= models.length) return
    const next = [...models]; const [item] = next.splice(from, 1); next.splice(to, 0, item)
    updateModels(next)
  }
  const addDefaults = () => {
    const next = [...models]
    for (const provider of providers.filter(canUseSubagentProvider)) {
      const item = { providerId: provider.id, model: provider.defaultModel.trim() }
      if (item.model && item.model.length <= 200 && !next.some(other => keyOf(other) === keyOf(item))) next.push(item)
    }
    updateModels(next)
  }
  return <div className="subagent-models">
    <div className="subagent-models-heading"><strong>{t('subagentRouting.title')}</strong>
      <button type="button" className="btn-ghost" disabled={!enabled || catalog.loading} onClick={catalog.refresh}
        title={t('settings.providers.modelRefresh')} aria-label={t('settings.providers.modelRefresh')}><RefreshCw size={14} /></button>
    </div>
    <p className="form-hint">{t('subagentRouting.hint')}</p>
    <label className="subagent-dispatch"><span>{t('subagentRouting.dispatch')}</span>
      <select className="input-field" disabled={!enabled} value={dispatch} aria-label={t('subagentRouting.dispatch')}
        onChange={event => onChange({ subagentModels: models, subagentDispatch: event.target.value === 'spread' ? 'spread' : 'priority' })}>
        <option value="priority">{t('subagentRouting.priority')}</option><option value="spread">{t('subagentRouting.spread')}</option>
      </select>
    </label>
    <p className="form-hint">{t(`subagentRouting.${dispatch}Hint`)}</p>
    {models.length ? <ol className="subagent-priority-list" aria-label={t('subagentRouting.title')}>
      {models.map((item, index) => <li key={keyOf(item)} onDragOver={event => { if (enabled) event.preventDefault() }}
        onDrop={event => { event.preventDefault(); if (dragged !== null) move(dragged, index); setDragged(null) }}>
        <SubagentPriorityRow item={item} provider={providers.find(provider => provider.id === item.providerId)} index={index}
          enabled={enabled} last={index === models.length - 1} move={to => move(index, to)} remove={() => updateModels(models.filter((_, i) => i !== index))}
          onDrag={() => setDragged(index)} onDragEnd={() => setDragged(null)} />
      </li>)}
    </ol> : <p className="subagent-models-empty">{t('subagentRouting.empty')}</p>}
    <div className="subagent-models-add">
      <select className="input-field" disabled={!enabled} value="" onFocus={catalog.request} aria-label={t('subagentRouting.add')}
        onChange={event => { const item = choices.find(option => option.value === event.target.value); if (item) updateModels([...models, { providerId: item.providerId, model: item.model }]) }}>
        <option value="">{t('subagentRouting.add')}</option>
        {[...new Set(choices.map(option => option.providerId))].map(id => <optgroup key={id} label={providers.find(provider => provider.id === id)?.name}>
          {choices.filter(option => option.providerId === id).map(option => <option key={option.value} value={option.value}>{option.model}</option>)}
        </optgroup>)}
      </select>
      <button type="button" className="btn-ghost" disabled={!enabled} onClick={addDefaults}>{t('subagentRouting.addAll')}</button>
    </div>
    {catalog.loading && <p className="form-hint">{t('settings.general.subagentModelsLoading')}</p>}
    {catalog.failed.length > 0 && <p className="form-hint">{t('settings.providers.modelLoadFailed')}: {catalog.failed.map(id => providers.find(provider => provider.id === id)?.name || id).join(', ')}</p>}
  </div>
}

function SubagentPriorityRow({ item, provider, index, enabled, last, move, remove, onDrag, onDragEnd }: {
  item: SubagentModelSelection; provider?: ProviderConfig; index: number; enabled: boolean; last: boolean
  move: (to: number) => void; remove: () => void; onDrag: () => void; onDragEnd: () => void
}) {
  const { t } = useTranslation()
  const available = !!provider && canUseSubagentProvider(provider)
  return <>
    <button type="button" className="subagent-sort-handle" draggable={enabled} disabled={!enabled}
      aria-label={t('subagentRouting.reorder')} title={t('subagentRouting.reorder')}
      onDragStart={event => { event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; onDrag() }} onDragEnd={onDragEnd}>
      <GripVertical size={15} /></button>
    <span className="subagent-priority-number">{index + 1}</span>
    <div className="subagent-priority-name"><strong>{item.model}</strong><small>{provider?.name ?? item.providerId}
      {' · '}{available ? t('subagentRouting.sharedLimit', { limit: provider.maxConcurrency ?? t('subagentRouting.unlimited') }) : t('settings.general.subagentModelUnavailable')}</small></div>
    <div className="subagent-priority-actions">
      <button type="button" disabled={!enabled || index === 0} onClick={() => move(index - 1)} aria-label={t('subagentRouting.up')} title={t('subagentRouting.up')}><ArrowUp size={14} /></button>
      <button type="button" disabled={!enabled || last} onClick={() => move(index + 1)} aria-label={t('subagentRouting.down')} title={t('subagentRouting.down')}><ArrowDown size={14} /></button>
      <button type="button" disabled={!enabled} onClick={remove} aria-label={t('subagentRouting.remove')} title={t('subagentRouting.remove')}><X size={14} /></button>
    </div>
  </>
}

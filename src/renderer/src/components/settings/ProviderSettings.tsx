import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Cpu, Network, Plus, Settings2, Trash2, Users } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'
import { type ProviderHeaderDraft } from './ProviderHeadersField'
import { useProviderContextDetection } from './useProviderContextDetection'
import ProviderConcurrencyField from './ProviderConcurrencyField'
import { ProviderAccessSettings } from './ProviderAccessSettings'
import { ProviderConnectionSettings } from './ProviderConnectionSettings'
import { ProviderModelSettings } from './ProviderModelSettings'
import './providerSettings.css'

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
  headerDrafts: Record<string, ProviderHeaderDraft>
  onHeaderChange: (id: string, text: string) => void
}

export function ProviderSettings({ providers, activeId, onChange, headerDrafts, onHeaderChange }: Props) {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState(activeId)
  const selected = providers.find(p => p.id === selectedId) || providers.find(p => p.id === activeId) || providers[0]
  const detection = useProviderContextDetection({ providers, activeId, onChange })
  const update = (updates: Partial<ProviderConfig>) => {
    onChange(providers.map(p => p.id === selected.id ? { ...p, ...updates } : p), activeId)
  }
  const add = () => {
    const id = `prov-${Date.now()}`
    onChange([...providers, { id, name: 'New Provider', baseUrl: 'https://api.zhuminet.com/v1', apiKey: '',
      headers: {}, defaultModel: '', enabled: true, allowSubagents: true, reasoningEnabled: false,
      reasoningDialect: 'auto', contextWindow: 0, maxConcurrency: null }], activeId || id)
    setSelectedId(id)
  }
  const remove = () => {
    const next = providers.filter(p => p.id !== selected.id)
    onChange(next, selected.id === activeId ? next[0]?.id || null : activeId)
    setSelectedId(next[0]?.id || null)
  }

  return <div className="provider-workspace">
    <div className="provider-intro">
      <p className="form-hint">{t('settings.providers.hint')}</p>
      <button className="btn-ghost" onClick={add}><Plus size={14} />{t('settings.providers.addProvider')}</button>
    </div>
    <div className="provider-layout">
      <nav className="provider-directory" aria-label={t('settings.tabs.providers')}>
        <div className="provider-directory-title"><Settings2 size={14} />{t('settings.tabs.providers')}<span>{providers.length}</span></div>
        {providers.map(p => <button key={p.id} className={`provider-directory-item${p.id === selected?.id ? ' selected' : ''}`}
          aria-pressed={p.id === selected?.id} onClick={() => setSelectedId(p.id)}>
          <span className="provider-directory-name"><span className={`provider-status-dot${p.enabled ? ' enabled' : ''}`} />{p.name}</span>
          <span className="provider-directory-model">{p.defaultModel || t('settings.providers.modelPlaceholder')}</span>
          {activeId === p.id && <span className="provider-badge"><Check size={10} />{t('settings.providers.active')}</span>}
        </button>)}
        <div className="provider-service-note"><strong>煮米 API</strong><p>{t('settings.providers.zhuminetBanner')}</p>
          <button className="link-button" onClick={() => window.api.settings.openExternal('https://api.zhuminet.com/')}>
            {t('settings.providers.zhuminetRegister')}</button>
        </div>
      </nav>
      {selected ? <div className="provider-editor" key={selected.id}>
        <header className="provider-editor-header">
          <div><h3>{selected.name}</h3><p>{selected.defaultModel || t('settings.providers.modelPlaceholder')}</p></div>
          <div className="provider-editor-actions">
            <button className="btn-ghost" disabled={activeId === selected.id || !selected.enabled}
              onClick={() => onChange(providers, selected.id)}>
              {activeId === selected.id && <Check size={13} />}{t(activeId === selected.id ? 'settings.providers.active' : 'settings.providers.activate')}
            </button>
            <button className="provider-remove icon-button" onClick={remove} aria-label={t('settings.providers.remove')} title={t('settings.providers.remove')}>
              <Trash2 size={15} /></button>
          </div>
        </header>
        <div className="provider-function-grid">
          <section className="provider-function-section provider-connection">
            <h4><Network size={16} />{t('settings.providers.sections.connection')}</h4>
            <ProviderConnectionSettings provider={selected} draft={headerDrafts[selected.id]} onChange={update}
              onHeaderChange={text => onHeaderChange(selected.id, text)} onDetect={detection.detectContextWindow} />
          </section>
          <section className="provider-function-section provider-generation">
            <h4><Cpu size={16} />{t('settings.providers.sections.generation')}</h4>
            <ProviderModelSettings provider={selected} onChange={update} detectContextWindow={detection.detectContextWindow}
              capability={detection.reasoningCapabilities[selected.id]} detecting={detection.detecting[selected.id]} detected={detection.detected[selected.id]} />
          </section>
          <section className="provider-function-section provider-execution">
            <h4><Users size={16} />{t('settings.providers.sections.execution')}</h4>
            <div className="provider-execution-grid">
              <ProviderAccessSettings provider={selected} onChange={update} />
              <ProviderConcurrencyField id={selected.id} value={selected.maxConcurrency} onChange={value => update({ maxConcurrency: value })} />
            </div>
          </section>
        </div>
      </div> : <div className="provider-empty"><Network size={28} /><p>{t('settings.providers.empty')}</p>
        <button className="btn-ghost" onClick={add}><Plus size={14} />{t('settings.providers.addProvider')}</button></div>}
    </div>
  </div>
}

import { useTranslation } from 'react-i18next'
import { Repeat, Workflow } from 'lucide-react'
import { useAppStore } from '../../store'
import { SubagentModelSettings } from './SubagentModelSettings'

export function AgentBehaviorSettings() {
  const { t } = useTranslation()
  const settingsDraft = useAppStore(state => state.settingsDraft)
  const updateSettingsDraft = useAppStore(state => state.updateSettingsDraft)
  const isRoundsUnlimited = (settingsDraft.maxRounds ?? 20) === 0
  return (
    <section className="settings-section">
        <div className="settings-section-title">
          <Repeat size={16} />
          <div>
            <h3>{t('settings.general.agent')}</h3>
            <p>{t('settings.general.agentHint')}</p>
          </div>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label" htmlFor="max-rounds-input">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Workflow size={13} />
              {t('settings.general.maxRounds')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <input
              id="max-rounds-input"
              className="input-field"
              type="number"
              min={1}
              max={999}
              style={{ width: 90 }}
              value={isRoundsUnlimited ? '' : (settingsDraft.maxRounds ?? 20)}
              disabled={isRoundsUnlimited}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                updateSettingsDraft({ maxRounds: Number.isFinite(v) ? Math.max(1, Math.min(999, v)) : 20 })
              }}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--app-color-text-soft)', fontSize: '0.8rem' }}>
              <input
                type="checkbox"
                checked={isRoundsUnlimited}
                onChange={(e) => updateSettingsDraft({ maxRounds: e.target.checked ? 0 : 20 })}
              />
              {t('settings.general.roundsUnlimited')}
            </label>
          </div>
          <p className="form-hint">{t('settings.general.maxRoundsHint')}</p>
        </div>
        <div className="switch-row" style={{ marginTop: 16 }}>
          <div>
            <strong>{t('settings.general.subagents')}</strong>
            <small>{t('settings.general.subagentsHint')}</small>
          </div>
          <input id="subagents-enabled" type="checkbox" className="switch"
            aria-label={t('settings.general.subagents')}
            checked={settingsDraft.subagentsEnabled}
            onChange={event => updateSettingsDraft({ subagentsEnabled: event.target.checked })} />
        </div>
        <SubagentModelSettings providers={settingsDraft.providers} selection={settingsDraft.subagentModel}
          enabled={settingsDraft.subagentsEnabled} onChange={subagentModel => updateSettingsDraft({ subagentModel })} />
      </section>
  )
}

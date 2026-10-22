import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ProviderConfig, ReasoningCapability } from '@shared/types'
import type { ReasoningDialect } from '@shared/reasoning'
import { TEMPERATURE_MAX, TEMPERATURE_MIN, TEMPERATURE_STEP, TemperatureInput } from './TemperatureInput'
import { ProviderModelPicker } from './ProviderModelPicker'

/**
 * 端点能力声明 → i18n key。
 * "未声明"与"声明不支持"必须区分：前者是 vLLM / SGLang / LiteLLM 的常态
 * （仍会收到标准参数），不代表配置有问题。
 */
function reasoningCapabilityHintKey(capability: ReasoningCapability): string {
  if (capability.declaresSupport === true) return 'settings.providers.reasoningCapability.supported'
  if (capability.declaresSupport === false) return 'settings.providers.reasoningCapability.unsupported'
  return 'settings.providers.reasoningCapability.unknown'
}

export function ProviderModelSettings({ provider: p, onChange, detectContextWindow, capability, detecting, detected }: {
  provider: ProviderConfig
  onChange: (value: Partial<ProviderConfig>) => void
  detectContextWindow: (provider: ProviderConfig, requested?: boolean) => Promise<void>
  capability?: ReasoningCapability
  detecting?: boolean
  detected?: number
}) {
  const { t } = useTranslation()
  return <div className="provider-model-settings">
    <ProviderModelPicker provider={p} onChange={onChange} detectContextWindow={detectContextWindow} />
    <div className="provider-block">
      <label className="provider-block-toggle"><input type="checkbox" className="switch"
        checked={p.captureResponses === true} onChange={e => onChange({ captureResponses: e.target.checked })} />
        <span className="form-label">{t('settings.providers.captureResponses')}</span></label>
      <p className="form-hint">{t('settings.providers.captureResponsesHint')}</p>
      <label className="form-label">{t('settings.providers.reasoningHistory')}</label>
      <select className="input-field" value={p.reasoningHistory ?? 'auto'}
        onChange={e => onChange({ reasoningHistory: e.target.value as ProviderConfig['reasoningHistory'] })}>
        {(['auto', 'omit', 'preserve'] as const).map(value => <option key={value} value={value}>
          {t('settings.providers.reasoningHistory_' + value)}</option>)}
      </select>
      <label className="form-label">{t('settings.providers.outputTokenParameter')}</label>
      <select className="input-field" value={p.outputTokenParameter ?? 'auto'}
        onChange={e => onChange({ outputTokenParameter: e.target.value as ProviderConfig['outputTokenParameter'] })}>
        {(['auto', 'max_tokens', 'max_completion_tokens'] as const).map(value => <option key={value} value={value}>
          {value === 'auto' ? t('settings.providers.outputTokenParameterAuto') : value}</option>)}
      </select>
      <p className="form-hint">{t('settings.providers.outputTokenParameterHint')}</p>
    </div>
    <div>
          <div className="provider-temperature">
            <label className="form-label">{t('settings.providers.temperature')}{p.temperature === undefined && ` (${t('settings.providers.temperatureDefault')})`}</label>
            <input
              type="range"
              min={TEMPERATURE_MIN}
              max={TEMPERATURE_MAX}
              step={TEMPERATURE_STEP}
              value={p.temperature ?? 1}
              onChange={(e) => onChange({ temperature: parseFloat(e.target.value) })}
              className="range-input"
            />
            <TemperatureInput
              value={p.temperature ?? 1}
              disabled={p.temperature === undefined}
              onCommit={(v) => onChange({ temperature: v })}
            />
            <button
              onClick={() => onChange({ temperature: undefined })}
              className="link-button"
            >
              {t('settings.providers.temperatureReset')}
            </button>
          </div>
          <p className="form-hint" style={{ marginTop: 6 }}>{t('settings.providers.temperatureHint')}</p>
    </div>

          <div className="provider-block">
            <label className="provider-block-toggle">
              <input
                type="checkbox"
                className="switch"
                checked={p.reasoningEnabled || false}
                onChange={(e) => onChange({ reasoningEnabled: e.target.checked })}
              />
              <span className="form-label">{t('settings.providers.reasoningEffort')}</span>
            </label>
            <p className="form-hint">{t('settings.providers.reasoningEnabledHint')}</p>
            <details className="provider-disclosure">
              <summary>{t('settings.providers.reasoningDialect')}</summary>
            {capability && (
              <p className="form-hint">{t(reasoningCapabilityHintKey(capability))}</p>
            )}
            <div className="provider-block-field">
              <label className="form-label" htmlFor={`provider-dialect-${p.id}`}>{t('settings.providers.reasoningDialect')}</label>
              <select
                id={`provider-dialect-${p.id}`}
                className="input-field"
                value={p.reasoningDialect || 'auto'}
                onChange={(e) => onChange({ reasoningDialect: e.target.value as ReasoningDialect })}
              >
                <option value="auto">{t('settings.providers.reasoningDialectAuto')}</option>
                <option value="openai">{t('settings.providers.reasoningDialectOpenai')}</option>
                <option value="deepseek">{t('settings.providers.reasoningDialectDeepseek')}</option>
                <option value="qwen">{t('settings.providers.reasoningDialectQwen')}</option>
              </select>
            </div>
            <p className="form-hint">{t('settings.providers.reasoningDialectHint')}</p>
            </details>
          </div>

    <div>
          <div className="provider-context">
            <label className="form-label" htmlFor={`provider-context-${p.id}`}>{t('settings.providers.contextWindow')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <input
                type="number"
                id={`provider-context-${p.id}`}
                className="input-field"
                style={{ flex: 1, minWidth: 0, width: 'auto' }}
                value={p.contextWindow || 0}
                min={0}
                step={1024}
                onChange={(e) => onChange({ contextWindow: parseInt(e.target.value) || 0 })}
                placeholder="0"
              />
              {detected !== undefined && detected > 0 && (
                <span className="form-hint" style={{ whiteSpace: 'nowrap', flex: 'none' }}>
                  {t('settings.providers.contextWindowDetected')}: {detected.toLocaleString()}
                </span>
              )}
              {detecting && <Loader2 size={13} className="spin" style={{ flex: 'none' }} />}
              <button
                onClick={() => void detectContextWindow(p, true)}
                className="link-button"
                title={t('settings.providers.contextWindowDetect')}
                style={{ whiteSpace: 'nowrap', flex: 'none' }}
              >
                <RefreshCw size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
                {t('settings.providers.contextWindowAuto')}
              </button>
            </div>
          </div>
          <p className="form-hint" style={{ marginTop: 6 }}>{t('settings.providers.contextWindowHint')}</p>
    </div>
  </div>
}

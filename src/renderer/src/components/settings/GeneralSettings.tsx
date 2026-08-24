import { useTranslation } from 'react-i18next'
import { Brain, Check, FolderOpen, Globe, Monitor, Moon, RefreshCw, Repeat, ShieldCheck, Sun, Type, Wifi, Workflow } from 'lucide-react'
import { SUPPORTED_LANGUAGES, type AppLanguage, getEffectiveLanguage, storeLanguage } from '../../i18n'
import { useAppStore, FONT_SIZE_OPTIONS, type Theme } from '../../store'

const THEME_OPTIONS: { value: Theme; icon: typeof Sun; labelKey: string }[] = [
  { value: 'system', icon: Monitor, labelKey: 'settings.general.themeSystem' },
  { value: 'light', icon: Sun, labelKey: 'settings.general.themeLight' },
  { value: 'dark', icon: Moon, labelKey: 'settings.general.themeDark' }
]

export function GeneralSettings() {
  const { t, i18n } = useTranslation()
  // 草稿模式：所有设置改动都写入草稿（Save 才入库）；
  // 主题/字号/语言同时即时预览（Cancel 时由 store 恢复基线快照）
  const { settingsDraft, updateSettingsDraft, theme, setTheme, fontSize, setFontSize } = useAppStore()
  const isUnlimited = (settingsDraft.maxRetries ?? 5) === -1
  const isRoundsUnlimited = (settingsDraft.maxRounds ?? 20) === 0

  const pickDir = async () => {
    const dir = await window.api.settings.pickDirectory()
    if (dir) updateSettingsDraft({ workspacePath: dir })
  }

  /** 主题：即时预览 + 写草稿（纳入 dirty/保存/取消语义） */
  const changeTheme = (value: Theme) => {
    setTheme(value)
    updateSettingsDraft({ theme: value })
  }

  /** 字号：即时预览 + 写草稿 */
  const changeFontSize = (px: number) => {
    setFontSize(px)
    updateSettingsDraft({ fontSize: px })
  }

  const handleLanguageChange = (lang: AppLanguage) => {
    updateSettingsDraft({ language: lang })
    // 即时预览：立即切换界面语言（取消时恢复）
    const effective = getEffectiveLanguage(lang)
    storeLanguage(lang)
    i18n.changeLanguage(effective)
  }

  return (
    <div>
      {/* 外观：主题 + 字号 */}
      <section className="settings-section">
        <div className="settings-section-title">
          <Sun size={16} />
          <div>
            <h3>{t('settings.general.appearance')}</h3>
            <p>{t('settings.general.appearanceHint')}</p>
          </div>
        </div>

        <div className="form-field">
          <span className="form-label">{t('settings.general.theme')}</span>
          <div className="theme-choice-grid" role="radiogroup" aria-label={t('settings.general.theme')}>
            {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                className={theme === value ? 'active' : ''}
                onClick={() => changeTheme(value)}
              >
                <Icon size={15} />
                {t(labelKey)}
                {theme === value && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label" htmlFor="font-size-select">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Type size={13} />
              {t('settings.general.fontSize')}
            </span>
          </label>
          <select
            id="font-size-select"
            className="input-field"
            value={fontSize}
            onChange={(e) => changeFontSize(parseInt(e.target.value, 10))}
          >
            {FONT_SIZE_OPTIONS.map(px => (
              <option key={px} value={px}>{t('settings.general.fontSizeOption', { px })}</option>
            ))}
          </select>
          <p className="form-hint">{t('settings.general.fontSizeHint')}</p>
        </div>
      </section>

      {/* 语言 */}
      <section className="settings-section">
        <div className="settings-section-title">
          <Globe size={16} />
          <div>
            <h3>{t('settings.general.language')}</h3>
            <p>{t('settings.general.languageHint')}</p>
          </div>
        </div>
        <select
          className="input-field"
          value={settingsDraft.language || 'auto'}
          onChange={(e) => handleLanguageChange(e.target.value as AppLanguage)}
        >
          {SUPPORTED_LANGUAGES.map(lang => (
            <option key={lang.code} value={lang.code}>
              {lang.code === 'auto' ? t('settings.general.autoDetect') : lang.nativeLabel}
            </option>
          ))}
        </select>
      </section>

      {/* 网络重试 */}
      <section className="settings-section">
        <div className="settings-section-title">
          <Wifi size={16} />
          <div>
            <h3>{t('settings.general.network')}</h3>
            <p>{t('settings.general.networkHint')}</p>
          </div>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label" htmlFor="max-retries-input">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={13} />
              {t('settings.general.maxRetries')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <input
              id="max-retries-input"
              className="input-field"
              type="number"
              min={0}
              max={99}
              style={{ width: 90 }}
              value={isUnlimited ? '' : (settingsDraft.maxRetries ?? 5)}
              disabled={isUnlimited}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                updateSettingsDraft({ maxRetries: Number.isFinite(v) ? Math.max(0, Math.min(99, v)) : 5 })
              }}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--app-color-text-soft)', fontSize: '0.8rem' }}>
              <input
                type="checkbox"
                checked={isUnlimited}
                onChange={(e) => updateSettingsDraft({ maxRetries: e.target.checked ? -1 : 5 })}
              />
              {t('settings.general.retriesUnlimited')}
            </label>
          </div>
          <p className="form-hint">{t('settings.general.maxRetriesHint')}</p>
        </div>

        <div className="switch-row" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <ShieldCheck size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <div>
              <strong>{t('settings.general.systemCerts')}</strong>
              <small>{t('settings.general.systemCertsHint')}</small>
            </div>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={settingsDraft.useSystemCerts === true}
            onChange={(e) => updateSettingsDraft({ useSystemCerts: e.target.checked })}
          />
        </div>
      </section>

      {/* Agent 行为 */}
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
      </section>

      {/* 长期记忆 */}
      <section className="settings-section">
        <div className="switch-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Brain size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <div>
              <strong>{t('settings.general.memory')}</strong>
              <small>{t('settings.general.memoryHint')}</small>
            </div>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={settingsDraft.memoryEnabled !== false}
            onChange={(e) => updateSettingsDraft({ memoryEnabled: e.target.checked })}
          />
        </div>
      </section>

      {/* 工作目录 */}
      <section className="settings-section">
        <div className="settings-section-title">
          <FolderOpen size={16} />
          <div>
            <h3>{t('settings.general.workspacePath')}</h3>
            <p>{t('settings.general.workspaceHint')}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input-field mono"
            style={{ flex: 1 }}
            value={settingsDraft.workspacePath}
            onChange={(e) => updateSettingsDraft({ workspacePath: e.target.value })}
          />
          <button onClick={pickDir} className="btn-ghost">{t('settings.general.browse')}</button>
        </div>
      </section>
    </div>
  )
}

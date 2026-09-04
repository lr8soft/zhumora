import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Brain, Cable, Send, Server, Settings2, Sparkles } from 'lucide-react'
import { useAppStore } from '../store'
import { ProviderSettings } from './settings/ProviderSettings'
import { McpSettings } from './settings/McpSettings'
import { SkillSettings } from './settings/SkillSettings'
import { MemorySettings } from './settings/MemorySettings'
import { UsageSettings } from './settings/UsageSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { TelegramSettings } from './settings/TelegramSettings'
import { QQSettings } from './settings/QQSettings'

type Tab = 'providers' | 'mcp' | 'bots' | 'skills' | 'memory' | 'usage' | 'general'

const TAB_ICONS: Record<Tab, typeof Server> = {
  providers: Server,
  mcp: Cable,
  bots: Send,
  skills: Sparkles,
  memory: Brain,
  usage: BarChart3,
  general: Settings2
}

export default function SettingsView() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('providers')
  // 设置页只操作草稿；Save 写库、Cancel 丢弃（草稿模式，避免"改一个字就入库"）
  const { settingsDraft, isSettingsDirty, openSettings, saveSettings, cancelSettings, setView } = useAppStore()

  // 进入设置页时初始化草稿（每次 mount 都刷新一次，防止上次未保存的草稿残留）
  useEffect(() => {
    openSettings()
  }, [openSettings])

  const tabs: Tab[] = ['providers', 'mcp', 'bots', 'skills', 'memory', 'usage', 'general']

  const handleSave = async () => {
    await saveSettings()
    // 保存成功后回到聊天页（与旧行为一致）
    setView('chat')
  }

  const handleCancel = () => {
    cancelSettings()
    setView('chat')
  }

  return (
    <div className="settings-view">
      <div className="settings-page">
        <h1 className="settings-page-title">{t('settings.title')}</h1>

        {/* 标签页 */}
        <div className="settings-tabs" role="tablist">
          {tabs.map((tb) => {
            const Icon = TAB_ICONS[tb]
            return (
              <button
                key={tb}
                className={tab === tb ? 'active' : ''}
                onClick={() => setTab(tb)}
                role="tab"
                aria-selected={tab === tb}
              >
                <Icon size={14} />
                {t(`settings.tabs.${tb}`)}
              </button>
            )
          })}
        </div>

        {/* 内容（全部绑定草稿） */}
        {tab === 'providers' && <ProviderSettings
          providers={settingsDraft.providers}
          activeId={settingsDraft.activeProviderId}
          onChange={(providers, activeId) => useAppStore.getState().updateSettingsDraft({ providers, activeProviderId: activeId })}
        />}
        {tab === 'mcp' && <McpSettings
          servers={settingsDraft.mcpServers}
          onChange={(mcpServers) => useAppStore.getState().updateSettingsDraft({ mcpServers })}
        />}
        {tab === 'bots' && <div style={{ display: 'grid', gap: 18 }}>
          <TelegramSettings
            config={settingsDraft.telegramBot}
            onChange={(telegramBot) => useAppStore.getState().updateSettingsDraft({ telegramBot })}
          />
          <QQSettings
            config={settingsDraft.qqBot}
            onChange={(qqBot) => useAppStore.getState().updateSettingsDraft({ qqBot })}
          />
        </div>}
        {tab === 'skills' && <SkillSettings
          skills={settingsDraft.skills}
          onChange={(skills) => useAppStore.getState().updateSettingsDraft({ skills })}
        />}
        {tab === 'memory' && <MemorySettings />}
        {tab === 'usage' && <UsageSettings />}
        {tab === 'general' && <GeneralSettings />}

        {/* 保存 / 取消 */}
        <div className="settings-footer">
          {isSettingsDirty && <span className="settings-dirty-hint">{t('settings.unsaved')}</span>}
          <button className="btn-ghost" onClick={handleCancel}>
            {t('settings.cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={!isSettingsDirty}
          >
            {t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

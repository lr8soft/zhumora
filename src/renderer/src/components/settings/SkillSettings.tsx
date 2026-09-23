import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Folder, Trash2 } from 'lucide-react'
import type { SkillConfig } from '@shared/types'

interface Props {
  skills: SkillConfig[]
  onChange: (skills: SkillConfig[]) => void
}

export function SkillSettings({ skills, onChange }: Props) {
  const { t } = useTranslation()
  const [addError, setAddError] = useState('')

  const addSkill = async (pick: () => Promise<string | null>) => {
    setAddError('')
    const p = await pick()
    if (!p) return
    const inspection = await window.api.skill.inspectPath(p)
    if (!inspection) {
      setAddError(t('settings.skills.invalidPath'))
      return
    }
    if (!inspection.valid) {
      setAddError(inspection.error || t('settings.skills.invalidPath'))
      return
    }
    if (skills.some(s => s.name === inspection.name)) {
      setAddError(t('settings.skills.duplicate', { name: inspection.name }))
      return
    }
    onChange([
      ...skills,
      {
        id: `skill-${Date.now()}`,
        name: inspection.name,
        path: p,
        enabled: true
      }
    ])
  }

  const removeSkill = (idx: number) => {
    setAddError('')
    onChange(skills.filter((_, i) => i !== idx))
  }

  const toggleSkill = (idx: number) => {
    const next = [...skills]
    next[idx] = { ...next[idx], enabled: !next[idx].enabled }
    onChange(next)
  }

  const isDir = (p: string) => p.toLowerCase().endsWith('.md') === false

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.skills.hint')}</p>

      {skills.map((s, i) => (
        <div key={s.id} className="memory-card">
          <div className="memory-card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              {isDir(s.path)
                ? <Folder size={15} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
                : <FileText size={15} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />}
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '0.867rem', fontWeight: 650 }}>{s.name}</p>
                <p className="form-hint" style={{ fontFamily: 'Consolas, Monaco, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
                  {s.path}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  className="switch"
                  checked={s.enabled}
                  onChange={() => toggleSkill(i)}
                />
                <span className="form-label">{s.enabled ? t('settings.skills.on') : t('settings.skills.off')}</span>
              </label>
              <button onClick={() => removeSkill(i)} className="danger-link">
                <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                {t('settings.skills.remove')}
              </button>
            </div>
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={() => addSkill(() => window.api.settings.pickDirectory())} className="btn-ghost" style={{ flex: 1 }}>
          <Folder size={14} />
          {t('settings.skills.addFolder')}
        </button>
        <button onClick={() => addSkill(() => window.api.settings.pickFile())} className="btn-ghost" style={{ flex: 1 }}>
          <FileText size={14} />
          {t('settings.skills.addFile')}
        </button>
      </div>
      {addError && (
        <p className="form-hint" style={{ marginTop: 8, color: 'var(--app-color-danger, #d66)', whiteSpace: 'pre-wrap' }}>
          {addError}
        </p>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { AutoApproveMode } from '@shared/types'
import type { NewScheduledJobInput, ScheduledJobView, ScheduledRun, Schedule } from '@shared/scheduled'

type DraftSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'interval'; minutes: number }

interface JobDraft {
  name: string
  kind: 'cron' | 'heartbeat'
  schedule: DraftSchedule
  prompt: string
  approveMode: AutoApproveMode
  catchUp: boolean
}

const EMPTY_DRAFT: JobDraft = {
  name: '',
  kind: 'cron',
  schedule: { kind: 'daily', time: '09:00' },
  prompt: '',
  approveMode: 'auto',
  catchUp: false
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function ScheduledSettings() {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<ScheduledJobView[]>([])
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState<JobDraft>(EMPTY_DRAFT)
  const [runsFor, setRunsFor] = useState<string | null>(null)
  const [runs, setRuns] = useState<ScheduledRun[]>([])
  const [error, setError] = useState<string | null>(null)

  const loadJobs = async () => {
    const list = await window.api.scheduled.list()
    setJobs(list as ScheduledJobView[])
  }

  useEffect(() => {
    void loadJobs()
  }, [])

  const loadRuns = async (jobId: string) => {
    const result = await window.api.scheduled.runs(jobId, 20)
    setRuns(result as ScheduledRun[])
  }

  const toggleRuns = async (jobId: string) => {
    if (runsFor === jobId) {
      setRunsFor(null)
      return
    }
    setRunsFor(jobId)
    await loadRuns(jobId)
  }

  const handleCreate = async () => {
    setError(null)
    const payload: NewScheduledJobInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      schedule: draft.schedule as Schedule,
      prompt: draft.kind === 'cron' ? draft.prompt.trim() : null,
      approveMode: draft.approveMode,
      providerId: null,
      maxRounds: null,
      quietHours: null,
      catchUp: draft.catchUp,
      timeoutMs: 30 * 60 * 1000
    }
    const result = await window.api.scheduled.create(payload)
    if (result.error) {
      setError(result.error)
      return
    }
    setDraft(EMPTY_DRAFT)
    setShowForm(false)
    await loadJobs()
  }

  const handleToggle = async (job: ScheduledJobView) => {
    await window.api.scheduled.toggle(job.id, !job.enabled)
    await loadJobs()
  }

  const handleRunNow = async (jobId: string) => {
    await window.api.scheduled.runNow(jobId)
    await loadJobs()
  }

  const handleDelete = async (job: ScheduledJobView) => {
    if (!window.confirm(t('settings.scheduled.deleteConfirm'))) return
    await window.api.scheduled.remove(job.id)
    if (runsFor === job.id) setRunsFor(null)
    await loadJobs()
  }

  const describeSchedule = (job: ScheduledJobView): string => {
    const s = job.schedule
    if (s.kind === 'daily') return t('settings.scheduled.daily', { time: s.time })
    if (s.kind === 'weekly') return t('settings.scheduled.weekly', { day: WEEKDAYS[s.weekday], time: s.time })
    return t('settings.scheduled.every', { minutes: s.minutes })
  }

  return (
    <div>
      <div className="memory-toolbar">
        <p className="form-hint">{t('settings.scheduled.hint')}</p>
        <button onClick={() => { setDraft(EMPTY_DRAFT); setShowForm(v => !v) }} className="btn-ghost btn-sm">
          <Plus size={13} />
          {t('settings.scheduled.add')}
        </button>
      </div>

      {error && <p className="form-hint" style={{ color: 'var(--app-color-danger)' }}>{error}</p>}

      {showForm && (
        <div className="settings-section" style={{ marginTop: 12 }}>
          <div className="settings-section-title">
            <Clock size={16} />
            <h3>{t('settings.scheduled.new')}</h3>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label className="form-label">{t('settings.scheduled.name')}</label>
              <input
                className="input-field"
                value={draft.name}
                maxLength={80}
                placeholder={t('settings.scheduled.namePlaceholder')}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label className="form-label">{t('settings.scheduled.type')}</label>
              <select
                className="input-field"
                value={draft.kind}
                onChange={e => setDraft(d => ({ ...d, kind: e.target.value as 'cron' | 'heartbeat' }))}
              >
                <option value="cron">{t('settings.scheduled.cron')}</option>
                <option value="heartbeat">{t('settings.scheduled.heartbeat')}</option>
              </select>
            </div>
            <div className="form-field">
              <label className="form-label">{t('settings.scheduled.when')}</label>
              <select
                className="input-field"
                value={draft.schedule.kind}
                onChange={e => {
                  const kind = e.target.value as 'daily' | 'weekly' | 'interval'
                  if (kind === 'interval') setDraft(d => ({ ...d, schedule: { kind, minutes: 30 } }))
                  else if (kind === 'weekly') setDraft(d => ({ ...d, schedule: { kind, weekday: 1, time: '09:00' } }))
                  else setDraft(d => ({ ...d, schedule: { kind, time: '09:00' } }))
                }}
              >
                <option value="daily">{t('settings.scheduled.optDaily')}</option>
                <option value="weekly">{t('settings.scheduled.optWeekly')}</option>
                <option value="interval">{t('settings.scheduled.optInterval')}</option>
              </select>
            </div>
            {draft.schedule.kind === 'interval' ? (
              <div className="form-field">
                <label className="form-label">{t('settings.scheduled.intervalMinutes')}</label>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  value={draft.schedule.minutes}
                  onChange={e => setDraft(d => ({ ...d, schedule: { kind: 'interval', minutes: Math.max(1, Number(e.target.value) || 1) } }))}
                />
              </div>
            ) : (
              <div className="form-field">
                <label className="form-label">{t('settings.scheduled.time')}</label>
                <input
                  className="input-field"
                  type="time"
                  value={draft.schedule.time}
                  onChange={e => setDraft(d => ({ ...d, schedule: { ...d.schedule, time: e.target.value } as DraftSchedule }))}
                />
              </div>
            )}
            {draft.schedule.kind === 'weekly' && (
              <div className="form-field">
                <label className="form-label">{t('settings.scheduled.weekday')}</label>
                <select
                  className="input-field"
                  value={draft.schedule.weekday}
                  onChange={e => setDraft(d => ({ ...d, schedule: { ...d.schedule, weekday: Number(e.target.value) } as DraftSchedule }))}
                >
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i}>{w}</option>
                  ))}
                </select>
              </div>
            )}
            {draft.kind === 'cron' && (
              <div className="form-field span-2">
                <label className="form-label">{t('settings.scheduled.prompt')}</label>
                <textarea
                  className="input-field"
                  value={draft.prompt}
                  placeholder={t('settings.scheduled.promptPlaceholder')}
                  onChange={e => setDraft(d => ({ ...d, prompt: e.target.value }))}
                />
              </div>
            )}
            <div className="form-field">
              <label className="form-label">{t('settings.scheduled.approveMode')}</label>
              <select
                className="input-field"
                value={draft.approveMode}
                onChange={e => setDraft(d => ({ ...d, approveMode: e.target.value as AutoApproveMode }))}
              >
                <option value="manual">{t('chat.approveManual')}</option>
                <option value="auto">{t('chat.approveAuto')}</option>
                <option value="full">{t('chat.approveFull')}</option>
              </select>
            </div>
            <div className="switch-row form-field">
              <div>
                <strong>{t('settings.scheduled.catchUp')}</strong>
                <small>{t('settings.scheduled.catchUpHint')}</small>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={draft.catchUp}
                onChange={e => setDraft(d => ({ ...d, catchUp: e.target.checked }))}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>{t('settings.cancel')}</button>
            <button className="btn-primary" onClick={handleCreate} disabled={!draft.name.trim() || (draft.kind === 'cron' && !draft.prompt.trim())}>
              {t('settings.scheduled.create')}
            </button>
          </div>
        </div>
      )}

      {jobs.length === 0 && !showForm ? (
        <div className="memory-empty">{t('settings.scheduled.empty')}</div>
      ) : (
        jobs.map(job => (
          <div key={job.id} className="memory-card">
            <div className="memory-card-head">
              <div className="memory-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 650 }}>{job.name}</span>
                <span className={`memory-category ${job.kind === 'heartbeat' ? 'skill' : 'context'}`}>
                  <span className="dot" />
                  {job.kind === 'heartbeat' ? t('settings.scheduled.heartbeat') : t('settings.scheduled.cron')}
                </span>
                <span className="form-hint" style={{ margin: 0 }}>{describeSchedule(job)}</span>
                {job.running && <span className="form-hint" style={{ color: 'var(--app-color-primary-strong)' }}>· {t('settings.scheduled.running')}</span>}
                {job.autoDisabled && <span className="form-hint" style={{ color: 'var(--app-color-danger)' }}>· {t('settings.scheduled.autoDisabled')}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button className="icon-button" title={t('settings.scheduled.runNow')} onClick={() => handleRunNow(job.id)}>
                  <Play size={14} />
                </button>
                <button className="icon-button" title={t('settings.scheduled.history')} onClick={() => toggleRuns(job.id)}>
                  <RotateCcw size={14} />
                </button>
                <button className="danger-link" onClick={() => handleDelete(job)}>
                  <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                  {t('settings.scheduled.delete')}
                </button>
                <input
                  type="checkbox"
                  className="switch"
                  checked={job.enabled}
                  onChange={() => handleToggle(job)}
                  title={job.enabled ? t('settings.scheduled.disable') : t('settings.scheduled.enable')}
                />
              </div>
            </div>
            {job.lastRun && (
              <div className="memory-foot">
                <span>{t(`settings.scheduled.status.${job.lastRun.status}`)}</span>
                <span>{job.lastRun.summary || job.lastRun.error || ''}</span>
                {job.lastRun.finishedAt && <span>{new Date(job.lastRun.finishedAt).toLocaleString()}</span>}
              </div>
            )}
            {runsFor === job.id && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--app-color-border)', paddingTop: 10 }}>
                {runs.length === 0 ? (
                  <p className="form-hint">{t('settings.scheduled.noRuns')}</p>
                ) : (
                  runs.map(r => (
                    <div key={r.id} className="form-hint" style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
                      <span style={{ color: 'var(--app-color-text-mute)' }}>{new Date(r.startedAt).toLocaleString()}</span>
                      <span style={{ color: statusColor(r.status) }}>{t(`settings.scheduled.status.${r.status}`)}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary || r.error || ''}</span>
                      {(r.inputTokens > 0 || r.outputTokens > 0) && (
                        <span style={{ color: 'var(--app-color-text-mute)' }}>{r.inputTokens + r.outputTokens} tok</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function statusColor(status: string): string {
  if (status === 'ok' || status === 'silent') return 'var(--app-color-primary-strong)'
  if (status === 'error') return 'var(--app-color-danger)'
  return 'var(--app-color-text-mute)'
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Minus, Square, X } from 'lucide-react'

/** Controls overlay the existing app header; there is no extra titlebar row. Main still owns close/hide semantics. */
export default function WindowControls() {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="window-controls">
        <button
          title={t('window.minimize')}
          aria-label={t('window.minimize')}
          onClick={() => void window.api.window.minimize()}
        >
          <Minus size={16} />
        </button>
        <button
          title={maximized ? t('window.restore') : t('window.maximize')}
          aria-label={maximized ? t('window.restore') : t('window.maximize')}
          onClick={() => void window.api.window.toggleMaximize()}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="window-close"
          title={t('window.close')}
          aria-label={t('window.close')}
          onClick={() => void window.api.window.close()}
        >
          <X size={16} />
        </button>
    </div>
  )
}

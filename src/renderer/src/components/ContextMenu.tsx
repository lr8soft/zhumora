import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Scissors, ClipboardPaste, ListChecks } from 'lucide-react'

// ============================================================
// 全局右键菜单
//
// - 输入框（textarea / contenteditable）上右键：复制/剪切/粘贴/全选（有选区时"全选"变为"选择整条消息"）
// - 只读区选中文本后右键：复制/选择整条消息（选中落在消息气泡内时）
// 其余情况一律不 preventDefault → 回退 Chromium 原生菜单。
//
// 实现要点：
// - 选区检测：textarea/input 的选区不暴露在 window.getSelection()，
//   必须读 selectionStart/End；contenteditable / 文档选区用 Selection API。
// - 选区快照：菜单打开时快照选区（焦点变化 / 按钮 mousedown 会清掉选区），
//   剪切/粘贴执行前恢复焦点 + 选区，命令作用在还原的选区上。
// - 不抢占焦点：菜单自身不收焦点（保持输入框选区高亮可见），
//   键盘导航走 window capture keydown —— Enter 在 textarea 的
//   onKeyDown 之前被拦截，不会误触发"Enter 发送"。
// ============================================================

interface MenuItem {
  key: string
  icon: React.ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  /** 执行后恢复焦点+选区（复制/选择类需要；粘贴/剪切由 action 内部自行恢复） */
  restore?: boolean
  action: () => void
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  /** 打开时的选区快照（textarea 用 start/end，选区型用 ranges） */
  snapshot: SelectionSnapshot
  /** 编辑场景的目标元素（用于执行后恢复焦点；只读场景为 null） */
  editTarget: HTMLElement | null
}

type SelectionSnapshot =
  | { kind: 'offset'; start: number; end: number }
  | { kind: 'ranges'; ranges: Range[] }
  | null

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }
  // Clipboard API 不可用（个别权限受限环境）→ 回退
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
  return Promise.resolve()
}

/** 打开菜单时的选区快照（当前无选区 → null） */
function snapshotSelection(el: HTMLElement): SelectionSnapshot {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const s = el.selectionStart
    const e = el.selectionEnd
    if (s === null || e === null) return null
    return { kind: 'offset', start: s, end: e }
  }
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return null
  const ranges: Range[] = []
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i)
    if (el.contains(r.commonAncestorContainer)) ranges.push(r)
  }
  return ranges.length > 0 ? { kind: 'ranges', ranges } : null
}

function selectedTextIn(el: HTMLElement): string | null {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const s = el.selectionStart
    const e = el.selectionEnd
    if (s === null || e === null || s === e) return null
    return el.value.slice(s, e)
  }
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.commonAncestorContainer)) return null
  const text = r.cloneContents().firstChild
  return text instanceof Text && text.data.length > 0 ? sel.toString() : null
}

/** 恢复焦点 + 选区（快照还原）：点击菜单项时按钮会抢焦点导致选区重置，
 *  命令执行前 / 执行后按需调用 */
function restoreFocusAndSelection(target: HTMLElement | null, snap: SelectionSnapshot): void {
  if (!snap) return
  if (snap.kind === 'offset') {
    if (!target || !(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return
    target.focus({ preventScroll: true })
    target.setSelectionRange(snap.start, snap.end)
  } else {
    if (target) target.focus({ preventScroll: true })
    const sel = window.getSelection()
    sel?.removeAllRanges()
    for (const r of snap.ranges) sel?.addRange(r)
  }
}

/** 剪切/粘贴：取剪贴板文本（paste）→ 恢复焦点与选区 → 执行编辑命令。
 *  命令在 click 的 microtask 内执行（仍属用户手势），execCommand 可正常工作。 */
async function clipboardEdit(target: HTMLElement, kind: 'cut' | 'paste', snap: SelectionSnapshot): Promise<void> {
  let text = ''
  if (kind === 'paste') {
    try {
      text = await navigator.clipboard.readText()
    } catch {
      // readText 需用户手势 + 权限；个别环境被拒 → 稍后 execCommand('paste') 回退
    }
  }
  restoreFocusAndSelection(target, snap)
  if (kind === 'cut') {
    document.execCommand('cut')
  } else if (text) {
    if (!document.execCommand('insertText', false, text)) {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  } else if (!document.execCommand('paste')) {
    // 两条路都失败：静默放弃（剪贴板为图片或被系统拦截）
  }
}

/** 编辑元素"全选"：textarea/input 用原生 select()，contenteditable 用 range 包住全部文本 */
function selectAllInEditable(el: HTMLElement): void {
  el.focus({ preventScroll: true })
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** 选中文本是否在"消息气泡"内（是则菜单可出现"选择整条消息"） */
function selectionInMessageBlock(sel: Selection): HTMLElement | null {
  if (!sel.rangeCount || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  const root = r.commonAncestorContainer instanceof Element
    ? r.commonAncestorContainer
    : r.commonAncestorContainer.parentElement
  if (!(root instanceof Element)) return null
  const block = root.closest<HTMLElement>('.message-user, .message-assistant')
  if (!block) return null
  if (block.querySelector('textarea, [contenteditable]')) return null
  return block
}

function selectNodeContents(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** 编辑元素在右键 mousedown 瞬间的选区快照。
 *  Chromium 中 mousedown（含右键）会把 textarea 选区重置到点击位置，
 *  contextmenu 触发时原始选区已被破坏 → 必须在 mousedown 时缓存。 */
let rmDownSnapshot: { el: HTMLElement; snap: SelectionSnapshot } | null = null

export default function ContextMenu() {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [focusIndex, setFocusIndex] = useState(-1)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusIndexRef = useRef(-1)
  focusIndexRef.current = focusIndex

  // 右键 mousedown 时缓存目标编辑元素的选区（先于 contextmenu 到达）
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return
      const target = e.target instanceof Element ? e.target : null
      const el = target?.closest<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""]')
      rmDownSnapshot = el ? { el, snap: snapshotSelection(el) } : null
    }
    window.addEventListener('mousedown', onMouseDown, true)
    return () => window.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  // 打开菜单：区分输入框 / 只读选中文本两种场景
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const textarea = target?.closest<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""]')
      const editing = !!textarea
      const sel = window.getSelection()

      let items: MenuItem[] | null = null
      let snapshot: SelectionSnapshot = null
      if (editing && textarea) {
        // 右键 mousedown 会把当前选区重置到点击位置 → 用 mousedown 瞬间的快照
        const downSnap = rmDownSnapshot && rmDownSnapshot.el === textarea
          ? rmDownSnapshot.snap
          : snapshotSelection(textarea)
        const hasSel = downSnap
          ? downSnap.kind === 'offset'
            ? downSnap.start !== downSnap.end
            : downSnap.ranges.length > 0
          : false
        const selText = hasSel
          ? downSnap && downSnap.kind === 'offset'
            ? textarea instanceof HTMLTextAreaElement || textarea instanceof HTMLInputElement
              ? textarea.value.slice(downSnap.start, downSnap.end)
              : window.getSelection()?.toString() ?? ''
            : window.getSelection()?.toString() ?? ''
          : null
        snapshot = downSnap
        items = [
          hasSel
            ? {
                key: 'copy',
                icon: <Copy size={13} />,
                label: t('chat.contextMenu.copy'),
                shortcut: 'Ctrl+C',
                restore: true,
                action: () => void copyToClipboard(selText!)
              }
            : null,
          hasSel
            ? {
                key: 'cut',
                icon: <Scissors size={13} />,
                label: t('chat.contextMenu.cut'),
                shortcut: 'Ctrl+X',
                action: () => void clipboardEdit(textarea, 'cut', snapshot)
              }
            : null,
          {
            key: 'paste',
            icon: <ClipboardPaste size={13} />,
            label: t('chat.contextMenu.paste'),
            shortcut: 'Ctrl+V',
            action: () => void clipboardEdit(textarea, 'paste', snapshot)
          },
          {
            key: 'selectAll',
            icon: <ListChecks size={13} />,
            label: hasSel ? t('chat.contextMenu.selectMessage') : t('chat.contextMenu.selectAll'),
            shortcut: hasSel ? undefined : 'Ctrl+A',
            action: () => selectAllInEditable(textarea)
          }
        ].filter(Boolean) as MenuItem[]
      } else if (sel && !sel.isCollapsed && sel.toString()) {
        const block = selectionInMessageBlock(sel)
        const text = sel.toString()
        items = [
          {
            key: 'copy',
            icon: <Copy size={13} />,
            label: t('chat.contextMenu.copy'),
            shortcut: 'Ctrl+C',
            restore: true,
            action: () => void copyToClipboard(text)
          },
          block
            ? {
                key: 'selectAll',
                icon: <ListChecks size={13} />,
                label: t('chat.contextMenu.selectMessage'),
                action: () => selectNodeContents(block)
              }
            : null
        ].filter(Boolean) as MenuItem[]
      }

      if (!items) return
      e.preventDefault()

      // 输入框先聚焦：右键本身不聚焦 textarea，保持选区高亮可见、命令有主
      if (textarea && document.activeElement !== textarea) {
        textarea.focus({ preventScroll: true })
      }
      setMenu({ x: e.clientX, y: e.clientY, items, snapshot, editTarget: textarea ?? null })
      setPos(null)
      setFocusIndex(-1)
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => document.removeEventListener('contextmenu', onContextMenu, true)
  }, [t])

  // 菜单渲染后测量实际尺寸 → 贴边翻转/夹紧（首帧渲染在视口外，测量完再定位）
  useEffect(() => {
    if (!menu || pos) return
    const el = menuRef.current
    const w = el?.offsetWidth ?? 176
    const h = el?.offsetHeight ?? 120
    let x = menu.x
    let y = menu.y
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8)
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8)
    setPos({ x, y })
  }, [menu, pos])

  // 关闭 + 键盘导航：
  // - mousedown（capture）菜单外任意按下即关闭；菜单自身子树豁免（否则 click 落空、动作不执行）
  // - keydown（capture，先于底层 textarea 的 handler）：↑↓/Home/End 导航，Enter 执行，
  //   Esc/Tab 关闭，普通按键收起菜单并放行（字符照常输入，Enter 被拦截不会误发送）
  useEffect(() => {
    if (!menu) return
    const close = () => {
      setMenu(null)
      setPos(null)
      setFocusIndex(-1)
    }
    const onMouseDown = (e: MouseEvent) => {
      const el = e.target
      // 菜单子树豁免（按 DOM 属性判断：不依赖 React ref —— 菜单关闭卸载后
      // ref 为 null，若此时仍在处理菜单项的 mousedown，click 将落空）
      if (el instanceof Element && (el.closest('[data-zhumora-menu]') || el.hasAttribute('data-zhumora-menu'))) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // 快捷键不拦截（Ctrl+C/V/X 原生行为照常），仅收起菜单
        close()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setFocusIndex(i => Math.min(menu.items.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setFocusIndex(i => Math.max(0, i - 1))
      } else if (e.key === 'Home') {
        e.preventDefault(); e.stopPropagation()
        setFocusIndex(0)
      } else if (e.key === 'End') {
        e.preventDefault(); e.stopPropagation()
        setFocusIndex(menu.items.length - 1)
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation()
        const idx = focusIndexRef.current
        if (idx >= 0) {
          const item = menu.items[idx]
          close()
          if (!item.disabled) item.action()
        }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation()
        close()
      } else if (e.key.length === 1 || e.key === ' ' || e.key === 'Backspace' || e.key === 'Delete') {
        close()
      }
    }
    const onBlur = () => close()
    const onResize = () => close()
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  }, [menu])

  // 焦点项滚动进可视区
  useEffect(() => {
    if (focusIndex < 0 || !menuRef.current) return
    menuRef.current.querySelectorAll('[role="menuitem"]').item(focusIndex)?.scrollIntoView({ block: 'nearest' })
  }, [focusIndex])

  if (!menu) return null

  return (
    <div
      ref={menuRef}
      data-zhumora-menu
      className="context-menu"
      role="menu"
      style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
    >
      {menu.items.map((item, i) => (
        <button
          key={item.key}
          role="menuitem"
          type="button"
          disabled={item.disabled}
          className={i === focusIndex ? 'is-focused' : ''}
          tabIndex={-1}
          onClick={() => {
            setMenu(null)
            setPos(null)
            if (item.disabled) return
            item.action()
            // 复制/选择类操作不改变文本：补回点击时丢失的焦点与选区
            if (item.restore) restoreFocusAndSelection(menu.editTarget, menu.snapshot)
          }}
          onMouseEnter={() => setFocusIndex(i)}
        >
          <span className="context-menu-icon">{item.icon}</span>
          <span className="context-menu-label">{item.label}</span>
          {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  )
}

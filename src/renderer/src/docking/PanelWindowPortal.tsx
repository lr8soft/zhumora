import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PanelPortal } from './usePanelWindows'

export default function PanelWindowPortal({ portal, children }: { portal: PanelPortal; children: ReactNode }) {
  useEffect(() => {
    const target = portal.window.document
    const copies: Element[] = []
    const syncStyles = () => {
      copies.splice(0).forEach(node => node.remove())
      document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
        const copy = node.cloneNode(true) as Element
        if (node instanceof HTMLLinkElement) copy.setAttribute('href', node.href)
        target.head.append(copy); copies.push(copy)
      })
    }
    const syncTheme = () => {
      target.documentElement.dataset.theme = document.documentElement.dataset.theme
      target.documentElement.style.cssText = document.documentElement.style.cssText
      target.documentElement.lang = document.documentElement.lang
    }
    syncStyles(); syncTheme()
    const styles = new MutationObserver(syncStyles)
    const theme = new MutationObserver(syncTheme)
    styles.observe(document.head, { childList: true, subtree: true, characterData: true })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'lang'] })
    return () => { styles.disconnect(); theme.disconnect(); copies.forEach(node => node.remove()) }
  }, [portal])
  return createPortal(children, portal.container)
}

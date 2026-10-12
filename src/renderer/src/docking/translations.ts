const en = { composer: 'Message input', left: 'Dock left', right: 'Dock right', top: 'Dock top', bottom: 'Dock bottom', center: 'Dock center',
  floating: 'Float in app', window: 'Separate window', detach: 'Open in separate window', return: 'Return to main window',
  layout: 'Panel layout', resize: 'Resize panel', empty: 'Drag a panel here, or restore one below.',
  restore: 'Restore {{title}}', windowError: 'Could not open the panel window. Try again.' }
export const dockTranslations = {
  en,
  zh: { composer: '输入区', left: '停靠左侧', right: '停靠右侧', top: '停靠顶部', bottom: '停靠底部', center: '停靠中央',
    floating: '窗口内浮动', window: '独立窗口', detach: '在独立窗口打开', return: '停靠回主窗口',
    layout: '面板布局', resize: '调整面板大小', empty: '拖动面板停靠到这里，或恢复面板。',
    restore: '恢复{{title}}', windowError: '独立窗口打开失败，请重试。' },
  ja: { ...en, composer: 'メッセージ入力', left: '左にドッキング', right: '右にドッキング', top: '上にドッキング', bottom: '下にドッキング', center: '中央にドッキング',
    floating: 'アプリ内でフロート', window: '別ウィンドウ', detach: '別ウィンドウで開く', return: 'メインに戻す', layout: 'パネル配置', resize: 'サイズ変更',
    empty: 'パネルをここにドラッグするか、復元してください。', restore: '{{title}}を復元', windowError: 'ウィンドウを開けませんでした。' },
  es: { ...en, composer: 'Entrada de mensaje', left: 'Acoplar izquierda', right: 'Acoplar derecha', top: 'Acoplar arriba', bottom: 'Acoplar abajo', center: 'Acoplar centro',
    floating: 'Flotar en la app', window: 'Ventana separada', detach: 'Abrir ventana separada', return: 'Volver a la ventana principal', layout: 'Diseño de paneles', resize: 'Cambiar tamaño',
    empty: 'Arrastre un panel aquí o restáurelo.', restore: 'Restaurar {{title}}', windowError: 'No se pudo abrir la ventana.' },
  fr: { ...en, composer: 'Saisie du message', left: 'Ancrer à gauche', right: 'Ancrer à droite', top: 'Ancrer en haut', bottom: 'Ancrer en bas', center: 'Ancrer au centre',
    floating: 'Flotter dans l’app', window: 'Fenêtre séparée', detach: 'Ouvrir une fenêtre séparée', return: 'Revenir à la fenêtre principale', layout: 'Disposition des panneaux', resize: 'Redimensionner',
    empty: 'Glissez un panneau ici ou restaurez-le.', restore: 'Restaurer {{title}}', windowError: 'Impossible d’ouvrir la fenêtre.' },
  de: { ...en, composer: 'Nachrichteneingabe', left: 'Links andocken', right: 'Rechts andocken', top: 'Oben andocken', bottom: 'Unten andocken', center: 'Mittig andocken',
    floating: 'In der App schweben', window: 'Eigenes Fenster', detach: 'In eigenem Fenster öffnen', return: 'Zum Hauptfenster zurück', layout: 'Panel-Anordnung', resize: 'Größe ändern',
    empty: 'Panel hierher ziehen oder wiederherstellen.', restore: '{{title}} wiederherstellen', windowError: 'Fenster konnte nicht geöffnet werden.' }
}

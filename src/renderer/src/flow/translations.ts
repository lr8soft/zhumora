const en = {
  title: 'Conversation flow', turnCount: '{{count}} turns', stepCount: '{{count}} steps', messageCount: '{{count}} messages', receivedCount: 'Received {{received}} / {{total}} task results',
  fit: 'Fit canvas', expandHistory: 'Expand history', foldHistory: 'Fold history', children: 'Subagents', follow: 'Follow run',
  details: 'Node details', close: 'Close details', copy: 'Copy', copied: 'Copied', copyError: 'Copy failed. Select the text to copy it.',
  branch: 'Delegation', receive: 'Receive results', inspect: 'Details', waitingOutput: 'Waiting for model output…', noContent: 'No text content',
  noResult: 'No result returned yet', openSession: 'Open session', awaitingPermission: 'Session awaiting approval',
  loadError: 'Could not load session history.', retry: 'Retry', zoomIn: 'Zoom in', zoomOut: 'Zoom out', finalReply: 'Reply',
  running: 'Running', ready: 'Ready', latest: 'Latest output',
  kind: { user: 'User input', llm: 'LLM turn', tool: 'Tool', delegate: 'Subagent task', join: 'Collect results', summary: 'Context summary',
    turn: 'Conversation turn', compaction: 'Context boundary', lane: 'Subagent' },
  status: { done: 'Completed', running: 'Running', queued: 'Queued', error: 'Error', unresolved: 'Unfinished' },
  tab: { content: 'Content', reasoning: 'Reasoning', args: 'Arguments', result: 'Result' }
}
const zh = {
  title: '对话流程', turnCount: '{{count}} 轮对话', stepCount: '{{count}} 个节点', messageCount: '{{count}} 条消息', receivedCount: '已接收 {{received}} / {{total}} 个任务结果',
  fit: '适应画布', expandHistory: '展开历史', foldHistory: '折叠历史', children: '子 Agent', follow: '跟随运行',
  details: '节点详情', close: '关闭详情', copy: '复制', copied: '已复制', copyError: '复制失败，请选中文字复制。',
  branch: '委托分支', receive: '接收结果', inspect: '查看详情', waitingOutput: '等待模型输出…', noContent: '暂无文本内容',
  noResult: '尚未返回执行结果', openSession: '打开所属会话', awaitingPermission: '会话等待权限确认',
  loadError: '会话历史加载失败。', retry: '重试', zoomIn: '放大', zoomOut: '缩小', finalReply: '最终回复',
  running: '正在运行', ready: '就绪', latest: '最新输出',
  kind: { user: '用户输入', llm: 'LLM 轮次', tool: '工具', delegate: '子 Agent 任务', join: '接收子任务结果', summary: '上下文摘要',
    turn: '对话轮次', compaction: '上下文压缩边界', lane: '子 Agent' },
  status: { done: '已完成', running: '运行中', queued: '待执行', error: '出错', unresolved: '未完成' },
  tab: { content: '内容', reasoning: '思考', args: '参数', result: '结果' }
}
const ja = {
  ...en, title: '会話フロー', turnCount: '{{count}} ターン', stepCount: '{{count}} ノード', messageCount: '{{count}} メッセージ', receivedCount: '{{received}} / {{total}} 件の結果を受信',
  fit: '全体を表示', expandHistory: '履歴を展開', foldHistory: '履歴を折りたたむ', children: 'サブエージェント', follow: '実行を追跡',
  details: 'ノードの詳細', close: '詳細を閉じる', copy: 'コピー', copied: 'コピー済み', copyError: 'コピーに失敗しました。テキストを選択してください。',
  branch: '委任', receive: '結果を受信', inspect: '詳細', waitingOutput: 'モデルの出力を待機中…', noContent: 'テキストなし',
  noResult: '結果はまだ返されていません', openSession: 'セッションを開く', awaitingPermission: 'セッションの承認待ち',
  loadError: '履歴を読み込めませんでした。', retry: '再試行', zoomIn: '拡大', zoomOut: '縮小', finalReply: '回答', running: '実行中', ready: '準備完了', latest: '最新の出力',
  kind: { user: 'ユーザー入力', llm: 'LLM ターン', tool: 'ツール', delegate: 'サブタスク', join: '結果の収集', summary: 'コンテキスト要約', turn: '会話ターン', compaction: 'コンテキスト境界', lane: 'サブエージェント' },
  status: { done: '完了', running: '実行中', queued: '待機中', error: 'エラー', unresolved: '未完了' },
  tab: { content: '内容', reasoning: '推論', args: '引数', result: '結果' }
}
const es = {
  ...en, title: 'Flujo de conversación', turnCount: '{{count}} turnos', stepCount: '{{count}} nodos', messageCount: '{{count}} mensajes', receivedCount: '{{received}} / {{total}} resultados recibidos',
  fit: 'Ajustar lienzo', expandHistory: 'Expandir historial', foldHistory: 'Plegar historial', children: 'Subagentes', follow: 'Seguir ejecución',
  details: 'Detalles del nodo', close: 'Cerrar detalles', copy: 'Copiar', copied: 'Copiado', copyError: 'No se pudo copiar. Seleccione el texto.',
  branch: 'Delegación', receive: 'Recibir resultados', inspect: 'Detalles', waitingOutput: 'Esperando al modelo…', noContent: 'Sin texto',
  noResult: 'Aún no hay resultado', openSession: 'Abrir sesión', awaitingPermission: 'Sesión pendiente de aprobación',
  loadError: 'No se pudo cargar el historial.', retry: 'Reintentar', zoomIn: 'Acercar', zoomOut: 'Alejar', finalReply: 'Respuesta', running: 'En ejecución', ready: 'Listo', latest: 'Última salida',
  kind: { user: 'Entrada del usuario', llm: 'Turno LLM', tool: 'Herramienta', delegate: 'Subtarea', join: 'Recoger resultados', summary: 'Resumen del contexto', turn: 'Turno de conversación', compaction: 'Límite del contexto', lane: 'Subagente' },
  status: { done: 'Completado', running: 'En ejecución', queued: 'En cola', error: 'Error', unresolved: 'Sin terminar' },
  tab: { content: 'Contenido', reasoning: 'Razonamiento', args: 'Argumentos', result: 'Resultado' }
}
const fr = {
  ...en, title: 'Flux de conversation', turnCount: '{{count}} tours', stepCount: '{{count}} nœuds', messageCount: '{{count}} messages', receivedCount: '{{received}} / {{total}} résultats reçus',
  fit: 'Ajuster la vue', expandHistory: 'Déplier l’historique', foldHistory: 'Replier l’historique', children: 'Sous-agents', follow: 'Suivre l’exécution',
  details: 'Détails du nœud', close: 'Fermer les détails', copy: 'Copier', copied: 'Copié', copyError: 'Échec de la copie. Sélectionnez le texte.',
  branch: 'Délégation', receive: 'Recevoir les résultats', inspect: 'Détails', waitingOutput: 'En attente du modèle…', noContent: 'Aucun texte',
  noResult: 'Aucun résultat pour le moment', openSession: 'Ouvrir la session', awaitingPermission: 'Session en attente d’autorisation',
  loadError: 'Impossible de charger l’historique.', retry: 'Réessayer', zoomIn: 'Agrandir', zoomOut: 'Réduire', finalReply: 'Réponse', running: 'En cours', ready: 'Prêt', latest: 'Dernière sortie',
  kind: { user: 'Entrée utilisateur', llm: 'Tour LLM', tool: 'Outil', delegate: 'Sous-tâche', join: 'Collecte des résultats', summary: 'Résumé du contexte', turn: 'Tour de conversation', compaction: 'Limite du contexte', lane: 'Sous-agent' },
  status: { done: 'Terminé', running: 'En cours', queued: 'En attente', error: 'Erreur', unresolved: 'Inachevé' },
  tab: { content: 'Contenu', reasoning: 'Raisonnement', args: 'Arguments', result: 'Résultat' }
}
const de = {
  ...en, title: 'Gesprächsablauf', turnCount: '{{count}} Runden', stepCount: '{{count}} Knoten', messageCount: '{{count}} Nachrichten', receivedCount: '{{received}} / {{total}} Ergebnisse empfangen',
  fit: 'Ansicht einpassen', expandHistory: 'Verlauf aufklappen', foldHistory: 'Verlauf einklappen', children: 'Unteragenten', follow: 'Ausführung folgen',
  details: 'Knotendetails', close: 'Details schließen', copy: 'Kopieren', copied: 'Kopiert', copyError: 'Kopieren fehlgeschlagen. Bitte Text auswählen.',
  branch: 'Delegation', receive: 'Ergebnisse empfangen', inspect: 'Details', waitingOutput: 'Warten auf Modellausgabe…', noContent: 'Kein Text',
  noResult: 'Noch kein Ergebnis', openSession: 'Sitzung öffnen', awaitingPermission: 'Sitzung wartet auf Genehmigung',
  loadError: 'Verlauf konnte nicht geladen werden.', retry: 'Erneut versuchen', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', finalReply: 'Antwort', running: 'Wird ausgeführt', ready: 'Bereit', latest: 'Neueste Ausgabe',
  kind: { user: 'Benutzereingabe', llm: 'LLM-Runde', tool: 'Werkzeug', delegate: 'Unteraufgabe', join: 'Ergebnisse sammeln', summary: 'Kontextzusammenfassung', turn: 'Gesprächsrunde', compaction: 'Kontextgrenze', lane: 'Unteragent' },
  status: { done: 'Abgeschlossen', running: 'Läuft', queued: 'In Warteschlange', error: 'Fehler', unresolved: 'Unvollständig' },
  tab: { content: 'Inhalt', reasoning: 'Überlegung', args: 'Argumente', result: 'Ergebnis' }
}
export const flowTranslations = { en, zh, ja, es, fr, de }

const en = {
  title: 'Subagent model priority', hint: 'Order provider/model pairs for new tasks. Continuing a child keeps its original model.',
  dispatch: 'Dispatch strategy', priority: 'Prefer priority', spread: 'Spread concurrent work',
  priorityHint: 'Prefer the first available provider. With no concurrency limit, later providers may remain unused.',
  spreadHint: 'Rotate among available providers in list order. Models on the same provider share its allowance and rotation position; its first model has priority.',
  empty: 'An empty list inherits the main agent model. Add models to dispatch across providers.',
  add: 'Add a subagent model…', addAll: 'Add provider defaults', reorder: 'Drag to reorder', up: 'Move up', down: 'Move down', remove: 'Remove model',
  sharedLimit: 'Provider shared limit: {{limit}}', unlimited: 'Unlimited'
}
export const subagentRoutingTranslations = {
  en,
  zh: {
    title: '子模型优先序列', hint: '按顺序配置新子任务使用的供应商与模型。继续已有子任务时保留原模型。',
    dispatch: '分配策略', priority: '优先使用', spread: '分散并发',
    priorityHint: '优先选择靠前的可用供应商。靠前供应商未限制并发时，后续模型可能不会被使用。',
    spreadHint: '按列表顺序在可用供应商间轮转。同一供应商的多个模型共享额度和轮转位置，优先使用其首个模型。',
    empty: '列表为空时继承主 Agent 模型。添加模型后可在多个供应商间分配任务。',
    add: '添加子模型…', addAll: '添加各供应商默认模型', reorder: '拖动排序', up: '上移', down: '下移', remove: '移除模型',
    sharedLimit: '供应商共享并发上限：{{limit}}', unlimited: '不限制'
  },
  ja: {
    title: 'サブモデルの優先順位', hint: '新規タスクのプロバイダーとモデルを並べます。継続時は元のモデルを維持します。',
    dispatch: '割り当て方法', priority: '優先順', spread: '並列分散',
    priorityHint: '上位の利用可能なプロバイダーを優先します。無制限の場合、後続は使われないことがあります。',
    spreadHint: '利用可能なプロバイダーを順番に使用します。同じプロバイダーのモデルは枠と順番を共有し、先頭モデルを優先します。',
    empty: '空のリストはメインモデルを継承します。複数のプロバイダーを使うにはモデルを追加してください。',
    add: 'モデルを追加…', addAll: '既定モデルを追加', reorder: 'ドラッグで並べ替え', up: '上へ', down: '下へ', remove: 'モデルを削除',
    sharedLimit: 'プロバイダー共有上限：{{limit}}', unlimited: '無制限'
  },
  es: {
    title: 'Prioridad de modelos de subagente', hint: 'Ordena proveedores y modelos para tareas nuevas. Al continuar se conserva el modelo original.',
    dispatch: 'Asignación', priority: 'Priorizar orden', spread: 'Distribuir concurrencia',
    priorityHint: 'Prefiere el primer proveedor disponible. Sin límite, los siguientes pueden no utilizarse.',
    spreadHint: 'Alterna entre proveedores disponibles en orden. Los modelos del mismo proveedor comparten cupo y turno; se prefiere su primer modelo.',
    empty: 'La lista vacía hereda el modelo principal. Añade modelos para distribuir tareas entre proveedores.',
    add: 'Añadir modelo…', addAll: 'Añadir modelos predeterminados', reorder: 'Arrastrar para ordenar', up: 'Subir', down: 'Bajar', remove: 'Quitar modelo',
    sharedLimit: 'Límite compartido del proveedor: {{limit}}', unlimited: 'Sin límite'
  },
  fr: {
    title: 'Priorité des modèles de sous-agent', hint: 'Classez les fournisseurs et modèles des nouvelles tâches. Une reprise conserve le modèle initial.',
    dispatch: 'Répartition', priority: 'Suivre la priorité', spread: 'Répartir en parallèle',
    priorityHint: 'Privilégie le premier fournisseur disponible. Sans limite, les suivants peuvent rester inutilisés.',
    spreadHint: 'Alterne entre fournisseurs disponibles dans l’ordre. Les modèles d’un fournisseur partagent quota et tour ; son premier modèle est privilégié.',
    empty: 'Une liste vide hérite du modèle principal. Ajoutez des modèles pour répartir les tâches entre fournisseurs.',
    add: 'Ajouter un modèle…', addAll: 'Ajouter les modèles par défaut', reorder: 'Glisser pour réordonner', up: 'Monter', down: 'Descendre', remove: 'Retirer le modèle',
    sharedLimit: 'Limite partagée du fournisseur : {{limit}}', unlimited: 'Illimitée'
  },
  de: {
    title: 'Modellpriorität für Unteragenten', hint: 'Anbieter und Modelle für neue Aufgaben ordnen. Fortsetzungen behalten das ursprüngliche Modell.',
    dispatch: 'Zuweisung', priority: 'Priorität bevorzugen', spread: 'Parallel verteilen',
    priorityHint: 'Bevorzugt den ersten verfügbaren Anbieter. Ohne Begrenzung bleiben spätere Anbieter eventuell ungenutzt.',
    spreadHint: 'Wechselt zwischen verfügbaren Anbietern in Listenreihenfolge. Modelle desselben Anbieters teilen Kontingent und Position; sein erstes Modell hat Vorrang.',
    empty: 'Eine leere Liste übernimmt das Hauptmodell. Modelle hinzufügen, um Aufgaben auf mehrere Anbieter zu verteilen.',
    add: 'Modell hinzufügen…', addAll: 'Anbieter-Standardmodelle hinzufügen', reorder: 'Zum Sortieren ziehen', up: 'Nach oben', down: 'Nach unten', remove: 'Modell entfernen',
    sharedLimit: 'Gemeinsames Anbieterlimit: {{limit}}', unlimited: 'Unbegrenzt'
  }
}

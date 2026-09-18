import assert from 'node:assert/strict'
import { groupSessionsByOrigin } from '../src/renderer/src/sessionGroups.ts'
import type { Session } from '../src/shared/types.ts'

function session(id: string, origin: Session['origin'], updatedAt: number): Session {
  return { id, title: id, createdAt: updatedAt, updatedAt, messageCount: 0, origin, avatarEnabled: false, ttsEnabled: false }
}

// 空列表 → 无分组
assert.deepEqual(groupSessionsByOrigin([]), [])

// 混合来源：外部会话不再与桌面会话混排；组内保持 updatedAt 降序；空来源不出现
const groups = groupSessionsByOrigin([
  session('a1', 'renderer', 300),
  session('a2', 'renderer', 100),
  session('b1', 'telegram', 400),
  session('c1', 'mcp', 200),
  session('d1', 'qq', 50)
])
assert.deepEqual(groups.map(g => g.origin), ['renderer', 'telegram', 'qq', 'mcp'])
assert.deepEqual(groups[0].sessions.map(s => s.id), ['a1', 'a2'])
assert.deepEqual(groups[1].sessions.map(s => s.id), ['b1'])
assert.deepEqual(groups[2].sessions.map(s => s.id), ['d1'])
assert.deepEqual(groups[3].sessions.map(s => s.id), ['c1'])

// 全部同一来源 → 单分组
assert.equal(groupSessionsByOrigin([session('x', 'telegram', 1)]).length, 1)

// 输入不被修改（纯函数）
const input = [session('a', 'renderer', 1), session('b', 'mcp', 2)]
const snapshot = input.map(s => s.id)
groupSessionsByOrigin(input)
assert.deepEqual(input.map(s => s.id), snapshot)

console.log('session groups projection tests passed')

import assert from 'node:assert/strict'
import {
  shouldNotifyRunEnd,
  shouldNotifyPermission,
  shouldCloseInsteadOfHide,
  backgroundStringsFor,
  runEndBody,
  permissionBody
} from '../src/main/backgroundPolicy.ts'

// ============ shouldNotifyRunEnd：窗口可见不打扰；中止静默；出错/完成分别标记 ============
assert.equal(shouldNotifyRunEnd({ windowVisible: true, kind: 'complete' }), null)
assert.equal(shouldNotifyRunEnd({ windowVisible: true, kind: 'error' }), null)
assert.equal(shouldNotifyRunEnd({ windowVisible: true, kind: 'aborted' }), null)
assert.equal(shouldNotifyRunEnd({ windowVisible: false, kind: 'complete' }), 'finished')
assert.equal(shouldNotifyRunEnd({ windowVisible: false, kind: 'error' }), 'failed')
// 中止（用户点停止 / /stop / 外部编排器取消）不弹"完成"通知
assert.equal(shouldNotifyRunEnd({ windowVisible: false, kind: 'aborted' }), null)

// ============ shouldNotifyPermission：仅隐藏期进入挂起集合时提醒 ============
assert.equal(shouldNotifyPermission({ windowVisible: false, pending: true }), true)
assert.equal(shouldNotifyPermission({ windowVisible: false, pending: false }), false)
assert.equal(shouldNotifyPermission({ windowVisible: true, pending: true }), false)

// ============ shouldCloseInsteadOfHide：关窗 hide vs destroy 的唯一判定点 ============
// 默认（未退出、win、生产、未关后台模式）→ hide
assert.equal(shouldCloseInsteadOfHide({ quitting: false, platform: 'win32', dev: false, backgroundClose: true }), false)
assert.equal(shouldCloseInsteadOfHide({ quitting: false, platform: 'win32', dev: false, backgroundClose: undefined }), false)
// 退出中 → destroy（before-quit 已置位）
assert.equal(shouldCloseInsteadOfHide({ quitting: true, platform: 'win32', dev: false, backgroundClose: true }), true)
// macOS 维持既有"红点关闭"语义（destroy，activate 重建）
assert.equal(shouldCloseInsteadOfHide({ quitting: false, platform: 'darwin', dev: false, backgroundClose: true }), true)
// dev 模式关窗即退出，避免调试残留后台进程
assert.equal(shouldCloseInsteadOfHide({ quitting: false, platform: 'win32', dev: true, backgroundClose: true }), true)
// 用户显式关闭后台模式 → 关窗即退出
assert.equal(shouldCloseInsteadOfHide({ quitting: false, platform: 'win32', dev: false, backgroundClose: false }), true)

// ============ 文案与通知正文 ============
const zh = backgroundStringsFor('zh')
assert.equal(zh.quit, '退出')
assert.equal(zh.needsApproval, '需要你批准')
// 未知语言回落 en
assert.equal(backgroundStringsFor('xx').quit, 'Quit')
assert.equal(backgroundStringsFor('auto').quit, 'Quit')

assert.equal(runEndBody('finished', null, zh), '运行已完成')
assert.equal(runEndBody('failed', '  ', zh), '运行出错')
assert.equal(runEndBody('finished', '修复登录崩溃', zh), '运行已完成：修复登录崩溃')
// 长标题截断到 40 字符
const longTitle = 'x'.repeat(60)
assert.equal(runEndBody('finished', longTitle, zh), `运行已完成：${'x'.repeat(40)}…`)
assert.equal(permissionBody('会话 A', zh), '需要你批准：会话 A')
assert.equal(permissionBody(null, zh), '需要你批准')

console.log('background policy tests passed')

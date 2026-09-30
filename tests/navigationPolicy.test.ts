import assert from 'node:assert/strict'

import { decideNavigation } from '../src/main/navigationPolicy.ts'

// ============ 同源导航放行（页面内路由、刷新、hash 锚点） ============
// dev 环境：应用文档 origin 是 vite dev server
const DEV_ORIGIN = 'http://localhost:5173'
assert.equal(decideNavigation('http://localhost:5173/', DEV_ORIGIN), 'allow')
assert.equal(decideNavigation('http://localhost:5173/some/route', DEV_ORIGIN), 'allow')
assert.equal(decideNavigation('http://localhost:5173/#anchor', DEV_ORIGIN), 'allow')
// 端口不同即不同 origin → 外链
assert.equal(decideNavigation('http://localhost:3000/', DEV_ORIGIN), 'external')

// 生产环境：file:// 文档的 origin 是 "null"（opaque），file: 目标与其同源
const FILE_ORIGIN = 'null'
assert.equal(decideNavigation('file:///D:/app/renderer/index.html', FILE_ORIGIN), 'allow')
assert.equal(decideNavigation('file:///D:/app/renderer/about.html', FILE_ORIGIN), 'allow')
// http 目标与 file 文档不同源 → 外链
assert.equal(decideNavigation('https://example.com/', FILE_ORIGIN), 'external')

// 未知应用 origin（空串）：file: 等未知来源目标不得放行
assert.equal(decideNavigation('file:///D:/evil.html', ''), 'deny')

// ============ http/https 目标 → 交给系统浏览器 ============
assert.equal(decideNavigation('https://example.com/page', DEV_ORIGIN), 'external')
assert.equal(decideNavigation('http://example.com:8080/x', DEV_ORIGIN), 'external')
assert.equal(decideNavigation('https://zhuminet.com', FILE_ORIGIN), 'external')

// ============ 其余协议一律拒绝（窗口不得被 file:/javascript:/自定义协议导航走） ============
assert.equal(decideNavigation('file:///C:/Users/x/secret.txt', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('javascript:alert(1)', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('about:blank', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('chrome://settings', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('data:text/html,<b>x</b>', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('telegram://bot', DEV_ORIGIN), 'deny')
// 畸形/不可解析 URL
assert.equal(decideNavigation('not a url', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('', DEV_ORIGIN), 'deny')
assert.equal(decideNavigation('https://', DEV_ORIGIN), 'deny')

// ============ 大小写与空白健壮性 ============
assert.equal(decideNavigation('HTTPS://EXAMPLE.com/a', DEV_ORIGIN), 'external')
// 非 http 协议即使大写也拒绝
assert.equal(decideNavigation('FILE:///x', DEV_ORIGIN), 'deny')

console.log('navigation policy tests passed')

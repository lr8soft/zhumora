import assert from 'node:assert/strict'
import { normalizeBrowserTarget, normalizeCustomBrowserPath } from '../src/shared/browser.ts'

assert.equal(normalizeBrowserTarget(undefined), 'chrome')
assert.equal(normalizeBrowserTarget('chrome'), 'chrome')
assert.equal(normalizeBrowserTarget('msedge'), 'msedge')
assert.equal(normalizeBrowserTarget('custom'), 'custom')
assert.equal(normalizeBrowserTarget('unknown'), 'chrome')
assert.equal(normalizeCustomBrowserPath('  C:\\Browser\\browser.exe  '), 'C:\\Browser\\browser.exe')
assert.equal(normalizeCustomBrowserPath(123), '')

console.log('browser settings normalization tests passed')

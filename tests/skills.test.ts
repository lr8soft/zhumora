import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  inspectSkillPath,
  loadSkill,
  reloadSkills,
  getSkillsSystemPrompt,
  getSkillContent,
  getLoadedSkillsInfo
} from '../src/main/skill/manager.ts'
import { skillTool, refreshSkillTool } from '../src/main/skill/skillTool.ts'
import { toolRegistry } from '../src/main/tools/registry.ts'
import type { SkillConfig } from '../src/shared/types.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhumora-skills-'))
const mkConfig = (name: string, p: string, enabled = true): SkillConfig => ({
  id: `cfg-${name}`,
  name,
  path: p,
  enabled
})

async function writeSkill(dir: string, name: string, description = 'Test skill for unit tests.', body = '# Test\nDo the test thing.') {
  const skillDir = path.join(dir, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
  return skillDir
}

try {
  // ---- inspectSkillPath: 目录型合法 ----
  const goodSkillDir = await writeSkill(root, 'good-skill')
  const good = await inspectSkillPath(goodSkillDir)
  assert.equal(good.valid, true)
  assert.equal(good.kind, 'folder')
  assert.equal(good.name, 'good-skill')
  assert.equal(good.description, 'Test skill for unit tests.')

  // 未知 frontmatter 字段被忽略（规范行为），不导致失败
  const unknownFmDir = path.join(root, 'unknown-fm')
  await fs.mkdir(unknownFmDir, { recursive: true })
  await fs.writeFile(path.join(unknownFmDir, 'SKILL.md'), '---\nname: unknown-fm\ndescription: Has unknown fields.\ntriggers:\n  - legacy\nmetadata:\n  author: x\n---\n\nBody.\n')
  const unknownFm = await inspectSkillPath(unknownFmDir)
  assert.equal(unknownFm.valid, true)

  // 缺 name
  const noNameDir = path.join(root, 'no-name')
  await fs.mkdir(noNameDir, { recursive: true })
  await fs.writeFile(path.join(noNameDir, 'SKILL.md'), '---\ndescription: No name here.\n---\n\nBody.\n')
  const noName = await inspectSkillPath(noNameDir)
  assert.equal(noName.valid, false)
  assert.match(noName.error || '', /name/)

  // 缺 description
  const noDescDir = path.join(root, 'no-desc')
  await fs.mkdir(noDescDir, { recursive: true })
  await fs.writeFile(path.join(noDescDir, 'SKILL.md'), '---\nname: no-desc\n---\n\nBody.\n')
  const noDesc = await inspectSkillPath(noDescDir)
  assert.equal(noDesc.valid, false)
  assert.match(noDesc.error || '', /description/)

  // name 与目录名不匹配
  const mismatchDir = path.join(root, 'mismatch')
  await fs.mkdir(mismatchDir, { recursive: true })
  await fs.writeFile(path.join(mismatchDir, 'SKILL.md'), '---\nname: other-name\ndescription: Mismatched.\n---\n\nBody.\n')
  const mismatch = await inspectSkillPath(mismatchDir)
  assert.equal(mismatch.valid, false)
  assert.match(mismatch.error || '', /match/)

  // 非法 name（大写 / 下划线 / 连续连字符）
  for (const badName of ['Bad-Name', 'bad_name', 'bad--name', '-lead', 'trail-']) {
    const badDir = path.join(root, 'badname-' + Math.random().toString(36).slice(2, 8))
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'SKILL.md'), `---\nname: ${badName}\ndescription: Bad name.\n---\n\nBody.\n`)
    const bad = await inspectSkillPath(badDir)
    assert.equal(bad.valid, false, `expected invalid for name "${badName}"`)
  }

  // 无 SKILL.md 的目录
  const emptyDir = path.join(root, 'empty-dir')
  await fs.mkdir(emptyDir, { recursive: true })
  assert.equal((await inspectSkillPath(emptyDir)).valid, false)

  // description 超长（>1024）
  const longDescDir = path.join(root, 'long-desc')
  await fs.mkdir(longDescDir, { recursive: true })
  await fs.writeFile(path.join(longDescDir, 'SKILL.md'), `---\nname: long-desc\ndescription: ${'x'.repeat(1025)}\n---\n\nBody.\n`)
  assert.equal((await inspectSkillPath(longDescDir)).valid, false)

  // ---- inspectSkillPath: 单文件兼容模式 ----
  const singleFile = path.join(root, 'legacy-skill.md')
  await fs.writeFile(singleFile, '---\nname: legacy-skill\ndescription: Legacy single file skill.\n---\n\nLegacy body.\n')
  const single = await inspectSkillPath(singleFile)
  assert.equal(single.valid, true)
  assert.equal(single.kind, 'file')
  assert.equal(single.name, 'legacy-skill')

  // 单文件无 name 时回退到文件名
  const unnamedFile = path.join(root, 'fallback-name.md')
  await fs.writeFile(unnamedFile, '---\ndescription: Name falls back to file name.\n---\n\nBody.\n')
  const unnamed = await inspectSkillPath(unnamedFile)
  assert.equal(unnamed.valid, true)
  assert.equal(unnamed.name, 'fallback-name')

  // 非 .md 文件
  const notMd = path.join(root, 'not-skill.txt')
  await fs.writeFile(notMd, 'hello')
  assert.equal((await inspectSkillPath(notMd)).valid, false)

  // ---- 捆绑文件收集 ----
  const bundleDir = await writeSkill(root, 'bundle-skill')
  await fs.mkdir(path.join(bundleDir, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(bundleDir, 'references'), { recursive: true })
  await fs.mkdir(path.join(bundleDir, 'assets'), { recursive: true })
  await fs.mkdir(path.join(bundleDir, 'node_modules', 'junk'), { recursive: true })
  await fs.mkdir(path.join(bundleDir, 'other-dir'), { recursive: true })
  await fs.writeFile(path.join(bundleDir, 'scripts', 'run.py'), 'print(1)')
  await fs.writeFile(path.join(bundleDir, 'references', 'REF.md'), '# Ref')
  await fs.writeFile(path.join(bundleDir, 'assets', 'tpl.md'), '# Tpl')
  await fs.writeFile(path.join(bundleDir, 'node_modules', 'junk', 'a.js'), '1')
  await fs.writeFile(path.join(bundleDir, 'other-dir', 'ignored.md'), 'x')
  await fs.writeFile(path.join(bundleDir, 'loose.md'), 'loose file outside bundled dirs')

  const bundleInspect = await inspectSkillPath(bundleDir)
  assert.equal(bundleInspect.valid, true)

  // ---- 加载 + 系统提示词（渐进加载：只注入 name+description）----
  await reloadSkills([
    mkConfig('good-skill', goodSkillDir),
    mkConfig('bundle-skill', bundleDir),
    mkConfig('legacy-skill', singleFile),
    mkConfig('bad-skill', emptyDir),
    mkConfig('disabled-skill', goodSkillDir, false)
  ])

  const info = getLoadedSkillsInfo()
  const names = info.map(s => s.name)
  assert.deepEqual(names, ['good-skill', 'bundle-skill', 'legacy-skill'])
  assert.equal(info.find(s => s.name === 'bundle-skill')?.kind, 'folder')
  assert.equal(info.find(s => s.name === 'legacy-skill')?.kind, 'file')

  const prompt = getSkillsSystemPrompt()
  assert.match(prompt, /## Available Skills/)
  assert.match(prompt, /- good-skill: Test skill for unit tests\./)
  assert.match(prompt, /call the `skill` tool/)
  // 正文不得进入系统提示词
  assert.doesNotMatch(prompt, /Do the test thing/)

  // 空配置 → 空提示词、无 skill 工具
  await reloadSkills([])
  assert.equal(getSkillsSystemPrompt(), '')
  refreshSkillTool()
  assert.equal(toolRegistry.get('skill'), undefined)

  // ---- skill 工具 ----
  await reloadSkills([mkConfig('bundle-skill', bundleDir), mkConfig('good-skill', goodSkillDir)])
  refreshSkillTool()
  assert.equal(toolRegistry.get('skill')?.source, 'skill')
  assert.equal(toolRegistry.permission('skill'), 'safe')

  const run = (name: string) => (skillTool.execute({ name }, {}) as Promise<string | { content: string; isError?: boolean }>)

  const bundleOut = (await run('bundle-skill')) as { content: string }
  assert.match(bundleOut.content, /# Skill: bundle-skill/)
  assert.match(bundleOut.content, /Do the test thing/)
  assert.match(bundleOut.content, /scripts\/run\.py/)
  assert.match(bundleOut.content, /references\/REF\.md/)
  assert.match(bundleOut.content, /assets\/tpl\.md/)
  // node_modules 不得出现；根级参考文件应出现；SKILL.md 本身不得进入清单
  assert.doesNotMatch(bundleOut.content, /node_modules/)
  assert.match(bundleOut.content, /loose\.md/)
  assert.doesNotMatch(bundleOut.content, /SKILL\.md/)

  const goodOut = (await run('good-skill')) as { content: string }
  assert.match(goodOut.content, /no bundled files/i)

  const unknownOut = (await run('does-not-exist')) as { content: string }
  assert.match(unknownOut.content, /unknown skill "does-not-exist"/)
  assert.match(unknownOut.content, /- good-skill:/)

  const missingName = await skillTool.execute({}, {})
  assert.equal((missingName as { isError?: boolean }).isError, true)

  // 单文件导入的 root 是所在目录：不得把兄弟文件（其他 skill 的文件）列进清单
  await reloadSkills([mkConfig('legacy-skill', singleFile)])
  refreshSkillTool()
  const legacyOut = (await run('legacy-skill')) as { content: string }
  assert.doesNotMatch(legacyOut.content, /good-skill|bundle-skill|loose\.md/)

  // ---- 正文截断 ----
  const bigDir = await writeSkill(root, 'big-skill', 'Big skill.', '# Big\n' + 'line\n'.repeat(60_000))
  await reloadSkills([mkConfig('big-skill', bigDir)])
  refreshSkillTool()
  const bigOut = (await run('big-skill')) as { content: string }
  assert.match(bigOut.content, /truncated/)
  assert.ok(bigOut.content.length < 120_000)

  // ---- loadSkill 直接调用 ----
  const loaded = await loadSkill(mkConfig('good-skill', goodSkillDir))
  assert.ok(loaded)
  assert.equal(loaded?.name, 'good-skill')
  assert.equal(loaded?.content, '# Test\nDo the test thing.')
  assert.equal(await loadSkill(mkConfig('bad', emptyDir)), null)
  assert.equal(await loadSkill(mkConfig('off', goodSkillDir, false)), null)

  // getSkillContent 未知名返回 null；已知名返回根路径与正文
  await reloadSkills([mkConfig('good-skill', goodSkillDir), mkConfig('bundle-skill', bundleDir)])
  assert.equal(getSkillContent('nope'), null)
  const sc = getSkillContent('good-skill')
  assert.ok(sc)
  assert.equal(sc?.root, goodSkillDir)

  console.log('skill manager + skill tool tests passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

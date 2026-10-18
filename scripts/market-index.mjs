#!/usr/bin/env node
/**
 * Generate the DSH plugin market index (format 1) for this bundle.
 *
 * The entry installs the published npm package (name@version); the icon stays
 * pinned to the current commit. Commit the generated file after the matching
 * npm release is published. See docs/INSTALL.md and market/README.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repoUrl = process.env.PLUGIN_REPO_URL ?? 'https://github.com/aobakaolengmian/dsh-projects.git'
const repoHttp = repoUrl.replace(/\.git$/, '')
const commit = process.env.PLUGIN_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const publishTimestamp = Math.floor(Date.now() / 1000)
// Default is the published npm package; MARKET_SOURCE=git keeps the entry
// installable from the repository before the first npm release exists.
const marketSource = process.env.MARKET_SOURCE === 'git' ? 'git' : 'npm'

const index = {
  format: 1,
  title: { en: "aobakaolengmian's DSH plugins", zh: 'aobakaolengmian 的 DSH 插件' },
  description: {
    en: 'Custom DSH plugin market index for bundles built in this repository.',
    zh: '本仓库构建的 DSH 插件市场索引。',
  },
  metadata: {
    categories: {
      productivity: { title: { en: 'Productivity', zh: '效率' } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: { en: 'Projects', zh: '项目' },
      description: {
        en: 'Claude-Desktop-style projects sidebar for DSH Desktop: group conversations into projects, keep per-conversation working directories, drag or use menus to move conversations/workspaces between projects, and permanently clean empty conversations.',
        zh: '为 DSH Desktop 提供类似 Claude Desktop 的项目侧栏：把会话归入项目、为每个会话选择工作目录、拖拽或通过菜单在项目间迁移会话/工作区，并彻底清理空会话。',
      },
      icon: `https://raw.githubusercontent.com/aobakaolengmian/dsh-projects/${commit}/icon.svg`,
      author: 'aobakaolengmian',
      homepage: repoHttp,
      repository: { url: repoHttp },
      metadata: {
        category: 'productivity',
        keywords: ['projects', 'sidebar', 'workspace', 'conversations', 'claude-desktop'],
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp,
          source:
            marketSource === 'git'
              ? { type: 'git', url: repoUrl, commit }
              : { type: 'npm' },
        },
      ],
    },
  ],
}

const target = join(root, 'market', 'index.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${target}`)
console.log(`pinned commit ${commit}`)

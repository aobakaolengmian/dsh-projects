#!/usr/bin/env node
/**
 * Generate the DSH plugin market index (format 1) for the bundles published
 * from this account:
 *
 * - Projects — the bundle built in this repository.
 * - Split View — `@wxysskd/dsh-split-view`, built in its own repository.
 *
 * Every entry installs the matching published npm package (name@version); icons
 * stay pinned to the current commit of the bundle's repository. Commit the
 * generated file after the matching npm release is published. See
 * docs/INSTALL.md and market/README.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publishTimestamp = Math.floor(Date.now() / 1000)

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const gitCommit = (dir) => {
  const pinned = dir === root ? process.env.PLUGIN_COMMIT : process.env.SPLIT_VIEW_COMMIT
  return pinned ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}
const gitRemote = (dir) => {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

// Default is the published npm package; MARKET_SOURCE=git keeps an entry
// installable from its repository before the first npm release exists.
const marketSource = process.env.MARKET_SOURCE === 'git' ? 'git' : 'npm'
const versionSource = (repoUrl, commit) =>
  marketSource === 'git' ? { type: 'git', url: repoUrl, commit } : { type: 'npm' }

const projectsDir = root
const projectsManifest = readManifest(projectsDir)
const projectsRepo = process.env.PLUGIN_REPO_URL ?? 'https://github.com/aobakaolengmian/dsh-projects.git'
const projectsRepoHttp = projectsRepo.replace(/\.git$/, '')
const projectsCommit = gitCommit(projectsDir)

const splitViewDir = process.env.SPLIT_VIEW_DIR ?? resolve(root, '..', 'dsh-split-view')
const splitViewManifest = readManifest(splitViewDir)
const splitViewRepo =
  process.env.SPLIT_VIEW_REPO_URL ?? gitRemote(splitViewDir) ?? 'https://github.com/aobakaolengmian/dsh-split-view.git'
const splitViewRepoHttp = splitViewRepo.replace(/\.git$/, '')
const splitViewCommit = gitCommit(splitViewDir)

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
      name: projectsManifest.name,
      title: { en: 'Projects', zh: '项目' },
      description: {
        en: 'Claude-Desktop-style projects sidebar for DSH Desktop: group conversations into projects, keep per-conversation working directories, drag or use menus to move conversations/workspaces between projects, and permanently clean empty conversations.',
        zh: '为 DSH Desktop 提供类似 Claude Desktop 的项目侧栏：把会话归入项目、为每个会话选择工作目录、拖拽或通过菜单在项目间迁移会话/工作区，并彻底清理空会话。',
      },
      icon: `https://raw.githubusercontent.com/aobakaolengmian/dsh-projects/${projectsCommit}/icon.svg`,
      author: 'aobakaolengmian',
      homepage: projectsRepoHttp,
      repository: { url: projectsRepoHttp },
      metadata: {
        category: 'productivity',
        keywords: ['projects', 'sidebar', 'workspace', 'conversations', 'claude-desktop'],
      },
      versions: [
        {
          version: projectsManifest.version,
          publishTimestamp,
          source: versionSource(projectsRepo, projectsCommit),
        },
      ],
    },
    {
      name: splitViewManifest.name,
      title: { en: 'Split View', zh: '分屏视图' },
      description: {
        en: 'Split-screen Conversation View for DSH Desktop: arrange several live sessions side by side, stacked, in a 2x2 grid or a 3x3 grid. Drag sessions in from the sidebar, including the current one; each pane keeps its own transcript, composer, draft and attachment bar, and the resident header / right sidebar stay intact.',
        zh: '为 DSH Desktop 提供分屏会话视图：把多个实时会话左右并排、上下、田字格或九宫格排列。左侧会话可直接拖入窗格（包括当前会话），每个窗格有独立的记录、输入框、草稿和附件栏，顶部信息栏与右侧栏保持原样。',
      },
      icon: `https://raw.githubusercontent.com/aobakaolengmian/dsh-split-view/${splitViewCommit}/icon.svg`,
      author: 'aobakaolengmian',
      homepage: splitViewRepoHttp,
      repository: { url: splitViewRepoHttp },
      metadata: {
        category: 'productivity',
        keywords: ['split-view', 'layout', 'panes', 'grid', 'conversation', 'workspace'],
      },
      versions: [
        {
          version: splitViewManifest.version,
          publishTimestamp,
          source: versionSource(splitViewRepo, splitViewCommit),
        },
      ],
    },
  ],
}

const target = join(root, 'market', 'index.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${target}`)
console.log(`projects commit ${projectsCommit}`)
console.log(`split-view ${splitViewManifest.name}@${splitViewManifest.version} commit ${splitViewCommit}`)

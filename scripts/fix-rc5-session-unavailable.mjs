#!/usr/bin/env node
/**
 * Work around the DSH Desktop 0.2.1-rc.5 "Session unavailable" regression.
 *
 * rc.5 mounts `@deepseek-ai/dsh-tool-subagent/model-selection-settings` as a
 * STANDING row, while its shipped presets still request
 * `modelSelectionSettings: true` inside a preset scope. Instantiating any such
 * preset fails with
 *
 *   agent-preset/invalid — tool-subagent: standing `modelSelectionSettings`
 *   requires a scoped preset Context
 *
 * so every Session whose recorded preset carries the flag cannot bind an agent
 * and its composer shows "Session unavailable". 0.2.2 removed the flag; this
 * script appends preset overrides (the shipped definitions minus that single
 * flag) to a profile's `cordis.patch.yml`, between marked BEGIN/END comments.
 *
 * Usage:
 *   node scripts/fix-rc5-session-unavailable.mjs --presets <dir> [--profile <dir>]
 *     --presets   directory holding the shipped <preset>.patch.yml files, e.g.
 *                 /tmp/asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets
 *     --profile   profile directory; defaults to $DSH_HOME/profiles/desktop
 *
 * `--check` reports whether the block is already present, `--remove` deletes it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const BEGIN = '# ==== rc.5 session fix BEGIN (dsh-projects) ===='
const END = '# ==== rc.5 session fix END ===='
const PRESETS = ['minimal', 'standard', 'cordis', 'ptc']

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const presetsDir = arg('presets', undefined)
const profileDir = resolve(
  arg('profile', join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')),
)
const patchPath = join(profileDir, 'cordis.patch.yml')
const check = process.argv.includes('--check')
const remove = process.argv.includes('--remove')

if (!existsSync(patchPath)) {
  console.error(`no profile patch at ${patchPath}`)
  process.exit(1)
}
const current = readFileSync(patchPath, 'utf8')
const hasBlock = current.includes(BEGIN)

if (check) {
  console.log(hasBlock ? `fix present: ${patchPath}` : `fix missing: ${patchPath}`)
  process.exit(0)
}

if (remove) {
  if (!hasBlock) {
    console.log('nothing to remove')
    process.exit(0)
  }
  const start = current.indexOf(BEGIN)
  const end = current.indexOf(END) + END.length
  const next = (current.slice(0, start) + current.slice(end)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  writeFileSync(patchPath, next)
  console.log(`removed the rc.5 session fix from ${patchPath}`)
  process.exit(0)
}

if (hasBlock) {
  console.log(`fix already present in ${patchPath}`)
  process.exit(0)
}
if (presetsDir === undefined || !existsSync(presetsDir)) {
  console.error('--presets <dir> must name the shipped dsh-web-app/presets directory')
  process.exit(1)
}

let sawFlag = false
const blocks = []
for (const name of PRESETS) {
  const file = join(presetsDir, `${name}.patch.yml`)
  if (!existsSync(file)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s+- id: preset-${name}\\s*$`).test(line))
  if (start === -1) {
    console.error(`! ${name}: no preset row found`)
    continue
  }
  const block = []
  for (const line of lines.slice(start)) {
    if (line.trim() === '') {
      block.push('')
      continue
    }
    if (!line.startsWith('    ')) break
    const dedented = line.slice(4)
    if (/^\s+modelSelectionSettings:\s*true\s*$/.test(dedented)) {
      sawFlag = true
      continue
    }
    block.push(dedented)
  }
  while (block.length > 0 && block[block.length - 1] === '') block.pop()
  blocks.push(block.join('\n'))
  console.error(`- ${name}: ${block.length} lines`)
}

if (!sawFlag) {
  console.error('these presets carry no modelSelectionSettings flag: this runtime already has the fix (0.2.2+); nothing written')
  process.exit(1)
}

const header = [
  BEGIN,
  '# Desktop 0.2.1-rc.5 mounts @deepseek-ai/dsh-tool-subagent/model-selection-settings as a',
  '# STANDING row while its presets request `modelSelectionSettings: true` inside a preset',
  '# scope, so every session using such a preset fails with `agent-preset/invalid` and shows',
  '# "Session unavailable". The presets below are the shipped 0.2.1-rc.5 definitions with that',
  '# single flag removed. Fixed upstream in 0.2.2: delete this block after upgrading.',
  '#',
].join('\n')
const next = `${current.trimEnd()}\n\n${header}\n${blocks.join('\n\n')}\n${END}\n`
writeFileSync(patchPath, next)
console.log(`\nwrote preset overrides into ${patchPath}`)
console.log('restart the DSH Desktop app to apply.')

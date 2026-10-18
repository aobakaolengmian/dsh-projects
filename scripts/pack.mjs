#!/usr/bin/env node
/**
 * Build the browser bundle and produce a distributable DSH bundle tarball in
 * `dist/`, together with a SHA-256 checksum and a manifest of its contents.
 *
 * The tarball is a plain npm package: `@wxysskd/dsh-projects@<version>`. Install
 * it with the DSH plugin manager (`install_bundle target=<tarball>`) or the
 * Desktop-carried CLI (`plugin --profile desktop add file:<tarball>`).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

// 1. Always rebuild the client half from source before packaging.
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' })

// 2. Produce the tarball (package.json "files" decides the payload).
execFileSync('npm', ['pack', '--pack-destination', dist], { cwd: root, stdio: 'inherit' })

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarball = join(dist, `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`)
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
writeFileSync(`${tarball}.sha256`, `${sha256}  ${tarball.split('/').pop()}\n`)

// 3. Human-readable manifest for the release directory.
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort()
const lines = [
  `@wxysskd/dsh-projects ${manifest.version}`,
  `built: ${new Date().toISOString()}`,
  `tarball: ${tarball.split('/').pop()} (${bytes.length} bytes)`,
  `sha256: ${sha256}`,
  '',
  'contents:',
  ...entries.map((entry) => `  ${entry}`),
  '',
]
writeFileSync(join(dist, 'MANIFEST.txt'), lines.join('\n'))

console.log(`\npackaged ${tarball}`)
console.log(`sha256   ${sha256}`)
console.log(`files    ${entries.length}`)

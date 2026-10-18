/** Bundle the mock harness (all dependencies bundled, unlike the plugin bundle). */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [join(root, 'harness/src/main.jsx')],
  outfile: join(root, 'harness/dist/harness.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  sourcemap: 'inline',
  logLevel: 'warning',
})
console.log('harness/dist/harness.js written')

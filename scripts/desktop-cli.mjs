/**
 * Run the Desktop installation's own dsh CLI with its reserved-profile plugin
 * privileges (the same carrier the Electron app uses for plugin management).
 *
 * Why: in this environment the agent-side `plugin_manager` tool needs an
 * approval prompt, and approvals are disabled. The Desktop-carried CLI is the
 * supported non-interactive equivalent: it is the exact binary + pnpm runtime
 * the app itself invokes, and it sets manageDesktopProfile: true.
 *
 * Usage:
 *   node scripts/desktop-cli.mjs plugin --profile desktop add link:/abs/path/to/dsh-projects
 *   node scripts/desktop-cli.mjs plugin --profile desktop remove @wxysskd/dsh-projects
 *   node scripts/desktop-cli.mjs --profile desktop --dump-config
 *
 * The process must be started with Electron's Node mode:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     scripts/desktop-cli.mjs plugin --profile desktop add link:/abs/path/to/dsh-projects
 */
const APP = '/Applications/DeepSeek Harness.app'
const runtimeDir = `${APP}/Contents/Resources/app.asar/dsh`
const supportDir = `${APP}/Contents/Resources/runtime`

const { runDesktopCli } = await import(
  `file://${APP.replaceAll(' ', '%20')}/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
)

// runCli() parses process.argv.slice(2); drop this script's own path.
process.argv = [process.argv[0], 'dsh', ...process.argv.slice(2)]
await runDesktopCli(runtimeDir, supportDir)

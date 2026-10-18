# Installing the Projects bundle (`@local/dsh-projects`)

The plugin is a normal DSH bundle: one Host row (`dsh-projects`) plus one browser
module (`@local/dsh-projects`). It is installed into a **desktop profile** only
(`~/.dsh/profiles/desktop`), never into `web` or `headless`.

There are two ways to install it: the self-contained **release tarball** (use
this to share the plugin with another machine) and a **source link** (use this
while developing the plugin).

## 1. Release tarball (recommended for installation / sharing)

Build the artifact from a checkout (this also rebuilds `client.js` from source):

```bash
cd /path/to/dsh-projects
npm run pack
# -> dist/local-dsh-projects-1.0.0.tgz
#    dist/local-dsh-projects-1.0.0.tgz.sha256
#    dist/MANIFEST.txt
```

The tarball is a plain npm package and contains everything the runtime needs:
`index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`,
`package.json` and `README.md` (8 files, ~52 KB). Development-only files
(`src/`, `harness/`, `tests/`, `refs/`, `scripts/`, `docs/`) are not shipped.

Install it with the in-app plugin manager when approval prompts are available:

```
plugin_manager install_bundle target=/absolute/path/to/dist/local-dsh-projects-1.0.0.tgz
```

or with the Desktop-carried `dsh` CLI (works without approval prompts):

```bash
APP="/Applications/DeepSeek Harness.app"
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" \
  scripts/desktop-cli.mjs plugin --profile desktop add \
  "file:/absolute/path/to/dist/local-dsh-projects-1.0.0.tgz"
```

This copies the package into the profile, adds it to
`package.json` → `dsh.profile.bundles`, and activates the Host row at the next
app start.

To update: bump `version` in `package.json`, run `npm run pack`, then run the
same `add file:...` command again (or remove + add).

## 2. Source link (development)

Linking keeps the checkout authoritative, so `client.js` rebuilds hot-reload and
source edits are visible without reinstalling:

```bash
APP="/Applications/DeepSeek Harness.app"
cd /path/to/dsh-projects

ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" \
  scripts/desktop-cli.mjs plugin --profile desktop add link:"$PWD"
```

Rebuild the browser half after editing `src/`:

```bash
npm run build     # writes client.js (also covered by `npm run pack`)
```

## 3. Plugin market (Discover tab)

DSH has no official market; the Discover tab reads index sources the user adds.
This repository publishes a format-1 index:

```
https://raw.githubusercontent.com/aobakaolengmian/dsh-projects/main/market/index.json
```

Add it in **Plugins → Discover** (or `plugin_market` reports it once configured)
and install the **Projects** card. The market entry is a commit-pinned Git
source (`git+https://github.com/aobakaolengmian/dsh-projects.git#<commit>`), so
it installs the same code as the tarball; restart once afterwards for the Host
row. Regenerate the index with `npm run market` after pushing a new commit.

## Activation model

- **Host rows** are composed at app boot. A newly installed bundle, a removed
  bundle, any change to `index.js`, or a profile/bundle change becomes live after
  the Desktop app is fully quit and reopened. The session survives the restart.
- **The browser half hot-reloads**: `dsh-client-hmr` watches the bundle file and
  hot-swaps a rebuilt `client.js` in the running page (no restart). This is why
  UI iteration is instant in the development setup. Without the watcher, reload
  the page, then restart if needed.
- **Verification**: `GET /dsh-projects/health` reports the mounted Host routes
  (including `POST /dsh-projects/purge` and `GET /dsh-projects/empty-sessions`
  in this version) and the storage file:

  ```bash
  curl -s http://127.0.0.1:<port>/dsh-projects/health
  ```

  In the sidebar, the shipped Workspaces browser is replaced by the **Projects**
  header with `+`, `⋯` and **Other conversations** below it.

## Rollback

```
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" \
  scripts/desktop-cli.mjs plugin --profile desktop remove @local/dsh-projects
```

Removing the bundle leaves `~/.dsh/storages/dsh-projects.json` untouched; delete
that file to discard all project metadata. Conversations and session logs are
never touched by install/uninstall.

## Artifact verification

The packaged tarball is validated by installing it into a throwaway
`DSH_HOME`/profile with the commands above, booting `dsh web`, checking that the
Host routes answer, and loading the page with a real browser: the Projects
sidebar mounts, `[data-slot="sidebar.workspaces"]` is present, and the console
stays clean.

`dist/MANIFEST.txt` lists the packaged files and the SHA-256 checksum; verify a
shared copy with:

```bash
cd dist
shasum -a 256 -c local-dsh-projects-1.0.0.tgz.sha256
```

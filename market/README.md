# DSH plugin market index

This directory hosts a **format 1 DSH plugin market index** for the bundles in
this repository. DSH has no built-in official market: the **Discover** tab of
the Plugins page lists only index sources the user adds, so this file lets
anyone install the Projects bundle from the market UI.

Index URL (served by GitHub Pages from this directory):

```
https://aobakaolengmian.github.io/dsh-projects/market/index.json
```

## Use it

1. Open **Plugins** in DSH Desktop (the custom plugin markets bundle is already
   part of the Desktop profile).
2. Open the **Discover** tab and add the index URL above as an index source.
3. The **Projects** card appears; installing it runs the normal npm install of
   `@wxysskd/dsh-projects` at the version recorded in the index, then restart
   the app once so the Host row mounts.

The same index works from the `plugin_market` agent tool and the CLI
(`plugin_manager install_bundle target=<target from the index>`).

## Format

The document is validated by `@deepseek-ai/dsh-plugin-market-index`
(format 1). Each version installs the npm package published from this
repository (`@wxysskd/dsh-projects`), so the market entry resolves to
`@wxysskd/dsh-projects@<version>`.

## Regenerate

`market/index.json` is generated from `package.json` + the current commit:

```bash
npm run market
```

For a new release, bump `version`, run `npm publish --access public`, then
`npm run market` and commit the index update. The icon URL stays pinned to the
commit recorded when the index was generated.

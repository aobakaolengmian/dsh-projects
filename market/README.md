# DSH plugin market index

This directory hosts a **format 1 DSH plugin market index** for the bundles
published from this account. DSH has no built-in official market: the
**Discover** tab of the Plugins page lists only index sources the user adds, so
this file lets anyone install the bundles from the market UI.

Index URL (served by GitHub Pages from this directory):

```
https://aobakaolengmian.github.io/dsh-projects/market/index.json
```

## Bundles in this index

| Name | Repository | npm package |
| --- | --- | --- |
| Projects | [aobakaolengmian/dsh-projects](https://github.com/aobakaolengmian/dsh-projects) | `@wxysskd/dsh-projects` |
| Split View | [aobakaolengmian/dsh-split-view](https://github.com/aobakaolengmian/dsh-split-view) | `@wxysskd/dsh-split-view` |

## Use it

1. Open **Plugins** in DSH Desktop (the custom plugin markets bundle is already
   part of the Desktop profile).
2. Open the **Discover** tab and add the index URL above as an index source.
3. The **Projects** / **Split View** cards appear; installing one runs the
   normal npm install of its package at the version recorded in the index, then
   restart the app once so the Host row mounts.

The same index works from the `plugin_market` agent tool and the CLI
(`plugin_manager install_bundle target=<target from the index>`).

## Format

The document is validated by `@deepseek-ai/dsh-plugin-market-index`
(format 1). Each version installs the npm package published from the bundle's
repository, so a market entry resolves to `<package>@<version>`.

## Regenerate

`market/index.json` is generated from the two packages' `package.json` files and
their current commits:

```bash
# Projects (this repository) is read from its own package.json; Split View is
# read from the sibling checkout (or SPLIT_VIEW_DIR=/path/to/dsh-split-view).
npm run market
```

For a new release, bump `version` in the bundle, run
`npm publish --access public` there, then run `npm run market` here and commit
the index update. Icons stay pinned to the commit recorded when the index was
generated.

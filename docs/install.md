# Installing and upgrading the plugin

## From the release zip (most people)

See the README quick start. In short: unzip `palace-atlas-<version>.zip`, put the `palace-atlas` folder in `<vault>/.obsidian/plugins/`, enable it under Settings → Community plugins.

Verify a download (optional):

```sh
shasum -a 256 -c SHA256SUMS      # Linux: sha256sum -c SHA256SUMS
```

`SHA256SUMS` is published next to the zips. It detects a corrupted download; it is not a signature.

## Upgrading

Replace the files inside the plugin folder with the new ones. Keep `data.json` (your settings). Obsidian reloads the plugin automatically when `main.js` changes; if it does not, toggle the plugin off and on.

## Safe installer (checks, backup, rollback)

Works from a built checkout or an unzipped release folder. It copies exactly ten files (`main.js`, `manifest.json`, `styles.css`, `LICENSE`, `NOTICES.md`, `assets/brain.glb`, `assets/brain_low.glb`, `assets/brain_sdf.bin`, `assets/morphologies.json`, `assets/LICENSES.md`), verifies every hash, publishes `main.js` last, and never reads or writes `data.json` or `diag.json`.

```sh
export PA_PLUGIN_DIR="<vault>/.obsidian/plugins/palace-atlas"   # must already exist
export PA_BACKUP_ROOT="$HOME/palace-atlas-backups"

# from a source checkout after `npm run build`:
PA_SRC_DIR=. node scripts/install-plugin.mjs --dry-run     # preflight only, target untouched
PA_SRC_DIR=. node scripts/install-plugin.mjs               # install, prints the backup directory
node scripts/install-plugin.mjs --rollback "<backup-dir>"  # restore the previous files
```

From an unzipped release, the script is not included; copy the folder by hand as above, or run it from a source checkout with `PA_SRC_DIR=<unzipped>/palace-atlas`.

## Troubleshooting

- **Plugin not listed:** `main.js` and `manifest.json` must be directly in `.obsidian/plugins/palace-atlas/`, not in a nested folder.
- **Blank or very slow view:** pick a lower quality in the Atlas settings. Software renderers default to Low.
- **Demo shows a generic brain:** open it with `?asset=assets` so it loads the shipped meshes.
- **Node too old:** the demo server and memory server need Node 20.3 or newer.

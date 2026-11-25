# Development, testing and releasing

Requires Node.js 20.3+ (CI runs 20, 22 and 24) and npm 10+.

## Reproducible clean clone

```sh
git clone https://github.com/afahmi1/palace-atlas.git && cd palace-atlas
npm ci                      # exact versions from package-lock.json
npm run release:guard       # hygiene gate: versions, NOTICES, private strings, script and link references
npm run test:fast           # typecheck, build, memory tests, adapter/assets/cerebellum/contain/installer tests, package + zip parity check
npm run package             # release/*.zip, memory file, SHA256SUMS
```

## Full gate (`npm test`)

Adds the browser and pixel suites. They drive a real Chrome/Chromium with software WebGL and a loopback-only network policy:

```sh
export CHROME="/path/to/chrome"      # default is the macOS Google Chrome path
npm test
```

`npm test` starts with `release-guard`, which refuses to run if a shortening variable (`PA_QUICK`, `PA_PLAN`, `PA_ROOT`, `PA_Q`, `PA_BASELINE_REF`, `CONTAIN_FAST`, `CONTAIN_FIXTURES`) is set. Pixel baselines were recorded on macOS; on other platforms treat `test:pixels` as informational until baselines are regenerated there.

## Script map

| Command | Does |
|---|---|
| `npm run build` | plugin `main.js`, demo and test bundles in `dist-demo/` |
| `npm run build:memory` | `memory/dist/palace-memory.cjs` (+ `core.cjs`) |
| `npm run demo` | build, then serve the synthetic demo on 127.0.0.1:4173 |
| `npm run package` | build everything, write verified zips to `release/` (skips the memory file with a note if it is not built) |
| `npm run package:release` | same, but fails if the memory file is missing |
| `npm run notices` / `notices:check` | regenerate / verify `NOTICES.md`, and audit that every package inside the bundles is listed |
| `npm run release:guard` | hygiene gate described above |
| `npm run test:release` | packages (no rebuild) and checks the zips against the source assets, the installer, `SHA256SUMS`, and (if Chrome is found) loads the installed assets at High and Low quality. `PA_REQUIRE_BROWSER=1` makes a missing Chrome a failure |
| `npm run install-plugin` | safe installer, see [install.md](install.md) |
| `npm run assets:brain`, `assets:cerebellum`, `assets:sdf` | regenerate `assets/*` from the procedural scripts |

## Licensing rules

- Only original, procedurally generated assets ship (`brain.glb`, `brain_low.glb`, `brain_sdf.bin`, `morphologies.json`, with `LICENSES.md` as provenance). Do not add scans, atlas meshes, or third-party neuron reconstructions. `test:assets` checks every morphology cell declares procedural/original/MIT provenance and that `build-morphologies.mjs` reproduces the file byte-for-byte.
- When a new package ends up inside `main.js` or the memory bundle, add it to `BUNDLED` in `scripts/build-notices.mjs` and run `npm run notices`. `notices:check` fails otherwise. esbuild strips license comments, so the verbatim texts live in `NOTICES.md`.
- Note: the MCP SDK is Apache-2.0 (with MIT portions); its full text is carried in `NOTICES.md`.

## CI and releases

- `.github/workflows/ci.yml` runs the guard, typecheck, build, tests and packaging on Linux and macOS for each push and pull request.
- `.github/workflows/release.yml` runs on a `v*` tag, requires the tag to equal the `package.json` version, runs the same checks, builds with `npm run package:release`, runs `node scripts/audit-distribution.mjs --sources . --strict` and attaches `release/*` (plugin zip, demo zip, standalone memory file, `LICENSE`, `NOTICES.md`, `SHA256SUMS`) to a GitHub release. If a release for that tag already exists (for example one a maintainer published from locally audited files), the workflow leaves it untouched.
- To cut a release: bump the version in `package.json` **and** `manifest.json` (the guard checks they match), run `npm run notices`, commit, tag `v<version>`, push the tag.

Neither workflow has been run by this change; check the Actions tab after the first push.

## Privacy checklist before publishing

`npm run release:guard` scans every source file (itself included) for home-directory paths, key material and API-key shapes, and fails on stray `data.json`/`diag.json`/`.env` files. For personal names or project aliases, keep a private list **outside the repository** (one case-insensitive term per line) and point the guard at it:

```sh
PA_PRIVATE_DENYLIST=~/private/palace-denylist.txt npm run release:guard
```

Findings name the file and entry number, never the term. The only identity allowed in the repo is the public GitHub owner/repo taken from `package.json`'s `repository.url`, and only inside a `github.com/<owner>/<repo>` URL. Scanning the built artifacts is a separate step. Review `release/` yourself before attaching it anywhere.

## Known issues

- 0.4.0: `npm run test:pixels -- --full` (part of `npm test`, not of CI) has one deterministic failure out of 1186 objective checks on the
  new procedural brain mesh: `lightning-n1500-high/left-lateral` front-to-back spread. Flash density in the outer bands is about half
  the middle band's (the check needs at least 35%), but the middle band holds 60.6% of flash pixels against a 60% cap. All other pixel,
  browser, containment, memory and release checks pass.

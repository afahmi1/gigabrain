# Palace Atlas bundled assets

Every file in this folder is original, procedurally generated work by the Palace Atlas contributors and is distributed under
the repository's MIT licence. No anatomical scans, third-party meshes, or third-party neuron reconstructions are included.

| File | What it is | How to regenerate |
| --- | --- | --- |
| `brain.glb`, `brain_low.glb` | Stylised cerebrum (two hemispheres), cerebellum and brainstem built from icospheres, procedural noise folds and an analytic cerebellar foliation. Illustration, not anatomy. | `npm run assets:brain` (`scripts/build-brain.mjs`, `scripts/lib/cerebellum-geometry.mjs`) |
| `brain_sdf.bin` | Signed distance field computed from both GLB levels of detail; keeps neurons and lightning inside the brain. | `npm run assets:sdf` (`scripts/build-sdf.ts`) |
| `morphologies.json` | 24 neuron morphologies (pyramidal, stellate, Purkinje-like, interneuron) grown by a seeded stochastic branching program, stored as SWC-style point lists. They are not reconstructions of real cells. | `node scripts/build-morphologies.mjs` |

All generators are deterministic: rerunning them produces byte-identical files.

Method references (ideas only, no data): branching-growth and Rall-like radius taper follow textbook descriptions of
dendritic morphology; the procedural per-note neurons in `src/morph.ts` follow the minimum-spanning-tree growth idea of
Cuntz et al. 2010 (https://doi.org/10.1371/journal.pcbi.1000877).

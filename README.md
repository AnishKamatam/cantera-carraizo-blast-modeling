# Cantera Carraizo Blast Modeling

We are building a 3D digital twin of the Carraizo quarry in Puerto Rico from drone video, then using it to simulate how blast layouts and timing change throw, muckpile shape and vibration on the quarry's real geometry.

> [!WARNING]
> **All results are uncalibrated. Do not use them for safety decisions.** The quarry has no blast records or survey data, so hole layouts, charges and rock properties are labelled assumptions. Use this project to compare scenarios, not to predict absolute outcomes.

## Project status

| Component | State |
|---|---|
| Sparse reconstruction | Complete: 1,232 of 1,232 frames in one model |
| Dense reconstruction and terrain | Complete; accuracy not yet checked |
| Scale check against satellite imagery | Not started |
| Scenario builder and fast-model runner | Built and tested; not yet run on a Carraizo scenario |
| Audit of the blast-physics library | Complete; [open issues remain](docs/verification/README.md#known-open-issues) |
| GPU DEM | Not started |
| GPU MPM and MPM-to-DEM handoff | Not started |
| Validation against real Carraizo blasts | Not started; planned from 3 fixed cameras |

## How it works

```
drone video -> COLMAP on Modal GPUs -> terrain grids and mesh
                                              |
                                              v
                                        blast scenario -> fast JS models -> scenario comparison
                                              |                                     ^
                                              +------> GPU MPM -> GPU DEM ----------+
                                                       (planned)
```

- **Twin (`twin/`):** reconstructs the site from 1 fps video frames, removes vegetation by colour, and exports terrain in local metres. Scale comes from drone telemetry. Gaps up to 15 m are interpolated and flagged.
- **Scenarios (`sim/scenario/`):** cut a closed blast block from the terrain and use the remaining ground as the collision surface. Every assumed value records its range and source.
- **Fast models (`sim/run.js`):** run site-law vibration, Holmberg-Persson damage, McKenzie flyrock burial depth and voxel throw on a scenario. Vibration receptors are abstract rings at set distances, never real locations.
- **Planned GPU solvers:** MPM for fracture and early motion in one block, then DEM for throw and the muckpile on the real terrain. See the [design](docs/design/blast-simulation-design.md).

## Current results

### Terrain

| Measure | Value |
|---|---|
| Dense points | 37.6 million |
| Grid | 0.5 m cells, about 702 m × 654 m |
| Site cells interpolated | 54.3% |

More than half of the site is interpolated rather than measured. The scenario builder rejects blocks with more than 25% interpolated cells by default, so usable blocks are limited to better-measured ground.

### Model check against a surveyed shot

We compared the throw model with `SWELLFACTOR`, a real shot with a surveyed muckpile from a different site. This tests the code, not Carraizo's rock.

| Measure | Surveyed | Model at defaults |
|---|---|---|
| Throw distance | 34.0 m | 13.6–15.3 m |
| Throw direction | 130.1° | 130.1–130.8° |
| Muckpile height error (RMS) | n/a | 5.0–5.9 m, compared with about 7.8 m if nothing moved |

The defaults reach only about 44% of the surveyed throw. Fitting explosive strength to the survey brings throw to 34.3 m, but that is not evidence of accuracy, and the RMS error stays at about 5.2 m. No run fully settled; 93–97% of blocks came to rest. Full figures are in [`results/swellfactor-verification.json`](results/swellfactor-verification.json).

### Library audit

We checked the [blast-physics-js](https://github.com/brentbuffham/blast-physics-js) models against their cited sources and corrected errors that had clear evidence. Its core formulas mostly hold, but several higher-level models were not what they claimed to be. The [verification record](docs/verification/README.md) lists the evidence level and verdict for each model. The [changelog](CHANGELOG.md) lists the corrections, which change some published numbers.

## Limitations

- **Site data:** blast designs and rock properties are assumptions, and the rock type is unconfirmed.
- **Twin accuracy:** the twin is not survey grade. Scale relies on drone GPS until the satellite check is done.
- **Comparisons:** treat any difference between scenarios that falls within the assumed ranges as inconclusive.
- **Existing DEM:** friction is not true Coulomb friction, runs don't fully settle, and about 7% of rock can end up in a mesh artefact at block edges. Results report these effects.
- **Sources:** several cited papers are paywalled, so those models are marked unverified.
- **Planned validation:** the cameras can only verify visible outcomes such as surface change, muckpile extent and firing sequence. Charge, rock strength and vibration will remain unmeasured.

## Getting started

You need Node.js 20 or later.

```bash
npm ci
npm test
node scripts/verify-swellfactor.mjs
```

`verify-swellfactor.mjs` reruns the comparison with the surveyed muckpile.

To run the fast models on an existing scenario directory:

```bash
node scripts/run-scenario.mjs <scenarioDir> [--seed N] [--max-voxels N] [--out DIR]
```

There is no command yet for building a Carraizo scenario. Use the functions in `sim/scenario/` for now.

To check how many deliberate formula breaks the tests catch, copy the repo outside git, run `npm ci` in the copy, and then run:

```bash
python3 scripts/mutation-check.py <copy>
```

### Rebuilding the twin

Reconstruction needs Modal credentials in `.env` and the raw video. We don't distribute the video because it shows the site and people.

```bash
set -a; . ./.env; set +a
modal run --detach twin/modal_twin.py::sparse_full
modal run --detach twin/modal_twin.py::dense
modal run --detach twin/modal_twin.py::terrain
```

Outputs are saved to the `carraizo-twin` Modal volume.

## Repository layout

```
twin/      drone reconstruction pipeline
sim/       scenario builder, fast-model runner and their tests
src/       blast-physics-js library, with audit corrections
test/      library tests
scripts/   reproducible checks and the scenario runner
results/   recorded verification outputs
docs/      verification record, design documents, library API and references
examples/  library demos and the SWELLFACTOR test shot
```

## Credit and license

The physics library is [blast-physics-js](https://github.com/brentbuffham/blast-physics-js) by Brent Buffham, under the MIT license. This repo includes corrected versions of it, so please check whether a correction applies upstream before assuming it does. See [`LICENSE`](LICENSE) and [`CITATION.cff`](CITATION.cff).

# Blast Modelling at the Carraizo Quarry from a Drone-Built Digital Twin

**Status: in progress. All simulation results are uncalibrated and must not be used for safety decisions.**

## Abstract

This project builds a 3D digital twin of the Carraizo quarry in Puerto Rico from drone video and uses it as the real geometry for blast simulation. It combines photogrammetry, an existing open-source blast physics library, and planned GPU solvers using the Material Point Method (MPM) and the Discrete Element Method (DEM). The quarry has no blast records or survey data, so hole layouts, charges and rock properties are labelled assumptions with ranges. Results compare scenarios and don't predict absolute outcomes. We also audited the existing library against its cited research and corrected the errors that had clear evidence. Its core formulas mostly hold, but several higher-level models were not what they claimed to be, and its throw defaults reach only about 44% of the surveyed throw on the shot they were tuned on.

## Research questions

1. Can drone video alone give quarry geometry good enough for blast simulation?
2. How do layout and timing choices change simulated throw, muckpile shape and vibration on real bench geometry?
3. Where do fast empirical models and higher-fidelity MPM/DEM agree and disagree?

## Status

| Component | State |
|---|---|
| Sparse reconstruction | Done: 1,232 of 1,232 frames in one model |
| Dense reconstruction and terrain | Running; not yet verified |
| Scale check against satellite imagery | Not done |
| Scenario builder and runner for existing models | Done and tested |
| Audit of existing models | Done; [open items remain](docs/verification/README.md#known-open-issues) |
| GPU DEM | Not started |
| GPU MPM and MPM-to-DEM handoff | Not started |
| Validation against real Carraizo blasts | Not started; planned from 3 fixed cameras |

## Methods

**Reconstruction** (`twin/`). Photogrammetry with COLMAP on Modal GPUs: 1 fps frames from usable video ([segments](twin/segments.json)), global mapping, PatchMatch stereo split across up to 10 GPUs, depth map fusion, then colour-based vegetation removal and terrain export. Scale comes from drone telemetry. Gaps up to 15 m are interpolated and flagged, so they can't pass for measured rock.

**Scenarios** (`sim/scenario/`). A blast block is cut from the terrain as a closed mesh, and the ground after removing it becomes the collision surface. Blocks on NODATA or heavily interpolated ground are rejected. Every assumed value carries a range and a source.

**Fast models** (`sim/run.js`). Runs the library's site-law vibration, Holmberg-Persson damage, McKenzie flyrock burial depth and voxel throw on a scenario. Receptors are abstract rings at set distances, never real locations.

**Planned solvers.** See the [design](docs/design/blast-simulation-design.md). The audit adds a requirement: the GPU DEM needs real Coulomb friction, because the library's is not.

## Validation so far

Details and evidence levels are in the [verification record](docs/verification/README.md).

**Against the surveyed SWELLFACTOR muckpile** (a real shot at a different site, so this tests the code, not Carraizo's rock):

| Measure | Surveyed | Model at defaults |
|---|---|---|
| Throw distance | 34.0 m | 13.6–15.3 m |
| Throw direction | 130.1° | 130.1–130.8° |
| Muckpile height error (RMS) | n/a | 5.0–5.9 m, against about 7.8 m if nothing moved |

Throw distance only matches after fitting strength to the survey, which is not evidence of accuracy, and fitting barely improves the shape.

**Test strength.** All tests pass, but passing says little alone. In a [mutation check](results/mutation-summary.json) we broke formulas on purpose to see whether tests noticed.

## Limitations

- **No site data:** blast designs and rock properties are assumptions. Rock type is unconfirmed.
- **Twin accuracy:** not survey grade. Scale relies on drone GPS until the satellite check is done, and areas under vegetation are interpolated.
- **Absolute numbers:** throw, vibration and flyrock values are uncalibrated. Use differences between scenarios, and treat any within the assumed ranges as inconclusive.
- **Existing DEM:** friction is not physical, runs don't fully settle, and about 7% of rock can end up in a mesh artefact at block edges. Results report these.
- **Unverified sources:** several cited papers are paywalled, so those models are marked unverified.

## Reproducing

```bash
npm ci
npm test                                  # all tests
node scripts/verify-swellfactor.mjs       # comparison with the surveyed muckpile
python3 scripts/mutation-check.py <copy>  # test strength, on a throwaway copy of the repo
node scripts/run-scenario.mjs <scenario>  # existing models on a scenario
```

Reconstruction needs Modal credentials in `.env` and the raw video, which is not distributed because it shows the site and people:

```bash
set -a; . ./.env; set +a
modal run --detach twin/modal_twin.py::sparse_full
modal run --detach twin/modal_twin.py::dense
modal run --detach twin/modal_twin.py::terrain
```

## Repository layout

```
twin/          drone reconstruction pipeline
sim/           scenario builder, runner and their tests
src/ test/     blast-physics-js library, with audit corrections
scripts/       reproducible checks and the scenario runner
results/       recorded verification outputs
docs/
  verification/  evidence for each model, and known open issues
  design/        simulation design and build plans
  library.md     library documentation and API
  references.bib references confirmed during the audit
examples/      library demos and the SWELLFACTOR test shot
```

## Credit and license

The physics library is [blast-physics-js](https://github.com/brentbuffham/blast-physics-js) by Brent Buffham, MIT license, and this repo includes corrected versions of it. See [LICENSE](LICENSE) and [CITATION.cff](CITATION.cff). Please report library corrections upstream rather than assuming they apply there.

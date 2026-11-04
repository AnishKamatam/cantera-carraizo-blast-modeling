# Carraizo blast simulation: design

Date: 2026-11-03. Status: approved in outline by the project owner; details below marked "builder's call" were not separately reviewed.

## Intent

Simulate blasts at the Carraizo quarry on its real geometry, using a drone-built digital twin, new GPU MPM and DEM solvers, and the blast models already in this repo. The aim is to compare blast scenarios, such as layouts and delay timings, and see how outcomes change.

Everything lives in this repository (owner's instruction).

## Goals

1. Build a blast scenario from the twin: a chosen block on a real bench, plus a hole layout, charges and timing.
2. Run the repo's existing vibration, damage, flyrock and throw models on that scenario.
3. Simulate fracture and early motion in one blast block with 3D MPM on GPU.
4. Hand MPM's state to a GPU DEM that computes throw and the muckpile on the real terrain.
5. Report comparisons between scenarios and between methods, with uncertainty ranges.
6. Leave a clear route to verification against footage from the 3 quarry cameras.

## Non-goals

- Whole-quarry MPM. It is too expensive at useful resolution.
- Simulating detonation chemistry. Explosive loading is applied as a borehole pressure history.
- Rewriting or replacing the existing JS library. Its public API stays compatible.
- The camera verification work itself. The owner has deferred it.
- A front-end application beyond viewers needed to inspect results.

## Anti-goals

Any of these would make the work a failure even if the code runs:

- Presenting uncalibrated throw, vibration or flyrock numbers as predictions, or as a basis for safety decisions. Homes are visible beyond the quarry rim.
- Presenting assumed blast designs or rock properties as measured site data.
- Committing credentials, raw footage, licensed satellite imagery, or footage showing people or homes. This repo is public.
- Adding GPL code to this MIT repo.

## Facts and constraints

- **No site records:** the quarry keeps no blast records, and there is no survey. The owner cannot document a blast by drone.
- **Future verification:** 3 fixed cameras that the owner says all see the entire quarry with overlap. Their footage is not available yet.
- **Compute:** Modal GPUs, with credentials in `.env`. The Mac has about 8.5 GB of free disk and no NVIDIA GPU, so large data stays on the Modal volume `carraizo-twin`.
- **Twin:** `twin/`, run through `twin/modal_twin.py`. Stages are frame sampling, telemetry georeferencing, sparse mapping, dense stereo, and terrain. The terrain stage is expected to write local-metre DSM and DTM grids, a mesh and an orthomosaic under `/full/terrain/` on the volume. Coordinates are local east-north-up, origin 18.332, -66.019. Scale comes from drone telemetry, and a satellite check is still outstanding.
- **Existing code:** `src/movement/` has a Yang kinematic launch and sphere DEM, defaulting to 30,000 blocks. It collides with a flat ground plane at the bottom of the blast block, which stops rock from falling to a lower bench.
- **Benchmark:** `examples/SWELLFACTOR.kap` has 531 holes, a pre-blast volume, a shell and a surveyed post-blast muckpile. It is a real shot from a different site.

## Decisions made by the owner

- All work goes in this repo.
- Use MPM and DEM together with the existing blast code.
- Results stay uncalibrated until compared with camera footage.
- Build in the order below, with Warp as the GPU framework.

## Pipeline

```
twin terrain -> scenario file -> fast JS models -> comparison report
                     |                                   ^
                     +---> GPU MPM (block) -> GPU DEM ---+
```

### Scenario file

One JSON document, plus binary sidecars for large arrays, read by both JS and Python. Its holes, decks and surfaces follow the shapes `parseKAP` returns, so `BlastMovementSimulator.load()` can use them directly. Surface roles are `voxelblk`, `shell`, `shelltopo` and `reference`.

Every scenario records:

- which values are measured and which are assumed, and the source of each assumption;
- the twin version it was cut from, and the fraction of its cells that were interpolated;
- a value range for each assumed parameter, used by sweeps.

### Stage 1: scenario builder

Cuts a closed blast-block volume from the DTM, takes the surrounding terrain as collision geometry, and generates an assumed hole pattern. Assumed values are typical quarry values and published ranges for the rock type, all labelled as assumptions.

The block must sit on ground that was actually measured. Blocks that rely heavily on interpolated cells are rejected or flagged.

### Stage 2: existing JS models

A Node runner takes a scenario and produces vibration at chosen receptors, damage, flyrock and throw. It must add terrain-following ground collision so rock can fall to lower benches. This must not change results for existing uses: the current behaviour stays the default, and existing tests must still pass.

### Stage 3: GPU MPM

Explicit 3D MPM in Warp on a single blast block.

- **Loading:** a borehole pressure history per deck, starting at that deck's fire time. It should be consistent with `src/pressure/BoreholePressure.js`. Holes are smaller than a particle, so loading is applied over nearby particles.
- **Rock:** a pressure-dependent strength model with tensile damage. Parameters come from published ranges.
- **Boundaries:** the surrounding rock must absorb outgoing waves, so reflections don't produce false fracture.
- **Resolution:** start at 0.5 m, about 4M particles for a 60,000 m³ block. Move to 0.25 m, about 30M, only if a convergence test shows it matters.
- **Build-up:** one hole, then a few holes with delays, then a full block.

### Stage 4: GPU DEM and handoff

Sphere DEM in Warp, with collision against the twin terrain mesh. Handoff converts MPM material into DEM spheres after motion is established, conserving mass and momentum. Spheres take their size from MPM's damage field. The handoff error in mass, momentum and kinetic energy is reported for every run.

### Stage 5: comparison

Runs each scenario across its assumed ranges and reports differences between scenarios. If a difference falls within the spread from the assumptions, the report calls it inconclusive. All output carries an "uncalibrated" label.

## Verification

Each solver must pass these before use on Carraizo:

| Check | Target |
|---|---|
| Conservation | Mass exact; momentum and energy within tolerances set in the plan |
| MPM wave speed | Elastic wave in a rock bar matches the analytic speed |
| MPM boundaries | A wave leaving the domain produces little reflection |
| MPM convergence | Key outcomes stable when particle size is halved |
| DEM contact | Drop and rebound match the set restitution; a pile's angle of repose responds correctly to friction |
| Single-hole MPM | Crushed and fractured radii fall within published ranges for similar charges |
| Against JS models | Differences from the existing models are explained, not hidden |
| SWELLFACTOR | Muckpile shape, centre-of-mass throw and swell, compared with the survey and the current JS result |

SWELLFACTOR tests the code, not Carraizo's rock. Reports must say so.

## Repository layout

```
twin/                 reconstruction (exists)
src/                  existing JS library, published to npm
sim/                  new simulation code
  scenario/           JavaScript scenario schema and builder
  run.js              runner for the existing JS models
  test/               vitest suite for the JavaScript code
  mpm/                Warp MPM solver
  dem/                Warp DEM solver
  handoff/            MPM-to-DEM conversion
  report/             sweeps and comparison
  modal_sim.py        Modal entry points
  tests/              pytest suite for the Python solvers, without a GPU where possible
scripts/              Node runner for scenarios
docs/design/          designs and plans
```

`sim/`, `twin/` and `scripts/` stay outside the npm package, whose `files` field already limits it to `dist/`, `src/` and `CHANGELOG.md`. Simulation outputs stay on the Modal volume and out of git.

## Delivery order

1. Stages 1 and 2 on the twin terrain, giving a first full scenario with existing models.
2. GPU DEM, benchmarked on SWELLFACTOR.
3. MPM, then the handoff, building up from one hole to a full block.
4. Comparison reports throughout, as each piece arrives.

## Calls made in design review

These were settled by the designer, not the owner, and can be overridden.

- **Sweeps:** the existing JS models and DEM run the parameter sweeps. Full MPM+DEM runs only a few anchor cases, because each may take around an hour of GPU time. Reports must say which comparisons have MPM behind them, and MPM anchors alone do not earn a "conclusive" result.
- **Inconclusive test:** scenarios are compared in pairs with the same sampled rock and explosive values, and seeds. A difference is inconclusive if the paired differences span zero. Reports show absolute spreads alongside.
- **SWELLFACTOR scope:** a DEM benchmark only, launched with the JS Yang velocities. At about 144,000 m³ it is too large to be an MPM gate. MPM and the handoff have to pass their own checks in the verification table, on smaller problems.
- **Tuning on SWELLFACTOR:** the existing defaults were tuned on this shot, and `calibrate()` fits to its surveyed throw. Fitted throw and prescribed swell are therefore not evidence of accuracy. Each comparison states whether a value was fitted, and muckpile shape is the main independent measure.
- **Carraizo parameters:** defaults tuned on another site may be used as labelled assumptions with ranges. They never count as Carraizo calibration.
- **Mass and swell:** sphere growth toward a target swell changes contact radius, never mass.
- **Homes:** receptors are abstract points at set distances from the block. Real home locations stay out of the repo and the reports. Reports stay private on the Modal volume unless the owner chooses otherwise.
- **MPM loading:** match the impulse and energy delivered through each hole's true area, rather than applying peak borehole pressure across a particle. The 5 GPa peak is far too high at that scale.
- **Single-hole check:** run at finer resolution than production, because the crushed zone is smaller than a 0.5 m particle. If production loading is adjusted to match published radii, that adjustment is recorded as a labelled assumption.
- **Scale check:** does not block Stage 1. Scenarios record their twin version and are re-cut if the twin changes. Scale and vertical tilt become swept assumptions, because a satellite check says little about vertical accuracy.
- **Camera route:** scenarios allow every design value to be unknown, and solvers keep time-resolved surface outputs, so footage can be compared later without rerunning.

## Left to the builder

- Exact scenario schema, sidecar format and module boundaries.
- The specific rock strength model and how damage is represented, provided the verification table passes.
- Numerical tolerances, sweep sizes and how sweeps run in parallel on Modal.
- When MPM hands off to DEM, within the constraint that motion is established.
- GPU type and count.
- Which bench is used for the first scenario, chosen from the finished terrain and flagged to the owner.
- Rock type used for assumptions: identify it from public geological sources and label it unconfirmed.

## Open items

- The twin's terrain does not exist yet. Stage 1 depends on it, and its outputs may change the builder's assumptions.
- Camera model, resolution and frame rate are unknown. This does not block this work.

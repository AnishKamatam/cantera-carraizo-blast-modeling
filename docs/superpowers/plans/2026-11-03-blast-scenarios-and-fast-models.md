# Blast Scenarios and Fast Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Carraizo twin's terrain, or a Kirra `.kap`, into a labelled blast scenario and run the repo's existing vibration, damage, flyrock and throw models on it from the command line.

**Architecture:** A scenario is JSON plus binary surface sidecars, with holes, decks and surfaces in the shapes `parseKAP` returns. A JS builder creates it from terrain grids and an assumed design. A Node runner feeds it to the existing library and writes results marked uncalibrated. Later plans add the Warp DEM and MPM solvers, which read the same scenario files.

**Tech Stack:** Node 20+, ES modules, vitest, the existing `src/` library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-blast-simulation-design.md`

**Scope:** Spec stages 1 and 2 only. Separate plans follow for the GPU DEM (stage 4), MPM and handoff (stage 3), and comparison reports (stage 5).

## Global Constraints

- Everything lives in this repo. New code goes under `sim/` and stays outside the npm package.
- Every assumed value carries `{ value, range, source }`. Nothing assumed may pass for measured data.
- Every results file carries `"calibration": "uncalibrated"`.
- Receptors are abstract points at set distances. Real home locations never enter the repo or results.
- Existing library behaviour stays the default. All 219 current tests must keep passing.
- Local units and axes: metres, X east, Y north, Z up.
- No GPU jobs and no Modal runs in this plan.
- Terrain, scenarios and results stay out of git, in `sim/data/` and `sim/out/`.
- Do not commit unless the project owner has asked. Commit steps below apply only then.
- `sim/scenario` is JavaScript, not Python, a change from the spec's layout, because it shares shapes and tests with the library. Python solvers in later plans read its files.

## Review Focus

- A blast polygon that crosses NODATA cells: expect an error naming the problem, not a block with a hole in it.
- A polygon mostly over interpolated ground: expect rejection, with the fraction stated.
- North-south orientation of `.asc` rows: a flipped read would put the block in the wrong place while every number still looks reasonable.
- A design that fits no holes in the polygon: expect an error, not a scenario with zero charge and blank results.
- A throw run that hits its time limit before settling: expect `settled: false` carried into the results, not reported as a finished muckpile.

---

### Task 1: Scenario format and files

**Files:**
- Create: `sim/scenario/schema.js`, `sim/scenario/io.js`, `sim/test/scenario.test.js`
- Modify: `.gitignore` (add `sim/data/` and `sim/out/`)

**Interfaces:**
- Produces:
  - `assumption(value, range, source) -> { value, range, source }`, throwing if `range` is not `[low, high]` containing `value`, or `source` is empty
  - `validateScenario(s) -> s`, throwing an `Error` that names the first problem
  - `writeScenario(dir, s) -> void`, `readScenario(dir) -> s`
  - `toSimData(s) -> { holes, decks, surfaces }` for `BlastMovementSimulator.load()`
- Scenario fields: `version: 1`, `name`, `origin: { lat, lon } | null`, `twin: { version, filledFraction } | null`, `holes`, `decks`, `surfaces`, `assumptions` (object of assumption records), `measured` (array of field names)

- [ ] **Step 1: Write failing tests**

```js
it("rejects an assumption without a source or outside its range", () => {
  expect(() => assumption(3.5, [3, 4.5], "")).toThrow(/source/);
  expect(() => assumption(5, [3, 4.5], "typical")).toThrow(/range/);
});
it("rejects a scenario with no holes or an unlabelled assumption", () => {
  expect(() => validateScenario({ ...valid, holes: [] })).toThrow(/holes/);
  expect(() => validateScenario({ ...valid, assumptions: { burden: 3.5 } })).toThrow(/burden/);
});
it("round-trips surfaces through sidecars without changing a byte", () => {
  writeScenario(dir, valid);
  const back = readScenario(dir);
  expect(Array.from(back.surfaces[0].pos)).toEqual(Array.from(valid.surfaces[0].pos));
  expect(back.surfaces[0].idx).toBeInstanceOf(Uint32Array);
  expect(back.surfaces[0].role).toBe("voxelblk");
});
it("toSimData output loads into the simulator", () => {
  const sim = new BlastMovementSimulator({ seed: 1 }).load(toSimData(valid));
  expect(sim.holes.length).toBe(valid.holes.length);
});
```

`valid` is a small fixture: one hole, one deck, one 12-triangle box surface. Write to a temp directory.

- [ ] **Step 2: Run:** `npx vitest run sim/test/scenario.test.js`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement.** Files on disk: `scenario.json`, `surfaces/<id>.pos` (Float64 xyz), `surfaces/<id>.idx` (Uint32). This matches the `.kap` sidecar layout. `writeScenario` validates first and strips typed arrays from the JSON.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): scenario format and files`, if asked.

### Task 2: Scenario from a Kirra archive

**Files:**
- Create: `sim/scenario/fromKap.js`, `sim/test/fromKap.test.js`

**Interfaces:**
- Consumes: `validateScenario`, `parseKAP(source)` from `src/io/KAPReader.js`
- Produces: `scenarioFromKap(parsed, { name }) -> scenario`, with `measured: ["holes", "decks", "surfaces"]` and `assumptions: {}`

- [ ] **Step 1: Write failing test** reading `examples/SWELLFACTOR.kap`:

```js
expect(s.holes.length).toBe(531);
expect(s.surfaces.some(x => x.role === "voxelblk")).toBe(true);
expect(s.surfaces.some(x => x.role === "reference")).toBe(true);
expect(s.twin).toBeNull();
expect(s.measured).toContain("holes");
```

- [ ] **Step 2: Run:** `npx vitest run sim/test/fromKap.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Copy fields across, then validate. Keep surface ids filesystem-safe.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): build scenarios from kap archives`, if asked.

### Task 3: Terrain grids and block cutting

**Files:**
- Create: `sim/scenario/terrain.js`, `sim/scenario/block.js`, `sim/test/block.test.js`

**Interfaces:**
- Consumes: `dtm.asc` and `filled.asc` from `twin/modal_twin.py::terrain`. Row 0 of an `.asc` file is the **north** row. NODATA is `-9999`.
- Produces:
  - `parseAsc(text) -> { cols, rows, x0, y0, cell, z: Float64Array }`, stored south-to-north with `NaN` for NODATA
  - `heightAt(grid, x, y) -> number`, returning the value of the cell containing the point
  - `loadTerrain(dir) -> { dtm, filled }`
  - `cutBlock(terrain, polygon, { floorZ, maxFilled = 0.25, topoPadM = 100, topoStride = 2 }) -> { volume, topo, filledFraction, volumeM3, centroid, polygon, floorZ }`
  - `volume` is a closed mesh with role `voxelblk`. `topo` has role `shelltopo`.
- Polygon: `[[x, y], ...]` in local metres.

- [ ] **Step 1: Write failing tests** using a small tilted-plane grid, `z = 100 + 0.1 * y`, in `.asc` text:

```js
it("reads the first row as north", () => {
  const g = parseAsc(ascFixture);
  expect(heightAt(g, 5, 95)).toBeGreaterThan(heightAt(g, 5, 5));
});
it("computes block volume and a closed mesh", () => {
  const b = cutBlock(flatTerrain(110), square(20), { floorZ: 100 });
  expect(b.volumeM3).toBeCloseTo(20 * 20 * 10, -1);
  // every edge shared by exactly two triangles
  expect(openEdges(b.volume)).toBe(0);
});
it("errors when the polygon crosses NODATA", () => {
  expect(() => cutBlock(withHole, square(20), { floorZ: 100 })).toThrow(/NODATA/);
});
it("rejects mostly interpolated ground and states the fraction", () => {
  expect(() => cutBlock(mostlyFilled, square(20), { floorZ: 100 })).toThrow(/filled.*0\.[0-9]+/);
});
it("errors when floorZ is above the ground", () => {
  expect(() => cutBlock(flatTerrain(110), square(20), { floorZ: 120 })).toThrow(/floorZ/);
});
```

- [ ] **Step 2: Run:** `npx vitest run sim/test/block.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Include each grid cell whose centre is inside the polygon. The top follows the DTM, the bottom is flat at `floorZ`, and walls close the boundary edges. `topo` is the DTM within `topoPadM` of the polygon, sampled every `topoStride` cells, skipping NODATA.
- [ ] **Step 4: Add `filled.asc` to the export check.** Confirm `terrain` in `twin/modal_twin.py` writes `filled.asc` next to `dtm.asc`. The cell values are 0 or 1.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(sim): read terrain grids and cut blast blocks`, if asked.

### Task 4: Assumed blast design

**Files:**
- Create: `sim/scenario/pattern.js`, `sim/test/pattern.test.js`

**Interfaces:**
- Consumes: `assumption`, `heightAt`, `cutBlock` output, `createHoleEntry`, `createDeckEntry`
- Produces:
  - `DEFAULT_DESIGN`, an object of assumption records
  - `generatePattern(block, terrain, overrides = {}) -> { holes, decks, assumptions }`
  - `scenarioFromTerrain(terrain, polygon, { name, floorZ, overrides, twinVersion }) -> scenario`, including `topo` and `volume` as surfaces and `twin.filledFraction`

`DEFAULT_DESIGN` values, all with source `"typical quarry value, not Carraizo data"`:

| Field | Value | Range |
|---|---|---|
| `holeDiamMm` | 115 | 89–140 |
| `burdenM` | 3.5 | 2.5–4.5 |
| `spacingM` | 4.0 | 3.0–5.5 |
| `subdrillM` | 1.0 | 0.5–1.5 |
| `stemmingM` | 2.5 | 2.0–3.5 |
| `explosiveDensityKgL` | 1.15 | 0.85–1.25 |
| `vodMs` | 4500 | 3500–5500 |
| `holeDelayMs` | 17 | 9–42 |
| `rowDelayMs` | 42 | 25–100 |
| `rockDensityKgM3` | 2650 | 2400–2800 |
| `siteLawK` | 1140 | 500–1800 |
| `siteLawB` | 1.6 | 1.3–1.8 |

`rockType` is `{ value: "unconfirmed", source: "no site geology available" }`, exempt from the numeric range rule.

- [ ] **Step 1: Write failing tests:**

```js
it("charges each hole between stemming and toe with the right mass", () => {
  const { decks } = generatePattern(block, terrain);
  const d = decks[0];
  const lengthM = d.topZ - d.baseZ;
  const areaM2 = Math.PI * (0.115 / 2) ** 2;
  expect(d.mass).toBeCloseTo(areaM2 * lengthM * 1150, 1);
});
it("collars sit on the terrain and toes below the floor by the subdrill", () => {
  const { holes } = generatePattern(block, terrain);
  expect(holes[0].collarZ).toBeCloseTo(heightAt(terrain.dtm, holes[0].collarX, holes[0].collarY), 2);
  expect(holes[0].toeZ).toBeCloseTo(block.floorZ - 1.0, 2);
});
it("fires later rows later", () => { /* holeTime increases by rowDelayMs between rows */ });
it("errors when no holes fit", () => {
  expect(() => generatePattern(tinyBlock, terrain)).toThrow(/no holes/);
});
it("overrides must stay labelled", () => {
  const { assumptions } = generatePattern(block, terrain, { burdenM: 3 });
  expect(assumptions.burdenM.value).toBe(3);
  expect(assumptions.burdenM.source).toMatch(/override/);
});
it("skips holes too short to charge below the stemming", () => { /* expect no deck with non-positive length */ });
it("builds a scenario that validates and loads", () => {
  const s = scenarioFromTerrain(terrain, polygon, { name: "t", floorZ: 100, twinVersion: "test" });
  expect(() => new BlastMovementSimulator({ seed: 1 }).load(toSimData(s))).not.toThrow();
  expect(s.measured).toEqual(["surfaces"]);
});
```

- [ ] **Step 2: Run:** `npx vitest run sim/test/pattern.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** A rectangular grid of vertical holes inside the polygon. Rows run east-west, row 0 is the most southerly, and the row direction becomes an option when a free face is chosen. Deck mass comes from hole area, length and density.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): generate assumed blast designs`, if asked.

### Task 5: Let rock fall below the blast block

**Files:**
- Modify: `src/movement/BlastMovementSimulator.js` (`SIM_DEFAULTS` and `generateVoxels`, around line 144)
- Modify: `CHANGELOG.md`
- Test: `test/movement.test.js`

**Interfaces:**
- Produces: option `groundZ` (world Z, default `null`). When `null`, behaviour is unchanged. When set, `S.groundZ = groundZ - origin.z - S.radius`.

- [ ] **Step 1: Write failing tests:**

```js
it("default ground plane is unchanged", () => { /* seeded run without groundZ gives the same comShift as the current code, pinned to a recorded value */ });
it("groundZ lets blocks settle below the block's base", () => {
  // box volume on a raised ledge, with a lower topo surface beside it
  const sim = new BlastMovementSimulator({ seed: 1, groundZ: -50, maxVoxels: 2000 });
  // load, generateVoxels, run to settled
  // some block must end below the volume's minimum Z
});
```

Record the pinned value from a run on the current code before editing the simulator.

- [ ] **Step 2: Run:** `npx vitest run test/movement.test.js`. Expected: only the `groundZ` test fails.
- [ ] **Step 3: Implement** the option and add a CHANGELOG line.
- [ ] **Step 4: Run:** `npx vitest run`. Expected: PASS, 219 existing tests plus new ones.
- [ ] **Step 5: Commit** `feat(movement): optional ground level below the blast block`, if asked.

### Task 6: Run the fast models

**Files:**
- Create: `sim/run.js`, `scripts/run-scenario.mjs`, `sim/test/run.test.js`

**Interfaces:**
- Consumes: `readScenario`, `toSimData`, `computePPVDeck`, `computeHolmbergPerssonDamage`, `computeSDoBAtPoint`, `chargeColumnsFromDecks`, `BlastMovementSimulator`
- Produces:
  - `abstractReceptors(centre, distancesM = [100, 250, 500, 1000], bearings = 8) -> [{ x, y, z, distanceM, bearingDeg }]`
  - `async runFastModels(scenario, { seed, maxVoxels = 30000, overrides = {} }) -> results`
  - CLI: `node scripts/run-scenario.mjs <scenarioDir> [--seed N] [--max-voxels N] [--out DIR]`, default output `sim/out/<name>/results.json`
- `results` fields: `calibration: "uncalibrated"`, `scenario`, `assumptionsUsed`, `vibration: [{ distanceM, bearingDeg, ppvMmS }]`, `damage: { peakPpvMmS, atPoint }`, `flyrock: { minSdob, band }`, `throw: { comShift, swell, swellIsPrescribed: true, settled, blockCount, time }`

Site-law K and B come from `assumptions` when present, otherwise the library defaults, and `assumptionsUsed` records which applied. `groundZ` is set 5 m below the lowest `shelltopo` vertex when a topo surface is present, otherwise left `null`. Damage samples 1 m outside the volume's lateral bounds at mid-bench height. `flyrock` uses `computeSDoBAtPoint` at the hole collars and `sdobRiskBand`.

- [ ] **Step 1: Write failing tests:**

```js
it("receptors are abstract rings around the centre", () => {
  const r = abstractReceptors({ x: 0, y: 0, z: 0 });
  expect(r.length).toBe(32);
  expect(Math.hypot(r[0].x, r[0].y)).toBeCloseTo(100);
});
it("matches a direct simulator run on SWELLFACTOR", async () => {
  const res = await runFastModels(swell, { seed: 7, maxVoxels: 2000 });
  const direct = await directRun(swellParsed, { seed: 7, maxVoxels: 2000 });
  expect(res.throw.comShift.D).toBeCloseTo(direct.comShift.D, 6);
  expect(res.calibration).toBe("uncalibrated");
  expect(res.throw.swellIsPrescribed).toBe(true);
});
it("vibration falls with distance", async () => { /* mean PPV at 100 m exceeds mean at 1000 m */ });
it("reports an unsettled run as unsettled", async () => {
  const res = await runFastModels(swell, { seed: 7, maxVoxels: 500, overrides: { maxSimTimeS: 0.05 } });
  expect(res.throw.settled).toBe(false);
});
it("CLI writes results.json", () => { /* run on a small terrain-built scenario; parse the output */ });
```

- [ ] **Step 2: Run:** `npx vitest run sim/test/run.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `sim/run.js`, then the thin CLI.
- [ ] **Step 4: Run:** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: First real run, after `/full/terrain/` exists.** Download `dtm.asc` and `filled.asc` to `sim/data/full/` with `modal volume get`. Choose a block on measured ground on an active bench, then flag the choice to the owner. Build the scenario and run the CLI. Expected: `results.json` with `settled: true` and a filled fraction under 0.25. If the terrain looks unreliable there, report it and pick another block.
- [ ] **Step 6: Commit** `feat(sim): run existing blast models on a scenario`, if asked.

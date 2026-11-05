#!/usr/bin/env node
// The shared yardstick: score one simulator run against the surveyed muckpile in
// examples/SWELLFACTOR.kap (a real shot, from a different site than Carraizo).
// Usage: node scripts/score-swellfactor.mjs [--options JSON] [--out FILE]
//   --options  JSON passed to BlastMovementSimulator, e.g. '{"maxVoxels":5000,"contactModel":"coulomb","friction":0.5}'.
//              seed defaults to 1 and maxVoxels to 15000.
//
// Every run is scored on one fixed grid: 2 m columns over the blast volume plus a
// 40 m pad, keeping every cell where both the survey and the remaining shell exist.
// A cell with no block takes the remaining shell, so a run can't improve its score
// by landing in fewer cells. Throw and bearing are reported, never used to tune.
//
// Compare runs with `scoreSpheres`: each sphere is drawn at its true size. `score` bins
// block centres into cells, which leaves holes when blocks outsize a 2 m cell (below
// about 15,000 blocks here). Use it only against the 6.3 m recorded before this script.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseKAP } from "../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../src/movement/BlastMovementSimulator.js";
import { rasterTop, calibrationGrid, columnThickness } from "../src/movement/SurfaceMesh.js";
import { ST_INACTIVE } from "../src/movement/SphereDEM.js";
import { sphereColumns } from "../src/movement/Displacement.js";

const PILE_DEPTH_M = 0.5; // a cell is "in the pile" when this far above the remaining shell (judgement)

const { values } = parseArgs({ options: { options: { type: "string" }, out: { type: "string" } } });
const userOptions = values.options ? JSON.parse(values.options) : {};
const kap = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "SWELLFACTOR.kap");
const parsed = await parseKAP(readFileSync(kap));
const byRole = (role) => parsed.surfaces.filter((s) => s.role === role);

const grid = calibrationGrid(byRole("voxelblk"), 40, 2);
const area = grid.cell * grid.cell;
const post = rasterTop(byRole("reference"), grid);
const pre = rasterTop(byRole("shelltopo"), grid);
const shell = rasterTop(byRole("shell"), grid);
const cells = [];
for (let q = 0; q < post.length; q++) if (post[q] > -1e8 && shell[q] > -1e8) cells.push(q);

// Solid rock in the surveyed volume, from the closed mesh: the same number for every run.
const insituM3 = columnThickness(byRole("voxelblk"), grid).thick.reduce((sum, t) => sum + t, 0) * area;

/** Centre of the pile's mass, from column thickness above the remaining shell. */
function pileOf(surface) {
    let volume = 0, sx = 0, sy = 0;
    const footprint = new Uint8Array(surface.length);
    for (const q of cells) {
        const depth = surface[q] - shell[q];
        if (depth <= 0) continue;
        const x = grid.gx0 + ((q % grid.nx) + 0.5) * grid.cell, y = grid.gy0 + (Math.floor(q / grid.nx) + 0.5) * grid.cell;
        volume += depth * area; sx += depth * area * x; sy += depth * area * y;
        if (depth > PILE_DEPTH_M) footprint[q] = 1;
    }
    return { volume, cx: sx / (volume || 1), cy: sy / (volume || 1), footprint };
}

const surveyPile = pileOf(post);

function score(surface) {
    let sum = 0, sq = 0, both = 0, either = 0;
    const pile = pileOf(surface);
    for (const q of cells) {
        const d = surface[q] - post[q];
        sum += d; sq += d * d;
        if (pile.footprint[q] && surveyPile.footprint[q]) both++;
        if (pile.footprint[q] || surveyPile.footprint[q]) either++;
    }
    return {
        cells: cells.length,
        rmseM: Math.sqrt(sq / cells.length),
        biasM: sum / cells.length,
        pileVolumeM3: pile.volume,
        pileVolumeVsSurvey: pile.volume / surveyPile.volume,
        swellOfPile: pile.volume / insituM3,
        footprintIoU: either ? both / either : 0,
    };
}

/** Highest block top per column: the same centre-binned raster as muckpileHeightfield. */
function surfaceFromCentres(S, origin) {
    const surface = shell.slice();
    for (let k = 0; k < S.N; k++) {
        if (S.state[k] === ST_INACTIVE) continue;
        const i = Math.floor((S.px[k] + origin.x - grid.gx0) / grid.cell), j = Math.floor((S.py[k] + origin.y - grid.gy0) / grid.cell);
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const top = S.pz[k] + origin.z + S.rad[k], q = j * grid.nx + i;
        if (top > surface[q]) surface[q] = top;
    }
    return surface;
}

/** Highest point of any sphere over each column centre: no holes when blocks outsize a cell. */
function surfaceFromSpheres(S, origin) {
    const surface = shell.slice();
    for (let k = 0; k < S.N; k++) {
        if (S.state[k] === ST_INACTIVE) continue;
        const z = S.pz[k] + origin.z;
        sphereColumns(S.px[k] + origin.x, S.py[k] + origin.y, S.rad[k], grid, (q, h) => {
            if (z + h > surface[q]) surface[q] = z + h;
        });
    }
    return surface;
}

const options = { seed: 1, maxVoxels: 15000, ...userOptions };
const started = Date.now();
const sim = new BlastMovementSimulator(options).load(parsed);
const blocks = sim.generateVoxels();
const run = await sim.runAsync();
const seconds = (Date.now() - started) / 1000;
const res = sim.results();
const survey = sim.surveyTargets();

const nothingMoved = pre.slice();
for (const q of cells) if (nothingMoved[q] < -1e8) nothingMoved[q] = shell[q];

const out = {
    options: userOptions,
    grid: { ...grid, cells: cells.length, pileDepthM: PILE_DEPTH_M },
    run: {
        blocks, voxelM: sim.actualRes, seconds, simTimeS: run.time, settled: run.settled,
        restFraction: res.stats.resting / blocks,
        insituBlocksM3: blocks * sim.actualRes ** 3,
        throwM: res.comShift.D, bearingDeg: res.comShift.bearing,
        swellTarget: sim.dem.maxSwell, swellReported: res.swell, swellMeasured: res.swellBulk,
    },
    // Centre-binned tops: comparable with the 6.3 m recorded before this work (6,000 blocks).
    score: score(surfaceFromCentres(sim.S, sim.origin)),
    // The same run with each sphere drawn at its true size; matters when blocks are larger than a cell.
    scoreSpheres: score(surfaceFromSpheres(sim.S, sim.origin)),
    nothingMoved: score(nothingMoved),
    survey: {
        insituM3, pileVolumeM3: surveyPile.volume, swellOfPile: surveyPile.volume / insituM3,
        throwM: survey.D, bearingDeg: survey.bearing,
    },
};

console.log(JSON.stringify(out, null, 1));
if (values.out) writeFileSync(values.out, JSON.stringify(out, null, 1));

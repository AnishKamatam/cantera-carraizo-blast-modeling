#!/usr/bin/env node
// Compare the existing throw model with the surveyed post-blast muckpile in
// examples/SWELLFACTOR.kap: a real shot, from a different site than Carraizo.
// The defaults were tuned on this shot, so only muckpile shape is partly independent.
// Usage: node scripts/verify-swellfactor.mjs [--out FILE] [--fit-shape FILE]

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseKAP } from "../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../src/movement/BlastMovementSimulator.js";
import { rasterTop } from "../src/movement/SurfaceMesh.js";

const { values } = parseArgs({ options: { out: { type: "string" }, "fit-shape": { type: "string" } } });
const parsed = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
const byRole = (role) => parsed.surfaces.filter((s) => s.role === role);

function shapeError(grid, z, reference, minZ) {
    const zSurvey = rasterTop(reference, grid);
    let n = 0, sum = 0, sq = 0;
    for (let q = 0; q < z.length; q++) {
        if (z[q] < minZ || zSurvey[q] < minZ) continue;
        const d = z[q] - zSurvey[q];
        n++; sum += d; sq += d * d;
    }
    return { cells: n, bias: sum / n, rmse: Math.sqrt(sq / n) };
}

async function run(label, opts) {
    const started = Date.now();
    const sim = new BlastMovementSimulator({ maxVoxels: 15000, ...opts }).load(parsed);
    const blocks = sim.generateVoxels();
    const volumeM3 = blocks * sim.actualRes ** 3;
    const r = await sim.runAsync();
    const res = sim.results();
    const shape = shapeError(res.heightfield.grid, res.heightfield.z, byRole("reference"), -1e8);
    // The do-nothing baseline: pretend the ground did not change, on the same cells.
    const zPre = rasterTop(byRole("shelltopo"), res.heightfield.grid);
    const masked = zPre.map((v, q) => (res.heightfield.z[q] > -1e8 ? v : -1e9));
    const baseline = shapeError(res.heightfield.grid, masked, byRole("reference"), -1e8);
    const out = {
        label, blocks, voxelM: sim.actualRes, volumeM3,
        settled: r.settled, restFraction: res.stats.resting / blocks,
        throwM: res.comShift.D, bearingDeg: res.comShift.bearing, swell: res.swell,
        shape, baseline, seconds: (Date.now() - started) / 1000,
    };
    console.log(JSON.stringify(out));
    return out;
}

// Yang & Kavetsky (1990) Eq 20 fits muckpile heights, not throw distance. Every setting
// is scored on the same survey cells, with no-block cells taking the remaining shell.
async function fitShape(path) {
    const { grid } = new BlastMovementSimulator({ seed: 1, maxVoxels: 1000 }).load(parsed).surveyTargets();
    const post = rasterTop(byRole("reference"), grid);
    const pre = rasterTop(byRole("shelltopo"), grid);
    const shell = rasterTop(byRole("shell"), grid);
    const score = (surface) => {
        let n = 0, sum = 0, sq = 0;
        for (let q = 0; q < post.length; q++) {
            if (post[q] < -1e8 || surface[q] < -1e8) continue;
            const d = surface[q] - post[q];
            n++; sum += d; sq += d * d;
        }
        return { cells: n, bias: sum / n, rmse: Math.sqrt(sq / n) };
    };
    const results = { baselineNothingMoved: score(pre), runs: [] };
    for (const Pe of [0.5, 1, 1.5, 2, 3]) {
        for (const bExp of [1.2, 1.5, 1.7, 2.0]) {
            const sim = new BlastMovementSimulator({ seed: 1, maxVoxels: 6000, Pe, bExp }).load(parsed);
            sim.generateVoxels();
            await sim.runAsync();
            const res = sim.results();
            const h = res.heightfield;
            const surface = shell.slice();
            for (let j = 0; j < grid.ny; j++) {
                for (let i = 0; i < grid.nx; i++) {
                    const x = grid.gx0 + (i + 0.5) * grid.cell, y = grid.gy0 + (j + 0.5) * grid.cell;
                    const a = Math.floor((x - h.grid.gx0) / h.grid.cell), b = Math.floor((y - h.grid.gy0) / h.grid.cell);
                    if (a < 0 || b < 0 || a >= h.grid.nx || b >= h.grid.ny) continue;
                    const top = h.z[b * h.grid.nx + a];
                    if (top > surface[j * grid.nx + i]) surface[j * grid.nx + i] = top;
                }
            }
            const run = { Pe, bExp, throwM: res.comShift.D, bearingDeg: res.comShift.bearing, ...score(surface) };
            results.runs.push(run);
            console.log(JSON.stringify(run));
        }
    }
    results.best = results.runs.slice().sort((a, b) => a.rmse - b.rmse)[0];
    writeFileSync(path, JSON.stringify(results, null, 1));
    console.log(JSON.stringify({ baseline: results.baselineNothingMoved, best: results.best }));
}

if (values["fit-shape"]) {
    await fitShape(values["fit-shape"]);
    process.exit(0);
}

const fitter = new BlastMovementSimulator({ seed: 1, maxVoxels: 15000 }).load(parsed);
const survey = fitter.surveyTargets();
console.log(JSON.stringify({ survey: { throwM: survey.D, bearingDeg: survey.bearing, swell: survey.swell, insituM3: survey.insituVol } }));

const runs = [];
for (const seed of [1, 2, 3]) runs.push(await run(`defaults, seed ${seed}`, { seed }));
for (const maxVoxels of [5000, 30000]) runs.push(await run(`defaults, ${maxVoxels} blocks`, { seed: 1, maxVoxels }));

// Fitted: Pe tuned to the surveyed throw, so its throw says nothing about accuracy.
const fit = await fitter.calibrate({ coarseMaxVoxels: 6000 });
console.log(JSON.stringify({ fittedPe: fit.fitted.Pe, fittedThrowM: fit.fitted.throwD }));
const fitted = await run(`fitted Pe ${fit.fitted.Pe.toFixed(2)}, swell ${survey.swell.toFixed(2)}`, { seed: 1, Pe: fit.fitted.Pe, maxSwell: survey.swell });
runs.push(fitted);

if (values.out) writeFileSync(values.out, JSON.stringify({ survey, runs }, null, 1));

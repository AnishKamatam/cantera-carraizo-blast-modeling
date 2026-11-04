#!/usr/bin/env node
// Compare the existing throw model with the surveyed post-blast muckpile in
// examples/SWELLFACTOR.kap: a real shot, from a different site than Carraizo.
// The defaults were tuned on this shot, so only muckpile shape is partly independent.
// Usage: node scripts/verify-swellfactor.mjs [--out FILE]

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseKAP } from "../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../src/movement/BlastMovementSimulator.js";
import { rasterTop } from "../src/movement/SurfaceMesh.js";

const { values } = parseArgs({ options: { out: { type: "string" } } });
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

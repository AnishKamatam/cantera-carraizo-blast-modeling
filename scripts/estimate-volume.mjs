#!/usr/bin/env node
// Estimate the rock a blast breaks, worked out from its charges, across the threshold's range.
// Usage: node scripts/estimate-volume.mjs --scenario DIR --terrain DIR [--cell M] [--depth-step M]
//        node scripts/estimate-volume.mjs --kap FILE [--cell M] [--json FILE]
// With --kap, the surveyed volume and shell in the file are compared with the prediction.
// Nothing is fitted to them: the threshold's range was set from published work beforehand.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseKAP } from "../src/io/KAPReader.js";
import { surveyTargets } from "../src/movement/Displacement.js";
import { rasterTop } from "../src/movement/SurfaceMesh.js";
import { readScenario } from "../sim/scenario/io.js";
import { loadTerrain } from "../sim/scenario/terrain.js";
import { BREAK_THRESHOLD, FIRST_CRACK_MM_S, breakRadiusM, breakZoneFromCharges, convexHull, distanceToHull, modifiedAshRadiusM, terrainFromSurface } from "../sim/scenario/breakzone.js";

const { values: v } = parseArgs({
    options: {
        scenario: { type: "string" }, terrain: { type: "string" }, kap: { type: "string" },
        cell: { type: "string" }, "depth-step": { type: "string" }, json: { type: "string" },
    },
});
if (!v.kap && !(v.scenario && v.terrain)) {
    console.error("Give --kap FILE, or --scenario DIR and --terrain DIR");
    process.exit(2);
}

const DEFAULT_DENSITY = { value: 2650, range: [2400, 2800], source: "typical quarry value; not measured at this site" };

let holes, decks, terrain, density = DEFAULT_DENSITY, survey = null, design = {};
if (v.kap) {
    const parsed = await parseKAP(readFileSync(v.kap));
    ({ holes, decks } = parsed);
    const byRole = (role) => parsed.surfaces.filter((s) => s.role === role);
    terrain = terrainFromSurface(byRole("shelltopo")[0], Number(v.cell || 1));
    survey = { targets: surveyTargets(parsed.surfaces), shell: byRole("shell"), volumes: byRole("voxelblk"), grade: holes[0].gradeZ };
} else {
    const s = readScenario(v.scenario);
    ({ holes, decks } = s);
    terrain = loadTerrain(v.terrain);
    density = s.assumptions.rockDensityKgM3 || DEFAULT_DENSITY;
    if (s.assumptions.holmbergK) design = { K_hp: s.assumptions.holmbergK.value, alpha_hp: s.assumptions.holmbergAlpha.value, beta_hp: s.assumptions.holmbergBeta.value };
}
const base = {
    ...design,
    ...(v.cell ? { stride: Math.max(1, Math.round(Number(v.cell) / terrain.dtm.cell)) } : {}),
    ...(v["depth-step"] ? { depthStepM: Number(v["depth-step"]) } : {}),
};

function surveyGrid(z) {
    const { x0, y0, cell, cols, rows } = z.grid;
    const G = { gx0: x0, gy0: y0, cell, nx: cols, ny: rows };
    const shell = rasterTop(survey.shell, G);
    const inVolume = rasterTop(survey.volumes, G);
    const zone = new Uint8Array(cols * rows);
    for (let q = 0; q < zone.length; q++) {
        if (inVolume[q] > -1e8 && shell[q] > -1e8 && z.ground[q] - shell[q] >= 0.5) zone[q] = 1;
    }
    return { shell, zone };
}

/** Wall points: the outer edge of each broken cell beside rock standing `wallMinM` above its floor. */
function wallPoints(z, mask, floorAt) {
    const { x0, y0, cell, cols, rows } = z.grid;
    const out = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const q = j * cols + i;
            if (!mask[q]) continue;
            for (const [a, b, ox, oy] of [[i + 1, j, 0.5, 0], [i - 1, j, -0.5, 0], [i, j + 1, 0, 0.5], [i, j - 1, 0, -0.5]]) {
                if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
                const m = b * cols + a;
                if (mask[m] || !(z.ground[m] - floorAt(q) >= 2)) continue;
                out.push([x0 + (i + 0.5 + ox) * cell, y0 + (j + 0.5 + oy) * cell]);
            }
        }
    }
    return out;
}

function compareWithSurvey(z) {
    const { cols, rows, cell, x0, y0 } = z.grid, area = cell * cell;
    const { shell, zone } = surveyGrid(z);
    let both = 0, predictedOnly = 0, surveyOnly = 0, aboveGrade = 0, belowGrade = 0, floorSum = 0, floorSq = 0, floorN = 0;
    for (let q = 0; q < zone.length; q++) {
        const a = z.mask[q] === 1, b = zone[q] === 1;
        if (a && b) both++; else if (a) predictedOnly++; else if (b) surveyOnly++;
        if (a) {
            aboveGrade += Math.max(0, z.ground[q] - Math.max(z.floorZ[q], survey.grade)) * area;
            belowGrade += Math.max(0, Math.min(z.ground[q], survey.grade) - z.floorZ[q]) * area;
        }
        if (a && b) {
            const d = z.floorZ[q] - shell[q];
            floorSum += d; floorSq += d * d; floorN++;
        }
    }
    const surveyWall = wallPoints(z, zone, (q) => shell[q]);
    const predictedWall = wallPoints(z, z.mask, (q) => z.floorZ[q]);
    const signed = surveyWall.map(([x, y]) => {
        let nearest = Infinity;
        for (const [a, b] of predictedWall) nearest = Math.min(nearest, Math.hypot(x - a, y - b));
        const i = Math.floor((x + 0.25 * cell - x0) / cell), j = Math.floor((y + 0.25 * cell - y0) / cell);
        const inside = i >= 0 && j >= 0 && i < cols && j < rows && z.mask[j * cols + i] === 1;
        return inside ? nearest : -nearest; // + means the prediction reaches past the survey.
    }).sort((a, b) => a - b);
    const pick = (f) => (signed.length ? signed[Math.min(signed.length - 1, Math.floor(f * signed.length))] : NaN);
    const surveyVolume = survey.targets.insituVol;
    const hull = convexHull(holes.map((h) => [h.collarX, h.collarY]));
    const past = surveyWall.map(([x, y]) => distanceToHull(x, y, hull)).filter((d) => d > 0).sort((a, b) => a - b);
    const surveyBackBreak = {
        n: past.length, meanM: past.reduce((a, b) => a + b, 0) / past.length,
        p10M: past[Math.floor(0.1 * past.length)], medianM: past[Math.floor(0.5 * past.length)], p90M: past[Math.floor(0.9 * past.length)],
    };
    return {
        surveyVolumeM3: surveyVolume,
        volumeErrorPct: (100 * (z.volumeM3 - surveyVolume)) / surveyVolume,
        aboveGradeM3: aboveGrade,
        aboveGradeErrorPct: (100 * (aboveGrade - surveyVolume)) / surveyVolume,
        belowGradeM3: belowGrade,
        footprint: { surveyM2: (both + surveyOnly) * area, predictedM2: (both + predictedOnly) * area, iou: both / (both + predictedOnly + surveyOnly) },
        floorMinusSurvey: { bias: floorSum / floorN, rmse: Math.sqrt(floorSq / floorN) },
        surveyBackBreak,
        wall: {
            surveyPoints: signed.length,
            meanSignedM: signed.reduce((a, b) => a + b, 0) / signed.length,
            medianSignedM: pick(0.5), p10M: pick(0.1), p90M: pick(0.9),
            meanAbsM: signed.reduce((a, b) => a + Math.abs(b), 0) / signed.length,
        },
    };
}

const fmt = (x) => Math.round(x).toLocaleString("en-US");
const tonnes = (m3, kgM3) => (m3 * kgM3) / 1000;
const runs = [];
const cases = [
    ["low threshold", { thresholdMmS: BREAK_THRESHOLD.range[0] }],
    ["central", { thresholdMmS: BREAK_THRESHOLD.value }],
    ["high threshold", { thresholdMmS: BREAK_THRESHOLD.range[1] }],
];
if (survey) {
    cases.push(["break-up, Bauer and Calder", { thresholdMmS: 2540 }]);
    cases.push(["central, no breakout below open floor", { thresholdMmS: BREAK_THRESHOLD.value, breakoutDeg: 0 }]);
    cases.push(["central, contour must touch the face", { thresholdMmS: BREAK_THRESHOLD.value, burdenRatio: 1 }]);
    cases.push(["central, 1979 form", { thresholdMmS: BREAK_THRESHOLD.value, useNioshModified: false }]);
}

console.log(`Threshold ${BREAK_THRESHOLD.value} mm/s, range ${BREAK_THRESHOLD.range.join("-")}: ${BREAK_THRESHOLD.source}`);
console.log(`Rock density ${density.value} kg/m3, range ${density.range.join("-")}: ${density.source}`);
for (const [label, params] of cases) {
    const started = Date.now();
    const z = breakZoneFromCharges(terrain, holes, decks, { ...base, ...params });
    const run = {
        label, ...params, volumeM3: z.volumeM3, footprintM2: z.footprintM2, backBreak: z.backBreak,
        wallToNearestHole: z.wallToNearestHole, chokedHoles: z.chokedHoles.length, cleaning: z.cleaning,
        nodataColumnsInReach: z.nodataColumnsInReach, seconds: (Date.now() - started) / 1000,
    };
    if (survey) run.survey = compareWithSurvey(z);
    runs.push(run);
    const b = z.backBreak;
    console.log(`\n${label}, ${params.thresholdMmS} mm/s`);
    console.log(`  in-situ volume   ${fmt(z.volumeM3)} m3, footprint ${fmt(z.footprintM2)} m2`);
    console.log(`  tonnage          ${fmt(tonnes(z.volumeM3, density.value))} t (${fmt(tonnes(z.volumeM3, density.range[0]))}-${fmt(tonnes(z.volumeM3, density.range[1]))} t over the density range)`);
    console.log(`  back-break       mean ${b.meanM.toFixed(1)} m, p10-p90 ${b.p10M.toFixed(1)}-${b.p90M.toFixed(1)} m past the hole pattern`);
    console.log(`  choked holes     ${z.chokedHoles.length} of ${new Set(decks.map((d) => d.holeIndex)).size}`);
    console.log(`  cleaned          fragments ${fmt(z.cleaning.fragmentsRemovedM3)} m3, pillars ${fmt(z.cleaning.pillarsRemovedM3)} m3 (${z.cleaning.standingIslands.length} large islands left), ribs ${fmt(z.cleaning.ribsRemovedM3)} m3; overhang collapsed ${fmt(z.cleaning.overhangCollapsedM3)} m3`);
    if (run.survey) {
        const s = run.survey;
        console.log(`  survey volume    ${fmt(s.surveyVolumeM3)} m3: error ${s.volumeErrorPct.toFixed(1)}%; above grade ${fmt(s.aboveGradeM3)} m3, error ${s.aboveGradeErrorPct.toFixed(1)}%`);
        console.log(`  survey footprint ${fmt(s.footprint.surveyM2)} m2, overlap IoU ${s.footprint.iou.toFixed(2)}; floor minus survey bias ${s.floorMinusSurvey.bias.toFixed(2)} m, rmse ${s.floorMinusSurvey.rmse.toFixed(2)} m`);
        console.log(`  survey back-break mean ${s.surveyBackBreak.meanM.toFixed(1)} m, median ${s.surveyBackBreak.medianM.toFixed(1)} m, p10-p90 ${s.surveyBackBreak.p10M.toFixed(1)}-${s.surveyBackBreak.p90M.toFixed(1)} m past the hole pattern`);
        console.log(`  back wall        predicted past survey: mean ${s.wall.meanSignedM.toFixed(1)} m, median ${s.wall.medianSignedM.toFixed(1)} m, p10-p90 ${s.wall.p10M.toFixed(1)} to ${s.wall.p90M.toFixed(1)} m, mean absolute ${s.wall.meanAbsM.toFixed(1)} m`);
    }
}

const biggest = holes.reduce((best, h, index) => {
    const list = decks.filter((d) => d.holeIndex === index && d.mass > 0);
    const mass = list.reduce((a, d) => a + d.mass, 0);
    return mass > best.mass ? { mass, list, h } : best;
}, { mass: 0 });
const d = biggest.list[0];
const ash = modifiedAshRadiusM({ densityKgL: d.density, vodMs: d.vod, holeDiamMm: d.holeDiamMm, rockDensityKgM3: density.value });
const comparators = {
    largestHoleKg: biggest.mass,
    modifiedAshPressureRadiusM: ash,
    radiusAtCentralM: breakRadiusM(biggest.list, BREAK_THRESHOLD.value, base),
    radiusAtFirstCrackM: breakRadiusM(biggest.list, FIRST_CRACK_MM_S, base),
};
console.log(`\nLargest hole, ${fmt(biggest.mass)} kg: radius ${comparators.radiusAtCentralM.toFixed(1)} m at the central threshold; Modified Ash ${ash.toFixed(1)} m; first cracks reach ${comparators.radiusAtFirstCrackM.toFixed(1)} m at ${FIRST_CRACK_MM_S} mm/s (cracked, not broken).`);
if (v.json) writeFileSync(v.json, JSON.stringify({ runs, comparators }, null, 1));

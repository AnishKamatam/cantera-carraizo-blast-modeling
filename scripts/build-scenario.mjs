#!/usr/bin/env node
// Cut a blast block from terrain grids and write a scenario with an assumed design.
// Usage: node scripts/build-scenario.mjs --terrain DIR --name NAME --polygon="x,y x,y x,y ..."
//        --floor=Z [--hole-polygon="x,y ..."] [--free-face N|S|E|W] [--twin VERSION] [--set name=value ...] [--out DIR]
//        node scripts/build-scenario.mjs --terrain DIR --name NAME --from DIR --break-zone [--threshold MM_S] [--cell M]
// --break-zone works the cut out from the charges. With --from, it reuses that scenario's
// holes; otherwise it drills --polygon first. Without it, the polygon is cut as drawn.
// Keep the = in --polygon= and --floor=, so that negative coordinates parse.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadTerrain } from "../sim/scenario/terrain.js";
import { scenarioFromTerrain } from "../sim/scenario/pattern.js";
import { readScenario, writeScenario } from "../sim/scenario/io.js";
import { withBreakZone } from "../sim/scenario/breakzone.js";

const { values: v } = parseArgs({
    options: {
        terrain: { type: "string" }, name: { type: "string" }, polygon: { type: "string" },
        floor: { type: "string" }, "hole-polygon": { type: "string" }, "free-face": { type: "string" },
        twin: { type: "string", default: "unversioned" }, set: { type: "string", multiple: true, default: [] },
        out: { type: "string" }, from: { type: "string" }, "break-zone": { type: "boolean", default: false },
        threshold: { type: "string" }, cell: { type: "string" },
    },
});
for (const required of v.from ? ["terrain", "name"] : ["terrain", "name", "polygon", "floor"]) {
    if (!v[required]) {
        console.error(`Missing --${required}`);
        process.exit(2);
    }
}

function breakZoneParams(terrain) {
    if (!v["break-zone"]) return null;
    const params = {};
    if (v.threshold) params.thresholdMmS = Number(v.threshold);
    if (v.cell) params.stride = Math.max(1, Math.round(Number(v.cell) / terrain.dtm.cell));
    return params;
}

function report(scenario, out, floorText) {
    const volume = scenario.surfaces.find((s) => s.role === "voxelblk");
    console.log(`${v.name}: ${scenario.holes.length} holes, floor ${floorText}, ${(scenario.twin.filledFraction * 100).toFixed(1)}% interpolated, ${volume.nt} volume triangles, wrote ${out}`);
    if (scenario.zone) {
        const { volumeM3, backBreak, chokedHoles, cleaning } = scenario.zone;
        console.log(`  zone ${Math.round(volumeM3)} m3, back-break mean ${backBreak.meanM.toFixed(1)} m, ${chokedHoles.length} choked holes, fragments ${Math.round(cleaning.fragmentsRemovedM3)} m3, pillars ${Math.round(cleaning.pillarsRemovedM3)} m3, ribs ${Math.round(cleaning.ribsRemovedM3)} m3 cleaned`);
    }
}

const out = v.out || join("sim", "data", "scenarios", v.name);
const terrain = loadTerrain(v.terrain);

if (v.from) {
    if (!v["break-zone"]) {
        console.error("--from needs --break-zone");
        process.exit(2);
    }
    const scenario = withBreakZone({ ...readScenario(v.from), name: v.name }, terrain, breakZoneParams(terrain));
    writeScenario(out, scenario);
    report(scenario, out, `from the charges, lowest ${scenario.zone.floorMinZ.toFixed(1)} m`);
    process.exit(0);
}

const parsePolygon = (text) => text.trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
const polygon = parsePolygon(v.polygon);
const holePolygon = v["hole-polygon"] ? parsePolygon(v["hole-polygon"]) : null;
const floorZ = Number(v.floor);
if (!polygon.flat().every(Number.isFinite) || !Number.isFinite(floorZ)) {
    console.error("--polygon and --floor must be numbers");
    process.exit(2);
}
const overrides = Object.fromEntries(v.set.map((item) => {
    const [key, value] = item.split("=");
    return [key, Number(value)];
}));

const scenario = scenarioFromTerrain(terrain, polygon, {
    name: v.name, floorZ, overrides, twinVersion: v.twin, freeFace: v["free-face"], holePolygon,
    breakZone: breakZoneParams(terrain),
});
writeScenario(out, scenario);
report(scenario, out, `${floorZ} m`);

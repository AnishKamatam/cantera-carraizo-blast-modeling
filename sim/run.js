/**
 * Run the repo's existing blast models on a scenario. Results are always marked
 * uncalibrated, and receptors are abstract rings, never real locations.
 */

import { BlastMovementSimulator } from "../src/movement/BlastMovementSimulator.js";
import { surfaceBounds } from "../src/movement/SurfaceMesh.js";
import { evaluateReceptor, decksFromEntries } from "../src/vibration/ReceptorPPV.js";
import { computeHolmbergPerssonDamage } from "../src/damage/HolmbergPerssonDamage.js";
import { chargeColumnsFromDecks, computeHoleSDoB, sdobRiskBand } from "../src/flyrock/SDoB.js";
import { toSimData } from "./scenario/io.js";

const DAMAGE_SAMPLES = 40;

export function abstractReceptors(centre, distancesM = [100, 250, 500, 1000], bearings = 8) {
    const receptors = [];
    for (const distanceM of distancesM) {
        for (let b = 0; b < bearings; b++) {
            const bearingDeg = (b * 360) / bearings;
            const a = (bearingDeg * Math.PI) / 180;
            receptors.push({
                x: centre.x + distanceM * Math.sin(a),
                y: centre.y + distanceM * Math.cos(a),
                z: centre.z,
                distanceM,
                bearingDeg,
            });
        }
    }
    return receptors;
}

function holeCentre(holes) {
    const sum = holes.reduce((c, h) => ({ x: c.x + h.collarX, y: c.y + h.collarY, z: c.z + h.collarZ }), { x: 0, y: 0, z: 0 });
    return { x: sum.x / holes.length, y: sum.y / holes.length, z: sum.z / holes.length };
}

function sitelawParams(assumptions) {
    const params = {}, used = {};
    if (assumptions.siteLawK) { params.K = assumptions.siteLawK.value; used.siteLawK = assumptions.siteLawK; }
    if (assumptions.siteLawB) { params.B = assumptions.siteLawB.value; used.siteLawB = assumptions.siteLawB; }
    return { params, used };
}

function lateralBounds(scenario) {
    const volumes = scenario.surfaces.filter((s) => s.role === "voxelblk");
    if (volumes.length) return surfaceBounds(volumes);
    const xs = scenario.holes.map((h) => h.collarX), ys = scenario.holes.map((h) => h.collarY);
    const zs = scenario.holes.flatMap((h) => [h.collarZ, h.toeZ]);
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
        minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
}

/** Peak damage PPV on a rectangle 1 m outside the block at mid-bench height. */
function damageAroundBlock(scenario) {
    const b = lateralBounds(scenario);
    const x0 = b.minX - 1, x1 = b.maxX + 1, y0 = b.minY - 1, y1 = b.maxY + 1, z = (b.minZ + b.maxZ) / 2;
    const w = x1 - x0, h = y1 - y0, perimeter = 2 * (w + h);
    let peakPpvMmS = 0, atPoint = { x: x0, y: y0, z };
    for (let n = 0; n < DAMAGE_SAMPLES; n++) {
        let d = (n / DAMAGE_SAMPLES) * perimeter;
        let point;
        if (d < w) point = { x: x0 + d, y: y0, z };
        else if ((d -= w) < h) point = { x: x1, y: y0 + d, z };
        else if ((d -= h) < w) point = { x: x1 - d, y: y1, z };
        else point = { x: x0, y: y1 - (d - w), z };
        const ppv = computeHolmbergPerssonDamage(point, scenario.decks, {});
        if (ppv > peakPpvMmS) { peakPpvMmS = ppv; atPoint = point; }
    }
    return { peakPpvMmS, atPoint };
}

/** McKenzie scaled depth of burial, worst hole first. */
function flyrockByHole(scenario) {
    let minSdob = Infinity;
    for (const c of chargeColumnsFromDecks(scenario.decks, scenario.holes)) {
        const { sDoB } = computeHoleSDoB({
            holeDiamMm: c.holeDiamMm,
            stemmingLength: c.stemmingLength,
            chargeLength: c.chargeLen,
            totalMassKg: c.totalMassKg,
        });
        if (sDoB < minSdob) minSdob = sDoB;
    }
    return { minSdob, band: Number.isFinite(minSdob) ? sdobRiskBand(minSdob).key : "none" };
}

/** Lets rock reach lower benches on twin-built scenarios. Others keep the library default. */
function groundLevel(scenario) {
    if (!scenario.twin) return null;
    let lowest = Infinity;
    for (const s of scenario.surfaces) {
        if (s.role !== "shell" && s.role !== "shelltopo") continue;
        for (let i = 2; i < s.pos.length; i += 3) if (s.pos[i] < lowest) lowest = s.pos[i];
    }
    return lowest === Infinity ? null : lowest - 5;
}

export async function runFastModels(scenario, { seed, maxVoxels = 30000, overrides = {} } = {}) {
    const { params, used } = sitelawParams(scenario.assumptions);
    const receptors = abstractReceptors(holeCentre(scenario.holes));
    const receptorDecks = decksFromEntries(scenario.decks);
    const vibration = receptors.map((r) => {
        const v = evaluateReceptor({ x: r.x, y: r.y, z: r.z }, receptorDecks, { ...params, distanceMode: "3D", superposeRMS: true });
        // Scaled distance is floored at 1, so PPV tops out at K: too close for a site law.
        const atSiteLawCap = v.ppvMax >= (params.K ?? 1140) * (1 - 1e-9);
        return { ...r, ppvMmS: v.ppvMax, ppvRmsMmS: v.ppvRMS, rmsDeckCount: v.rmsDeckCount, dominantHoleID: v.dominantHoleID, atSiteLawCap };
    });

    const groundZ = groundLevel(scenario);
    const sim = new BlastMovementSimulator({ seed, maxVoxels, groundZ, ...overrides }).load(toSimData(scenario));
    const blocks = sim.generateVoxels();
    if (!blocks) throw new Error(`runFastModels: scenario ${scenario.name} produced no blocks`);
    let blockBaseZ = Infinity;
    for (let i = 0; i < sim.S.N; i++) blockBaseZ = Math.min(blockBaseZ, sim.S.oz[i] + sim.origin.z);
    await sim.runAsync();
    const result = sim.results();
    let lowestBlockZ = Infinity;
    for (let i = 0; i < sim.S.N; i++) lowestBlockZ = Math.min(lowestBlockZ, sim.S.pz[i] + sim.origin.z);

    return {
        calibration: "uncalibrated",
        scenario: scenario.name,
        twin: scenario.twin,
        measured: scenario.measured,
        assumptionsUsed: used,
        allAssumptions: scenario.assumptions,
        vibration,
        damage: damageAroundBlock(scenario),
        flyrock: flyrockByHole(scenario),
        throw: {
            comShift: result.comShift,
            swell: result.swell,
            swellIsPrescribed: true,
            settled: result.settled,
            restFraction: result.stats.resting / result.blockCount,
            blockCount: result.blockCount,
            time: result.time,
            groundZ,
            blockBaseZ,
            lowestBlockZ,
        },
    };
}

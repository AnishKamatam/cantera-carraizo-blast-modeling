/**
 * Run the repo's existing blast models on a scenario. Results are always marked
 * uncalibrated, and receptors are abstract rings, never real locations.
 */

import { BlastMovementSimulator } from "../src/movement/BlastMovementSimulator.js";
import { rasterTop, surfaceBounds } from "../src/movement/SurfaceMesh.js";
import { evaluateReceptor, decksFromEntries } from "../src/vibration/ReceptorPPV.js";
import { computeHolmbergPerssonDamage } from "../src/damage/HolmbergPerssonDamage.js";
import { chargeColumnsFromDecks, computeHoleSDoB, sdobRiskBand } from "../src/flyrock/SDoB.js";
import { centreOfMassShift } from "../src/movement/Displacement.js";
import { insidePolygon } from "./scenario/block.js";
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

/** Maps each labelled assumption to the library parameter that consumes it. */
const CONSUMED = {
    siteLaw: { siteLawK: "K", siteLawB: "B" },
    damage: { holmbergK: "K_hp", holmbergAlpha: "alpha_hp", holmbergBeta: "beta_hp" },
    launch: { rockDensityKgM3: "rockDensity" },
};
/** Shape inputs: already built into the scenario's holes, decks and timing. */
const BUILT_INTO_DESIGN = ["holeDiamMm", "burdenM", "spacingM", "subdrillM", "stemmingM", "explosiveDensityKgL", "holeDelayMs", "rowDelayMs"];

function paramsFrom(assumptions, mapping, used, defaults) {
    const params = {};
    for (const [name, parameter] of Object.entries(mapping)) {
        if (assumptions[name]) {
            params[parameter] = assumptions[name].value;
            used[name] = assumptions[name];
        } else {
            defaults.push(name);
        }
    }
    return params;
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
function damageAroundBlock(scenario, params) {
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
        const ppv = computeHolmbergPerssonDamage(point, scenario.decks, params);
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

/**
 * Upper estimate of rock outside the block but below the original ground. Real rock
 * can't be there: the collision floor reaches one sampling step past the block. It
 * also counts rock on the sampled slope at a crest, so it reads somewhat high.
 */
function belowOriginalGround(sim, scenario) {
    const preblast = scenario.surfaces.filter((s) => s.id === "preblast-terrain");
    if (!scenario.block || preblast.length === 0) return null;
    const bounds = surfaceBounds(preblast);
    const cell = 1;
    const grid = {
        gx0: bounds.minX, gy0: bounds.minY, cell,
        nx: Math.ceil((bounds.maxX - bounds.minX) / cell) + 1,
        ny: Math.ceil((bounds.maxY - bounds.minY) / cell) + 1,
    };
    const ground = rasterTop(preblast, grid);
    let inGround = 0;
    for (let k = 0; k < sim.S.N; k++) {
        const x = sim.S.px[k] + sim.origin.x, y = sim.S.py[k] + sim.origin.y, z = sim.S.pz[k] + sim.origin.z;
        if (insidePolygon(x, y, scenario.block.polygon)) continue;
        const i = Math.floor((x - grid.gx0) / cell), j = Math.floor((y - grid.gy0) / cell);
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const top = ground[j * grid.nx + i];
        if (top > -1e8 && z < top - 1) inGround++;
    }
    return inGround / sim.S.N;
}

export async function runFastModels(scenario, { seed, maxVoxels = 30000, overrides = {} } = {}) {
    const used = {}, libraryDefaultsUsed = [];
    const siteLaw = paramsFrom(scenario.assumptions, CONSUMED.siteLaw, used, libraryDefaultsUsed);
    const damage = paramsFrom(scenario.assumptions, CONSUMED.damage, used, libraryDefaultsUsed);
    const launch = paramsFrom(scenario.assumptions, CONSUMED.launch, used, libraryDefaultsUsed);
    const notUsed = Object.keys(scenario.assumptions).filter((name) => !used[name] && !BUILT_INTO_DESIGN.includes(name));
    const receptors = abstractReceptors(holeCentre(scenario.holes));
    const receptorDecks = decksFromEntries(scenario.decks);
    const vibration = receptors.map((r) => {
        const v = evaluateReceptor({ x: r.x, y: r.y, z: r.z }, receptorDecks, { ...siteLaw, distanceMode: "3D", superposeRMS: true });
        // Scaled distance is floored at 1, so PPV tops out at K: too close for a site law.
        const atSiteLawCap = v.ppvPerDelay >= (siteLaw.K ?? 1140) * (1 - 1e-9);
        return { ...r, ppvMmS: v.ppvPerDelay, ppvMaxSingleDeckMmS: v.ppvMax, ppvRmsMmS: v.ppvRMS, rmsDeckCount: v.rmsDeckCount, dominantHoleID: v.dominantHoleID, atSiteLawCap };
    });

    const groundZ = groundLevel(scenario);
    const sim = new BlastMovementSimulator({ seed, maxVoxels, groundZ, ...launch, ...overrides }).load(toSimData(scenario));
    const blocks = sim.generateVoxels();
    if (!blocks) throw new Error(`runFastModels: scenario ${scenario.name} produced no blocks`);
    let blockBaseZ = Infinity;
    for (let i = 0; i < sim.S.N; i++) blockBaseZ = Math.min(blockBaseZ, sim.S.oz[i] + sim.origin.z);
    const timeLimitS = overrides.maxSimTimeS > 0 ? overrides.maxSimTimeS : sim.lastFireT + 12;
    let throwOneSecondEarlier = null;
    await sim.runAsync({
        onProgress(time) {
            if (throwOneSecondEarlier === null && time >= timeLimitS - 1) throwOneSecondEarlier = centreOfMassShift(sim.S).D;
        },
    });
    const result = sim.results();
    let lowestBlockZ = Infinity;
    for (let i = 0; i < sim.S.N; i++) lowestBlockZ = Math.min(lowestBlockZ, sim.S.pz[i] + sim.origin.z);

    return {
        calibration: "uncalibrated",
        scenario: scenario.name,
        twin: scenario.twin,
        measured: scenario.measured,
        assumptionsUsed: used,
        libraryDefaultsUsed,
        assumptionsNotUsedByTheseModels: notUsed,
        allAssumptions: scenario.assumptions,
        vibration,
        damage: damageAroundBlock(scenario, damage),
        flyrock: flyrockByHole(scenario),
        throw: {
            comShift: result.comShift,
            swell: result.swell,
            swellIsPrescribed: true,
            settled: result.settled,
            restFraction: result.stats.resting / result.blockCount,
            blockCount: result.blockCount,
            time: result.time,
            timeLimitS,
            belowOriginalGroundFraction: belowOriginalGround(sim, scenario),
            throwDriftLastSecondM: throwOneSecondEarlier === null ? null : Math.abs(result.comShift.D - throwOneSecondEarlier),
            groundZ,
            blockBaseZ,
            lowestBlockZ,
        },
    };
}

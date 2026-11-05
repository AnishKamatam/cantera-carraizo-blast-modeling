/**
 * BlastMovementSimulator.js — Voxel blast-throw / muckpile simulator (orchestrator)
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * Pipeline (Kirra blast-throw simulator, throw_4 sphere-DEM generation):
 *   1. load()             HoleEntry + DeckEntry + surfaces (e.g. from parseKAP)
 *   2. generateVoxels()   voxelise PREBLAST_VOLUME / VOXEL-BLK* meshes (or hole bbox),
 *                         assign nearest hole, block radii, shell collider (+ lid exclusion)
 *   3. assignVelocities() kinematic loading after Yang & Kavetsky 1990 (default) or energy-partition
 *   4. step(dt) / run()   fixed 5 ms sub-steps until every fired block rests
 *   5. results()          displacement vectors, CoM shift, swell, muckpile heightfield
 *   6. calibrate()        secant-fit Pe so the simulated CoM throw matches the survey
 *
 * Positions are kept LOCAL (world − origin) in Float32; `origin` defaults to
 * the hole centroid. All public getters return the raw typed arrays.
 *
 * Optional physics engine injection: pass { engine: rapierEngineInstance }
 * built with movement/RapierEngine.js — the sphere DEM remains the default
 * (it reproduces surveyed muckpile shapes best in calibration on SWELLFACTOR).
 */

import { voxeliseVolumesBudget, voxeliseHoleBBox } from "./Voxeliser.js";
import { flattenTriangles, calibrationGrid, columnThickness } from "./SurfaceMesh.js";
import { buildShellBin, lidExclusionKeys, shellHeightAt } from "./ShellCollider.js";
import { computeThrowDirections } from "./ThrowDirections.js";
import { simHolesFromEntries, prepareChargeElements, nearestHole, assignYangVelocities, assignEnergyPartitionVelocities, YANG_DEFAULTS, ENERGY_DEFAULTS } from "./InitialVelocity.js";
import { createParticleState, assignBlockRadii, SpatialHash, physicsStep, resetParticleState, bulkGrowthFactor, pickBoulderClusters, mergeBlocks, fitBoulders, SUB_DT, DEM_DEFAULTS, COULOMB_DEFAULTS, ST_INACTIVE, ST_ACTIVE, ST_REST } from "./SphereDEM.js";
import { kuzRam, blastInputs, boulderPlan, ROCK_FACTOR, RELATIVE_WEIGHT_STRENGTH, DRILL_ERROR_M, RWS_EXPONENT_2005 } from "./Fragmentation.js";
import { displacementVectors, centreOfMassShift, swellPrescribed, swellEmergent, swellBulk, muckpileHeightfield, surveyTargets } from "./Displacement.js";
import { mulberry32 } from "../signal/Detune.js";

export var SIM_DEFAULTS = {
    voxelRes: 1.5,          // m (throw_4 default)
    maxVoxels: 30000,
    velocityModel: "yang",  // 'yang' | 'energy' | 'yang1990'
    fireTimeSource: "deck", // 'deck' (primer-resolved) | 'hole' (surface time)
    seed: null,             // PRNG seed (null = Math.random)
    settleAfterLastFireS: 0.5,
    maxSimTimeS: null,      // default lastFire + 12 s
    groundZ: null           // world Z of the ground plane; null = base of the lowest block
};

/** A misspelt model name would otherwise run the old model without a word. */
function checkModelNames(o) {
    var velocity = ["yang", "energy", "yang1990"];
    if (o.velocityModel != null && velocity.indexOf(o.velocityModel) < 0) {
        throw new RangeError("velocityModel must be \"yang\", \"energy\" or \"yang1990\", got " + o.velocityModel);
    }
    if (o.contactModel != null && o.contactModel !== "coulomb") {
        throw new RangeError("contactModel must be \"coulomb\" or unset (the old contact), got " + o.contactModel);
    }
}

export class BlastMovementSimulator {
    /**
     * @param {Object} [opts] - SIM_DEFAULTS + DEM_DEFAULTS + YANG_DEFAULTS/ENERGY_DEFAULTS overrides
     */
    constructor(opts) {
        checkModelNames(opts || {});
        this.opts = Object.assign({}, SIM_DEFAULTS, opts || {});
        this.dem = Object.assign({}, DEM_DEFAULTS, opts || {});
        this.yang = Object.assign({}, YANG_DEFAULTS, opts || {});
        this.energy = Object.assign({}, ENERGY_DEFAULTS, opts || {});
        this.rng = this.opts.seed != null ? mulberry32(this.opts.seed) : Math.random;
        this.holeEntries = []; this.deckEntries = []; this.surfaces = [];
        this.holes = []; this.hb = null;
        this.origin = { x: 0, y: 0, z: 0 };
        this.S = null; this.H = null; this.SB = null;
        this.shellFlat = null; this.shellTrusted = false;
        this.time = 0; this.running = false;
        this.actualRes = this.opts.voxelRes;
        this.lastFireT = 0;
        this.engine = opts && opts.engine ? opts.engine : null;
        this.stats = { active: 0, resting: 0 };
    }

    /**
     * Load blast data. Accepts the object returned by parseKAP().
     * @param {{ holes: Array, decks: Array, surfaces?: Array }} data
     */
    load(data) {
        this.holeEntries = data.holes || [];
        this.deckEntries = data.decks || [];
        this.surfaces = data.surfaces || [];
        this.holes = simHolesFromEntries(this.holeEntries, this.deckEntries, { fireTimeSource: this.opts.fireTimeSource });
        this.time = 0; this.running = false;

        // Origin: hole centroid (surface centroid fallback)
        var sx = 0, sy = 0, sz = 0;
        if (this.holes.length) {
            for (var i = 0; i < this.holes.length; i++) { sx += this.holes[i].cx; sy += this.holes[i].cy; sz += this.holes[i].cz; }
            this.origin = { x: sx / this.holes.length, y: sy / this.holes.length, z: sz / this.holes.length };
        } else if (this.surfaces.length) {
            var s0 = this.surfaces[0];
            this.origin = { x: s0.pos[0], y: s0.pos[1], z: s0.pos[2] };
        }
        this.lastFireT = 0;
        for (var k = 0; k < this.holes.length; k++) if (this.holes[k].fireT > this.lastFireT) this.lastFireT = this.holes[k].fireT;

        // Confinement geometry
        var trusted = this.surfaces.filter(function (s) { return s.role === "shell"; });
        var topo = this.surfaces.filter(function (s) { return s.role === "shelltopo"; });
        this.shellTrusted = trusted.length > 0;
        this.shellFlat = flattenTriangles(this.shellTrusted ? trusted : topo, this.origin);
        this.SB = buildShellBin(this.shellFlat, null);

        computeThrowDirections(this.holes);
        var prep = prepareChargeElements(this.holes);
        this.hb = prep.bin;
        this.chargeElementCount = prep.total;
        return this;
    }

    /**
     * Voxelise and set up the particle state. Call after load().
     * @returns {number} block count
     */
    generateVoxels() {
        var o = this.opts;
        var res = o.voxelRes, vres = res;
        var positions = null;
        var vols = this.surfaces.filter(function (s) { return s.role === "voxelblk"; });
        if (vols.length) {
            var result = voxeliseVolumesBudget(vols, res, o.maxVoxels);
            if (result && result.count) { positions = result.positions; vres = result.res; }
        }
        if (positions && positions.length && !this.shellTrusted && this.shellFlat && this.shellFlat.length) {
            // Lid/face exclusion: strip pre-blast topo over the blast volume + 1 ring
            var local = new Float64Array(positions.length);
            for (var i = 0; i < positions.length; i += 3) { local[i] = positions[i] - this.origin.x; local[i + 1] = positions[i + 1] - this.origin.y; local[i + 2] = positions[i + 2] - this.origin.z; }
            this.SB = buildShellBin(this.shellFlat, lidExclusionKeys(local, 1));
        } else if (this.shellFlat) {
            this.SB = buildShellBin(this.shellFlat, null);
        }
        if (!positions || !positions.length) {
            if (!this.holes.length) { this.S = null; return 0; }
            var bb = voxeliseHoleBBox(this.holeEntries, vres, { pad: 5, padZ: 0.5, maxVoxels: o.maxVoxels });
            positions = bb.positions;
        }
        var N = Math.min(positions.length / 3, o.maxVoxels);
        this.actualRes = vres;
        var S = createParticleState(N);
        assignBlockRadii(S, vres, this.dem.sizeVariationPct, this.rng);
        var pzMin = Infinity;
        for (var k = 0; k < N; k++) {
            var wx = positions[k * 3], wy = positions[k * 3 + 1], wz = positions[k * 3 + 2];
            S.px[k] = S.ox[k] = wx - this.origin.x;
            S.py[k] = S.oy[k] = wy - this.origin.y;
            S.pz[k] = S.oz[k] = wz - this.origin.z;
            if (S.pz[k] < pzMin) pzMin = S.pz[k];
            var nh = this.holes.length ? nearestHole(this.holes, this.hb, wx, wy, wz) : [-1, Infinity];
            S.nearH[k] = nh[0]; S.nearD[k] = nh[1];
            S.at[k] = nh[0] >= 0 ? this.holes[nh[0]].fireT : 0;
            S.state[k] = ST_INACTIVE;
        }
        S.groundZ = (o.groundZ != null ? o.groundZ - this.origin.z : (pzMin === Infinity ? -10 : pzMin)) - S.radius;
        this.S = S;
        this.fragmentation = null;
        if (o.sizeModel != null && o.sizeModel !== "none") { this._applySizeModel(); S = this.S; N = S.N; }
        this.H = new SpatialHash(N, vres * 1.5);
        this._prepareContactModel();
        this.assignVelocities();
        if (this.engine && this.engine.build) this.engine.build(this);
        return N;
    }

    /**
     * (Re)compute launch velocities from the current parameters.
     * @returns {number} v0Max
     */
    assignVelocities() {
        if (!this.S) return 0;
        var v0;
        if (this.opts.velocityModel === "energy") v0 = assignEnergyPartitionVelocities(this.S, this.origin, this.holes, this.energy, this.rng);
        else v0 = assignYangVelocities(this.S, this.origin, this.holes, this.hb, this.yang, this.rng);
        this.S.v0Max = v0;
        return v0;
    }

    /** Set Yang / energy / DEM parameters (merged) without regenerating voxels. */
    setParams(params) {
        checkModelNames(params || {});
        Object.assign(this.opts, params || {});
        Object.assign(this.dem, params || {});
        Object.assign(this.yang, params || {});
        Object.assign(this.energy, params || {});
        return this;
    }

    /** DEM parameter bundle for physicsStep. */
    _P() {
        var P = {
            g: this.dem.g, restitution: this.dem.restitution, friction: this.dem.friction,
            bulkT: this.dem.bulkT, maxSwell: this.dem.maxSwell, swellCapLin: Math.cbrt(this.dem.maxSwell),
            bulking: !(this.engine && this.engine.emergentSwell)
        };
        if (this.dem.contactModel === "coulomb") {
            P.contactModel = "coulomb";
            P.swellCapLin = this.coulombGrowth;
            for (var key in COULOMB_DEFAULTS) if (this.dem[key] != null) P[key] = this.dem[key];
        }
        return P;
    }

    /** "coulomb": grow spheres so the pile bulks to maxSwell, and fit the hash to their size. */
    _prepareContactModel() {
        if (this.dem.contactModel !== "coulomb" || !this.S) return;
        var phi = this.dem.packingFraction != null ? this.dem.packingFraction : COULOMB_DEFAULTS.packingFraction;
        // The mesh's volume, not the voxel count's: a coarse lattice can be several percent off.
        this.coulombGrowth = bulkGrowthFactor(this.S, this.rockVolumeM3(), this.dem.maxSwell, phi);
        var largest = 0;
        for (var i = 0; i < this.S.N; i++) if (this.S.baseRad[i] > largest) largest = this.S.baseRad[i];
        var needed = 2 * largest * this.coulombGrowth * 1.03;
        if (needed > this.H.cellSize) this.H = new SpatialHash(this.S.N, needed);
    }

    /**
     * `sizeModel: "kuzram"`: estimate the fragment sizes for this design, then merge cells into
     * boulders for the rock the curve holds above a cell. Rock finer than a cell can't be resolved,
     * so those cells stay as lumps. Uncalibrated, and not for safety decisions.
     *
     * Options: rockFactorA, rws, rwsExponent, drillErrorM, chargeBasis, burdenM, spacingM, holeDiamMm.
     */
    _applySizeModel() {
        var o = this.opts;
        if (o.sizeModel !== "kuzram") throw new RangeError("sizeModel must be \"kuzram\" or \"none\", got " + o.sizeModel);
        if (this.dem.contactModel !== "coulomb" || this.engine) throw new RangeError("sizeModel \"kuzram\" needs contactModel \"coulomb\" and no external engine");
        var S = this.S, res = this.actualRes, cells = S.N;
        var rockM3 = this.rockVolumeM3();
        var design = blastInputs(this.holes, rockM3, { chargeBasis: o.chargeBasis, burdenM: o.burdenM, spacingM: o.spacingM, holeDiamMm: o.holeDiamMm });
        var inputs = Object.assign(design, {
            A: o.rockFactorA != null ? o.rockFactorA : ROCK_FACTOR.central,
            RWS: o.rws != null ? o.rws : RELATIVE_WEIGHT_STRENGTH.central,
            W: o.drillErrorM != null ? o.drillErrorM : DRILL_ERROR_M,
            rwsExponent: o.rwsExponent != null ? o.rwsExponent : RWS_EXPONENT_2005
        });
        var estimate = kuzRam(inputs, { sizesM: o.fragmentSizesM });
        var xMaxM = Math.min(design.B, design.S);
        var plan = boulderPlan({ x50M: estimate.x50M, n: estimate.n, cellM: res, cells: cells, xMaxM: xMaxM });
        var unplaced = 0;
        if (plan.classes.length) {
            var picked = pickBoulderClusters(S, res, plan.classes, this.rng);
            unplaced = picked.unplacedCells;
            S = mergeBlocks(S, picked.clusters);
            fitBoulders(S, this.SB);
            for (var i = 0; i < S.N; i++) {
                if (S.cells[i] < 2) continue;
                var nh = this.holes.length ? nearestHole(this.holes, this.hb, S.ox[i] + this.origin.x, S.oy[i] + this.origin.y, S.oz[i] + this.origin.z) : [-1, Infinity];
                S.nearH[i] = nh[0]; S.nearD[i] = nh[1];
                S.at[i] = nh[0] >= 0 ? this.holes[nh[0]].fireT : 0;
            }
        } else {
            S.cells = new Uint16Array(S.N).fill(1);
            S.cellsTotal = S.N;
        }
        S.rockPerCellM3 = rockM3 / cells;
        this.S = S;
        this.fragmentation = Object.assign({ model: "kuzram", uncalibrated: true, cellM: res, cells: cells, xMaxM: xMaxM, plan: plan, unplacedCells: unplaced }, estimate);
    }

    /** Per-block size data for a viewer: current radius, cells merged, rock represented. */
    blockSizes() {
        var S = this.S, N = S ? S.N : 0;
        var perCell = S ? (S.rockPerCellM3 || this.rockVolumeM3() / N) : 0;
        var cells = S && S.cells ? S.cells : new Uint16Array(N).fill(1);
        var represented = new Float64Array(N), boulder = new Uint8Array(N);
        for (var i = 0; i < N; i++) { represented[i] = cells[i] * perCell; boulder[i] = cells[i] > 1 ? 1 : 0; }
        return { count: N, rad: S ? S.rad : new Float32Array(0), cells: cells, boulder: boulder, representedM3: represented };
    }

    /** The estimate plus what the run made of it. Null without a size model. */
    _fragmentationSummary() {
        if (!this.fragmentation) return null;
        var S = this.S, largest = 0, largestRad = 0, boulders = 0;
        for (var i = 0; i < S.N; i++) {
            if (S.cells[i] > 1) boulders++;
            if (S.cells[i] > largest) largest = S.cells[i];
            if (S.baseRad[i] > largestRad) largestRad = S.baseRad[i];
        }
        var res = this.actualRes;
        return Object.assign({}, this.fragmentation, {
            blocks: S.N, boulders: boulders, largestBoulderCells: largest,
            largestBoulderRockM3: largest * S.rockPerCellM3,
            largestBoulderScreenM: res * Math.cbrt(largest),
            largestBlockFinalDiameterM: 2 * largestRad * (this.coulombGrowth || 1)
        });
    }

    /** In-situ rock: the closed volume mesh when there is one, else one voxel per block. */
    rockVolumeM3() {
        if (this._rockFor !== this.S) {
            this._rockFor = this.S;
            var vols = this.surfaces.filter(function (s) { return s.role === "voxelblk"; });
            var grid = vols.length ? calibrationGrid(vols, 0, Math.min(2, this.actualRes)) : null;
            var sum = 0;
            if (grid) { var thick = columnThickness(vols, grid).thick; for (var q = 0; q < thick.length; q++) sum += thick[q]; }
            this._rockM3 = sum > 0 ? sum * grid.cell * grid.cell : (this.S.cellsTotal || this.S.N) * this.actualRes * this.actualRes * this.actualRes;
        }
        return this._rockM3;
    }

    /** Blocks back in-situ, clock zeroed. */
    reset() {
        this.time = 0; this.running = false;
        if (this.S) resetParticleState(this.S);
        if (this.engine && this.engine.reset) this.engine.reset(this);
        this.stats = { active: 0, resting: 0 };
        return this;
    }

    /** Fire: reset + refresh velocities + start. */
    fire() {
        this.reset();
        this._prepareContactModel();
        this.assignVelocities();
        if (this.engine && this.engine.build) this.engine.build(this);
        this.running = true;
        return this;
    }

    /**
     * Advance one fixed sub-step (SUB_DT) or a caller-specified dt.
     * @param {number} [dt=SUB_DT]
     * @returns {{ active, resting }}
     */
    step(dt) {
        if (!this.S) return { active: 0, resting: 0 };
        dt = dt > 0 ? dt : SUB_DT;
        this.time += dt;
        var r;
        if (this.engine && this.engine.step) r = this.engine.step(this, dt);
        else r = physicsStep(this.S, this.H, this.SB, dt, this.time, this._P(), this.rng);
        this.stats = r;
        return r;
    }

    /**
     * Advance simulated time by `seconds` in fixed sub-steps.
     * @param {number} seconds
     * @param {number} [maxSteps=Infinity]
     * @returns {{ active, resting, steps }}
     */
    advance(seconds, maxSteps) {
        var steps = 0, r = this.stats;
        var target = this.time + seconds;
        var cap = maxSteps > 0 ? maxSteps : Infinity;
        while (this.time < target - 1e-9 && steps < cap) { r = this.step(SUB_DT); steps++; }
        return { active: r.active, resting: r.resting, steps: steps };
    }

    /** True once every fired block is at rest and the last hole has fired. */
    isSettled() {
        return this.stats.active === 0 && this.time > this.lastFireT + this.opts.settleAfterLastFireS;
    }

    /**
     * Run to the settled state (synchronous).
     * @param {Object} [opts] - { maxTime, onProgress(time, stats) every progressEvery steps }
     * @returns {{ time, steps, settled }}
     */
    run(opts) {
        opts = opts || {};
        if (!this.S) return { time: 0, steps: 0, settled: false };
        if (!this.running) this.fire();
        var maxT = opts.maxTime > 0 ? opts.maxTime : (this.opts.maxSimTimeS > 0 ? this.opts.maxSimTimeS : this.lastFireT + 12);
        var every = opts.progressEvery > 0 ? opts.progressEvery : 200;
        var steps = 0;
        while (this.time < maxT) {
            this.step(SUB_DT); steps++;
            if (opts.onProgress && steps % every === 0) opts.onProgress(this.time, this.stats);
            if (this.isSettled()) break;
        }
        this.running = false;
        return { time: this.time, steps: steps, settled: this.isSettled() };
    }

    /**
     * Run to settled, yielding to the event loop every `chunkSteps` (async).
     * @param {Object} [opts] - { maxTime, chunkSteps=120, onProgress }
     * @returns {Promise<{ time, steps, settled }>}
     */
    async runAsync(opts) {
        opts = opts || {};
        if (!this.S) return { time: 0, steps: 0, settled: false };
        if (!this.running) this.fire();
        var maxT = opts.maxTime > 0 ? opts.maxTime : (this.opts.maxSimTimeS > 0 ? this.opts.maxSimTimeS : this.lastFireT + 12);
        var chunk = opts.chunkSteps > 0 ? opts.chunkSteps : 120;
        var steps = 0;
        while (this.time < maxT) {
            for (var k = 0; k < chunk && this.time < maxT; k++) { this.step(SUB_DT); steps++; if (this.isSettled()) break; }
            if (opts.onProgress) opts.onProgress(this.time, this.stats);
            if (this.isSettled()) break;
            await new Promise(function (r) { setTimeout(r, 0); });
        }
        this.running = false;
        return { time: this.time, steps: steps, settled: this.isSettled() };
    }

    /**
     * Results bundle.
     * @param {Object} [opts] - { heightfieldCell=2 }
     * @returns {{ vectors, comShift, swell, swellEmergent, heightfield, time, blockCount, origin, res }}
     */
    results(opts) {
        opts = opts || {};
        if (!this.S) return null;
        var coulomb = this.dem.contactModel === "coulomb";
        var S = this.S, SB = this.SB;
        var bulk = swellBulk(S, {
            restedOnly: coulomb, // airborne rock isn't bulk; other contact keeps its old reading
            insituM3: this.rockVolumeM3(),
            floorAt: function (x, y) { return Math.max(shellHeightAt(SB, x, y), S.groundZ); }
        });
        var sizes = this._fragmentationSummary();
        return {
            ...(sizes ? { fragmentation: sizes } : {}),
            vectors: displacementVectors(this.S, this.origin),
            comShift: centreOfMassShift(this.S),
            // Under "coulomb" the swell reported is the bulk of the rock at rest (null if none is).
            swell: coulomb ? bulk : (this.engine && this.engine.emergentSwell ? swellEmergent(this.S) : swellPrescribed(this.S)),
            swellEmergent: swellEmergent(this.S),
            swellBulk: bulk,
            heightfield: muckpileHeightfield(this.S, this.origin, opts.heightfieldCell || 2, { spheres: coulomb }),
            time: this.time, blockCount: this.S.N, origin: this.origin, res: this.actualRes,
            settled: this.isSettled(), stats: this.stats
        };
    }

    /** Survey-derived calibration targets from the loaded surfaces. */
    surveyTargets() { return surveyTargets(this.surfaces); }

    /**
     * Back-calculate Pe from the survey (three coarse headless runs, secant fit
     * on the CoM throw). Applies the measured swell (clamped 1–2) and the best Pe.
     *
     * @param {Object} [opts] - { coarseMaxVoxels=10000, onProgress(label) }
     * @returns {Promise<{ survey, fitted: { Pe, throwD, pctOfSurvey }, runs: Array<[Pe, D]>, err? }>}
     */
    async calibrate(opts) {
        opts = opts || {};
        var T = this.surveyTargets();
        if (T.err) return { err: T.err };
        var keepMV = this.opts.maxVoxels;
        var swellSet = Math.max(1.0, Math.min(2.0, T.swell));
        this.dem.maxSwell = swellSet;
        this.opts.maxVoxels = opts.coarseMaxVoxels > 0 ? opts.coarseMaxVoxels : 10000;
        var self = this;
        var runs = [];
        var clampPe = function (v) { return Math.max(0.2, Math.min(3, v)); };
        var runHeadless = async function (pe, label) {
            self.yang.Pe = pe;
            self.generateVoxels();
            if (opts.onProgress) opts.onProgress(label);
            self.fire();
            await self.runAsync({ chunkSteps: 120, onProgress: opts.onProgress ? function (t) { opts.onProgress(label + " · t " + t.toFixed(1) + " s"); } : null });
            var d = centreOfMassShift(self.S).D;
            runs.push([pe, d]);
            return d;
        };
        try {
            var pe1 = this.yang.Pe;
            var d1 = await runHeadless(pe1, "Calibrating 1/3 (Pe " + pe1.toFixed(2) + ")");
            var pe2 = clampPe(pe1 * T.D / Math.max(d1, 0.5));
            if (Math.abs(pe2 - pe1) < 0.05) pe2 = clampPe(pe1 * 1.3);
            var d2 = await runHeadless(pe2, "Calibrating 2/3 (Pe " + pe2.toFixed(2) + ")");
            var pe3 = clampPe(pe2 + (T.D - d2) * (pe2 - pe1) / ((d2 - d1) || 1e-6));
            await runHeadless(pe3, "Calibrating 3/3 (Pe " + pe3.toFixed(2) + ")");
            var cands = runs.slice().sort(function (a, b) { return Math.abs(a[1] - T.D) - Math.abs(b[1] - T.D); });
            var best = cands[0];
            this.yang.Pe = best[0];
            return { survey: T, fitted: { Pe: best[0], throwD: best[1], pctOfSurvey: T.D > 0 ? best[1] / T.D * 100 : 0, maxSwell: swellSet }, runs: runs };
        } finally {
            this.opts.maxVoxels = keepMV;
            this.generateVoxels();
            this.reset();
        }
    }
}

export { ST_INACTIVE, ST_ACTIVE, ST_REST, SUB_DT };

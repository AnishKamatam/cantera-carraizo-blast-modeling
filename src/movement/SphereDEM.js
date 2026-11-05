/**
 * SphereDEM.js — Sphere discrete-element engine for blast throw
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * Blocks are spheres with per-block radii (fragmentation-shaped size scatter),
 * launched at their hole's fire time with the velocity from InitialVelocity.js
 * and integrated with gravity, spatial-hash sphere–sphere contacts (two
 * Jacobi passes, mass-weighted by ρr³), static shell / topo collision and a
 * ground plane. Detached fragments bulk toward the target swell factor over
 * `bulkT` seconds so the pile arrives pre-bulked. Blocks that stay slow in
 * contact for 12 sub-steps come to rest and become immovable, and can be
 * re-activated when hit hard enough by a heavier block.
 *
 * States: 0 INACTIVE (in-situ, unfired) · 1 ACTIVE · 2 REST (settled muck).
 *
 * All positions are LOCAL (world − origin) Float32 for precision.
 *
 * `contactModel: "coulomb"` swaps the contact step for physicsStepCoulomb (below):
 * real Coulomb friction, one contact per block on the shell, and reliable sleeping.
 * The default path above it is the reference simulator's and stays as it was.
 * Ported from the Kirra blast-throw simulator (throw_4 sphere DEM).
 */

import { shellCollide, shellClosest } from "./ShellCollider.js";

export var ST_INACTIVE = 0;
export var ST_ACTIVE = 1;
export var ST_REST = 2;

export var SUB_DT = 0.005;   // s — fixed physics sub-step

export var DEM_DEFAULTS = {
    g: 9.81,
    restitution: 0.1,
    friction: 0.5,
    bulkT: 0.6,          // s to reach full swelled size
    maxSwell: 1.4,       // target volumetric swell factor
    sizeVariationPct: 35 // fragment size scatter (0..70)
};

/** Settings of the "coulomb" contact model. All are judgement unless marked. */
export var COULOMB_DEFAULTS = {
    // Solid fraction of a settled pile of these spheres, so that bulk = solid / fraction.
    // DERIVED: set from a first measurement (0.62) on SWELLFACTOR, the shot Coulomb runs are
    // scored against, so its bias gain there isn't independent. Then checked; settled runs at mu 0.5
    // and 0.7 give 0.59-0.64, and at mu 0.3 about 0.66. It sits inside random loose (0.55)
    // to random close (0.64) packing for mu >= 0.5 (Onoda & Liniger 1990, Scott & Kilgour
    // 1969; SECONDARY, values from memory). Never adjusted against a survey.
    packingFraction: 0.60,
    solverPasses: 2,      // velocity passes per step; warm starting carries the rest
    positionPasses: 2,    // overlap removal passes per step (adds no velocity)
    restitutionMinV: 0.5, // m/s: slower impacts don't bounce, so resting load isn't inflated
    sleepV: 0.1,          // m/s: slower than this, in contact ...
    sleepT: 0.25,         // s: ... for this long, and the block sleeps
    wakeV: 0.7,           // m/s: an impact that would move a sleeper this fast wakes it
    slopFraction: 0.01,   // of the contact distance: overlap left alone, keeps contacts alive
    marginFraction: 0.02  // of the contact distance: gap within which a contact is tracked
};

/**
 * Allocate a particle state for N blocks.
 * @param {number} N
 * @returns {Object} typed-array bundle
 */
export function createParticleState(N) {
    var S = {
        N: N,
        px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
        vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
        ox: new Float32Array(N), oy: new Float32Array(N), oz: new Float32Array(N),
        ivx: new Float32Array(N), ivy: new Float32Array(N), ivz: new Float32Array(N),
        at: new Float32Array(N),
        state: new Uint8Array(N), restC: new Uint8Array(N),
        dist: new Float32Array(N),
        rx: new Float32Array(N), ry: new Float32Array(N), rz: new Float32Array(N),
        wx: new Float32Array(N), wy: new Float32Array(N), wz: new Float32Array(N),
        qx: new Float32Array(N * 4),
        contact: new Uint8Array(N),
        nearH: new Int32Array(N), nearD: new Float32Array(N),
        baseRad: new Float32Array(N), rad: new Float32Array(N),
        radius: 0, baseR: 0, groundZ: -10, v0Max: 0
    };
    for (var i = 0; i < N; i++) S.qx[i * 4 + 3] = 1;
    return S;
}

/**
 * Assign per-block base radii with fragmentation-shaped scatter
 * (Rosin–Rammler flavour: many smaller, few up to +15 %).
 * @param {Object} S
 * @param {number} res  - voxel edge (m); nominal radius = 0.47·res
 * @param {number} sizeVariationPct
 * @param {() => number} [rng]
 */
export function assignBlockRadii(S, res, sizeVariationPct, rng) {
    var rand = rng || Math.random;
    var sizeVar = (sizeVariationPct || 0) / 100;
    S.radius = 0.47 * res;
    S.baseR = S.radius;
    for (var i = 0; i < S.N; i++) {
        var u = rand();
        var f = Math.max(0.25, 1 + rand() * 0.15 - sizeVar * Math.pow(u, 1.5));
        S.baseRad[i] = S.baseR * f;
        S.rad[i] = S.baseRad[i];
    }
}

/**
 * Spatial hash for sphere–sphere contacts.
 */
export class SpatialHash {
    /**
     * @param {number} N        - block count
     * @param {number} cellSize - ≥ 2 × max radius
     */
    constructor(N, cellSize) {
        this.cellSize = cellSize;
        this.size = 2 * N;
        this.count = new Int32Array(this.size + 1);
        this.entries = new Int32Array(N);
    }
    key(xi, yi, zi) {
        var h = (xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481);
        return Math.abs(h) % this.size;
    }
    build(S) {
        var cs = this.cellSize, N = S.N, H = this;
        H.count.fill(0);
        for (var i = 0; i < N; i++) H.count[H.key(Math.floor(S.px[i] / cs), Math.floor(S.py[i] / cs), Math.floor(S.pz[i] / cs))]++;
        var sum = 0;
        for (var c = 0; c < H.size; c++) { sum += H.count[c]; H.count[c] = sum; }
        H.count[H.size] = sum;
        for (var j = 0; j < N; j++) {
            var h = H.key(Math.floor(S.px[j] / cs), Math.floor(S.py[j] / cs), Math.floor(S.pz[j] / cs));
            H.count[h]--;
            H.entries[H.count[h]] = j;
        }
    }
}

/**
 * One Jacobi pass of sphere–sphere collision resolution.
 * @param {Object} S
 * @param {SpatialHash} H
 * @param {number} rest
 * @param {number} fric
 */
export function solveParticleCollisions(S, H, rest, fric) {
    var cs = H.cellSize, N = S.N;
    var tfAA = 1 - fric * 0.02;
    var tfAS = 1 - fric * 0.04;
    var rad = S.rad;
    for (var i = 0; i < N; i++) {
        if (S.state[i] !== ST_ACTIVE) continue;
        var cxi = Math.floor(S.px[i] / cs), cyi = Math.floor(S.py[i] / cs), czi = Math.floor(S.pz[i] / cs);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
            var h = H.key(cxi + dx, cyi + dy, czi + dz);
            var start = H.count[h], end = H.count[h + 1];
            for (var k = start; k < end; k++) {
                var j = H.entries[k];
                if (j === i) continue;
                var st_j = S.state[j];
                if (st_j === ST_ACTIVE && j < i) continue;
                var ddx = S.px[j] - S.px[i], ddy = S.py[j] - S.py[i], ddz = S.pz[j] - S.pz[i];
                var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                var minDist = rad[i] + rad[j];
                if (d2 >= minDist * minDist || d2 < 1e-9) continue;
                var d = Math.sqrt(d2);
                var inv = 1 / d;
                ddx *= inv; ddy *= inv; ddz *= inv;
                var overlap = minDist - d;
                if (st_j !== ST_ACTIVE) {
                    // Static: in-situ rock or settled muck — immovable
                    S.px[i] -= ddx * overlap; S.py[i] -= ddy * overlap; S.pz[i] -= ddz * overlap;
                    var vn = S.vx[i] * ddx + S.vy[i] * ddy + S.vz[i] * ddz;
                    if (vn > 0) {
                        S.vx[i] -= (1 + rest) * vn * ddx; S.vy[i] -= (1 + rest) * vn * ddy; S.vz[i] -= (1 + rest) * vn * ddz;
                        if (st_j === ST_REST && vn * (rad[i] * rad[i] * rad[i]) / (rad[j] * rad[j] * rad[j]) > 1.2) {
                            S.state[j] = ST_ACTIVE; S.restC[j] = 0;
                            S.vx[j] += vn * 0.4 * ddx; S.vy[j] += vn * 0.4 * ddy; S.vz[j] += vn * 0.4 * ddz;
                        }
                    }
                    S.vx[i] *= tfAS; S.vy[i] *= tfAS;
                    S.contact[i] = 1;
                } else {
                    // Mass-weighted response: m ∝ ρr³
                    var mi = rad[i] * rad[i] * rad[i], mj = rad[j] * rad[j] * rad[j];
                    var wi = mj / (mi + mj), wj = 1 - wi;
                    S.px[i] -= ddx * overlap * wi; S.py[i] -= ddy * overlap * wi; S.pz[i] -= ddz * overlap * wi;
                    S.px[j] += ddx * overlap * wj; S.py[j] += ddy * overlap * wj; S.pz[j] += ddz * overlap * wj;
                    var rvx = S.vx[j] - S.vx[i], rvy = S.vy[j] - S.vy[i], rvz = S.vz[j] - S.vz[i];
                    var vrel = rvx * ddx + rvy * ddy + rvz * ddz;
                    if (vrel < 0) {
                        var imp = -(1 + rest) * vrel;
                        S.vx[i] -= imp * wi * ddx; S.vy[i] -= imp * wi * ddy; S.vz[i] -= imp * wi * ddz;
                        S.vx[j] += imp * wj * ddx; S.vy[j] += imp * wj * ddy; S.vz[j] += imp * wj * ddz;
                        S.vx[i] *= tfAA; S.vy[i] *= tfAA; S.vx[j] *= tfAA; S.vy[j] *= tfAA;
                    }
                }
            }
        }
    }
}

/**
 * Advance the DEM by dt seconds.
 *
 * @param {Object} S       - particle state
 * @param {SpatialHash} H
 * @param {Object|null} SB - shell collider (buildShellBin) or null
 * @param {number} dt
 * @param {number} time    - simulation clock AFTER this step (s) — blocks with at <= time launch
 * @param {Object} P       - { g, restitution, friction, bulkT, swellCapLin, bulking: bool }
 * @param {() => number} [rng]
 * @returns {{ active: number, resting: number }}
 */
export function physicsStep(S, H, SB, dt, time, P, rng) {
    if (P.contactModel === "coulomb") return physicsStepCoulomb(S, H, SB, dt, time, P, rng);
    var rand = rng || Math.random;
    var g = P.g, rest = P.restitution, fric = P.friction;
    var N = S.N, gz = S.groundZ;
    var bulking = P.bulking !== false;
    var swellCapLin = P.swellCapLin > 0 ? P.swellCapLin : Math.cbrt(P.maxSwell || 1.4);
    var bulkT = P.bulkT > 0 ? P.bulkT : 0.6;

    for (var i = 0; i < N; i++) {
        if (S.state[i] === ST_INACTIVE && time >= S.at[i]) {
            S.state[i] = ST_ACTIVE;
            S.vx[i] = S.ivx[i]; S.vy[i] = S.ivy[i]; S.vz[i] = S.ivz[i];
            var sp = Math.sqrt(S.vx[i] * S.vx[i] + S.vy[i] * S.vy[i] + S.vz[i] * S.vz[i]) / S.rad[i] * 0.4;
            S.wx[i] = (rand() - 0.5) * sp; S.wy[i] = (rand() - 0.5) * sp; S.wz[i] = (rand() - 0.5) * sp;
        }
        if (S.state[i] !== ST_ACTIVE) continue;
        S.vz[i] -= g * dt;
        S.px[i] += S.vx[i] * dt; S.py[i] += S.vy[i] * dt; S.pz[i] += S.vz[i] * dt;
        S.rx[i] += S.wx[i] * dt; S.ry[i] += S.wy[i] * dt; S.rz[i] += S.wz[i] * dt;
        if (bulking) {
            var capR = S.baseRad[i] * swellCapLin;
            if (S.rad[i] < capR) S.rad[i] = Math.min(capR, S.rad[i] + (capR - S.baseRad[i]) * dt / bulkT);
        }
    }

    S.contact.fill(0);
    H.build(S);
    solveParticleCollisions(S, H, rest, fric);
    solveParticleCollisions(S, H, rest, fric);

    var activeN = 0, restN = 0;
    for (var k = 0; k < N; k++) {
        var st = S.state[k];
        if (st === ST_REST) { restN++; continue; }
        if (st !== ST_ACTIVE) continue;
        activeN++;
        var ri = S.rad[k];
        var contact = S.contact[k] !== 0;
        if (SB && shellCollide(SB, S, k, rest, fric, ri)) contact = true;
        if (S.pz[k] < gz + ri) {
            S.pz[k] = gz + ri;
            if (S.vz[k] < 0) S.vz[k] *= -rest;
            var tf = 1 - fric * 0.25;
            S.vx[k] *= tf; S.vy[k] *= tf;
            contact = true;
        }
        if (contact) { S.contact[k] = 1; S.wx[k] *= 0.85; S.wy[k] *= 0.85; S.wz[k] *= 0.85; }
        var spd2 = S.vx[k] * S.vx[k] + S.vy[k] * S.vy[k] + S.vz[k] * S.vz[k];
        var fullyBulked = !bulking || S.rad[k] >= S.baseRad[k] * swellCapLin * 0.95;
        if (contact && spd2 < 0.04 && fullyBulked) {
            S.restC[k]++;
            if (S.restC[k] > 12) {
                S.state[k] = ST_REST;
                S.vx[k] = 0; S.vy[k] = 0; S.vz[k] = 0; S.wx[k] = 0; S.wy[k] = 0; S.wz[k] = 0;
            }
        } else if (S.restC[k] > 0 && spd2 > 0.09) {
            S.restC[k] = 0;
        }
        var ddx = S.px[k] - S.ox[k], ddy = S.py[k] - S.oy[k], ddz = S.pz[k] - S.oz[k];
        S.dist[k] = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    }
    return { active: activeN, resting: restN };
}

/**
 * Reset a state to in-situ (positions, velocities, radii, flags).
 * @param {Object} S
 */
export function resetParticleState(S) {
    var N = S.N;
    for (var i = 0; i < N; i++) {
        S.px[i] = S.ox[i]; S.py[i] = S.oy[i]; S.pz[i] = S.oz[i];
        S.vx[i] = 0; S.vy[i] = 0; S.vz[i] = 0;
        S.rx[i] = 0; S.ry[i] = 0; S.rz[i] = 0;
        S.wx[i] = 0; S.wy[i] = 0; S.wz[i] = 0;
        S.state[i] = ST_INACTIVE; S.restC[i] = 0; S.dist[i] = 0; S.contact[i] = 0;
        S.qx[i * 4] = 0; S.qx[i * 4 + 1] = 0; S.qx[i * 4 + 2] = 0; S.qx[i * 4 + 3] = 1;
    }
    S.rad.set(S.initRad || S.baseRad);
    S.coulomb = null;
}

/**
 * Choose which cells merge into boulders: compact connected clusters, largest first, from
 * seeds in random order. Position isn't biased towards the stemming or the back of the
 * blast: no source read gives an amount, so any bias would only be a guess.
 *
 * @param {Object} S - in-situ state, one block per cell
 * @param {number} res - cell edge (m)
 * @param {Array<{cells, count}>} classes - from boulderPlan, largest first
 * @param {() => number} rng
 * @returns {{ clusters: number[][], unplacedCells: number }} unplacedCells stay single
 */
export function pickBoulderClusters(S, res, classes, rng) {
    var N = S.N, reach2 = (1.2 * res) * (1.2 * res); // columns' z lattices differ by up to res/2
    var bins = new Map();
    var binKey = function (a, b, c) { return a + "|" + b + "|" + c; };
    for (var i = 0; i < N; i++) {
        var key = binKey(Math.floor(S.ox[i] / res), Math.floor(S.oy[i] / res), Math.floor(S.oz[i] / res));
        var list = bins.get(key);
        if (list) list.push(i); else bins.set(key, [i]);
    }
    var order = new Int32Array(N);
    for (var o = 0; o < N; o++) order[o] = o;
    for (var f = N - 1; f > 0; f--) { var g = Math.floor(rng() * (f + 1)), tmp = order[f]; order[f] = order[g]; order[g] = tmp; }

    var used = new Uint8Array(N), clusters = [], unplaced = 0;
    var grow = function (seed, size) {
        var cluster = [seed], inCluster = new Set(cluster), frontier = new Set();
        var sx = S.ox[seed], sy = S.oy[seed], sz = S.oz[seed];
        var addNeighbours = function (a) {
            var ca = Math.floor(S.ox[a] / res), cb = Math.floor(S.oy[a] / res), cc = Math.floor(S.oz[a] / res);
            for (var da = -2; da <= 2; da++) for (var db = -2; db <= 2; db++) for (var dc = -2; dc <= 2; dc++) {
                var cell = bins.get(binKey(ca + da, cb + db, cc + dc));
                if (!cell) continue;
                for (var k = 0; k < cell.length; k++) {
                    var b = cell[k];
                    if (used[b] || inCluster.has(b)) continue;
                    var ex = S.ox[a] - S.ox[b], ey = S.oy[a] - S.oy[b], ez = S.oz[a] - S.oz[b];
                    if (ex * ex + ey * ey + ez * ez <= reach2) frontier.add(b);
                }
            }
        };
        addNeighbours(seed);
        while (cluster.length < size) {
            if (!frontier.size) return null;
            var count = cluster.length, cx = sx / count, cy = sy / count, cz = sz / count, best = -1, bestD = Infinity;
            frontier.forEach(function (b) {
                var ex = S.ox[b] - cx, ey = S.oy[b] - cy, ez = S.oz[b] - cz, d = ex * ex + ey * ey + ez * ez;
                if (d < bestD || (d === bestD && b < best)) { bestD = d; best = b; }
            });
            frontier.delete(best);
            cluster.push(best); inCluster.add(best);
            sx += S.ox[best]; sy += S.oy[best]; sz += S.oz[best];
            addNeighbours(best);
        }
        return cluster;
    };
    (classes || []).forEach(function (c) {
        var next = 0;
        for (var n = 0; n < c.count; n++) {
            var cluster = null;
            while (!cluster && next < N) {
                var seed = order[next++];
                if (!used[seed]) cluster = grow(seed, c.cells);
            }
            if (!cluster) { unplaced += c.cells; continue; }
            for (var m = 0; m < cluster.length; m++) used[cluster[m]] = 1;
            clusters.push(cluster);
        }
    });
    return { clusters: clusters, unplacedCells: unplaced };
}

/**
 * A new in-situ state with each cluster merged into one sphere at its mass-weighted centre.
 * baseRad cubed adds up, and that is both the block's mass and the base of its growth, so
 * mass and the pile's solid volume are conserved. Surviving cells keep their order; boulders
 * follow. Holes and launch values aren't set for boulders here.
 *
 * @param {Object} S - in-situ state, one block per cell
 * @param {number[][]} clusters
 * @returns {Object} state with `cells` (cells per block), `cellsTotal`, `initRad`
 */
export function mergeBlocks(S, clusters) {
    var merged = new Uint8Array(S.N), lost = 0;
    clusters.forEach(function (c) { lost += c.length - 1; c.forEach(function (i) { merged[i] = 1; }); });
    var M = createParticleState(S.N - lost);
    M.radius = S.radius; M.baseR = S.baseR; M.groundZ = S.groundZ; M.v0Max = S.v0Max;
    M.cells = new Uint16Array(M.N); M.cellsTotal = S.N;
    // The in-situ rock, cell by cell. A merged cell is still rock until it fires, so launch
    // (buildRockGrid) must not read the gaps a merge leaves as free faces.
    M.rockCells = { ox: S.ox, oy: S.oy, oz: S.oz };
    var w = 0;
    for (var i = 0; i < S.N; i++) {
        if (merged[i]) continue;
        M.px[w] = M.ox[w] = S.ox[i]; M.py[w] = M.oy[w] = S.oy[i]; M.pz[w] = M.oz[w] = S.oz[i];
        M.baseRad[w] = S.baseRad[i]; M.at[w] = S.at[i]; M.nearH[w] = S.nearH[i]; M.nearD[w] = S.nearD[i];
        M.state[w] = S.state[i]; M.cells[w] = 1;
        w++;
    }
    clusters.forEach(function (c) {
        var mass = 0, sx = 0, sy = 0, sz = 0;
        c.forEach(function (j) {
            var r = S.baseRad[j], m = r * r * r;
            mass += m; sx += m * S.ox[j]; sy += m * S.oy[j]; sz += m * S.oz[j];
        });
        M.px[w] = M.ox[w] = sx / mass; M.py[w] = M.oy[w] = sy / mass; M.pz[w] = M.oz[w] = sz / mass;
        M.baseRad[w] = Math.cbrt(mass); M.state[w] = S.state[c[0]]; M.cells[w] = c.length;
        M.nearH[w] = -1; M.nearD[w] = Infinity;
        w++;
    });
    M.rad.set(M.baseRad);
    M.initRad = Float32Array.from(M.baseRad);
    return M;
}

/**
 * Shrink each boulder's in-situ radius so it starts clear of its neighbours. It keeps its
 * mass (baseRad) and grows to full size after launch, like any block. Neighbours are left
 * alone, largest boulders first. The floor is respected down to a quarter of the radius:
 * below that it is left to the step's own floor correction, which adds no velocity.
 *
 * @param {Object} M - from mergeBlocks
 * @param {Object|null} SB - shell collider
 */
export function fitBoulders(M, SB) {
    var boulders = [], out = new Float64Array(4);
    for (var b = 0; b < M.N; b++) if (M.cells[b] > 1) boulders.push(b);
    boulders.sort(function (p, q) { return M.cells[q] - M.cells[p] || p - q; });
    boulders.forEach(function (i) {
        var base = M.baseRad[i], clear = base;
        for (var j = 0; j < M.N; j++) {
            if (j === i) continue;
            var d = Math.hypot(M.px[i] - M.px[j], M.py[i] - M.py[j], M.pz[i] - M.pz[j]);
            if (d - M.rad[j] < clear) clear = d - M.rad[j];
        }
        var floor = M.pz[i] - M.groundZ;
        if (SB && shellClosest(SB, M.px[i], M.py[i], M.pz[i], base, out) && out[0] < floor) floor = out[0];
        var r = Math.min(clear, Math.max(floor, 0.25 * base));
        M.rad[i] = M.initRad[i] = Math.max(r * (1 - 1e-6), 1e-3 * base);
    });
}

/**
 * Linear growth that makes a settled pile of these spheres bulk to `swell`:
 * solid sphere volume = packingFraction x swell x in-situ volume. The older
 * cbrt(swell) only scales sphere volume, which starts well below the voxel's.
 * @param {Object} S
 * @param {number} rockM3 - in-situ rock volume of all blocks
 * @param {number} swell - target bulk / in-situ volume
 * @param {number} packingFraction
 * @returns {number}
 */
export function bulkGrowthFactor(S, rockM3, swell, packingFraction) {
    var sum = 0;
    for (var i = 0; i < S.N; i++) sum += S.baseRad[i] * S.baseRad[i] * S.baseRad[i];
    if (!(sum > 0)) return 1;
    return Math.cbrt(packingFraction * swell * rockM3 / ((4 / 3) * Math.PI * sum));
}

function contactBuffer(cap) {
    return {
        n: 0, cap: cap,
        a: new Int32Array(cap), b: new Int32Array(cap), next: new Int32Array(cap),
        nx: new Float64Array(cap), ny: new Float64Array(cap), nz: new Float64Array(cap),
        target: new Float64Array(cap), jn: new Float64Array(cap),
        jx: new Float64Array(cap), jy: new Float64Array(cap), jz: new Float64Array(cap)
    };
}

function coulombState(S) {
    var cap = Math.max(64, S.N * 8);
    return {
        cur: contactBuffer(cap), prev: contactBuffer(cap), mark: 0,
        head: new Int32Array(S.N).fill(-1), prevHead: new Int32Array(S.N).fill(-1),
        stamp: new Int32Array(S.N), restT: new Float32Array(S.N), supportT: 0,
        lastX: new Float32Array(S.N), lastY: new Float32Array(S.N), lastZ: new Float32Array(S.N),
        im: new Float64Array(S.N), out: new Float64Array(4)
    };
}

function growContacts(C) {
    var old = C.cur, buf = contactBuffer(old.cap * 2);
    ["a", "b", "next", "nx", "ny", "nz", "target", "jn", "jx", "jy", "jz"].forEach(function (k) { buf[k].set(old[k]); });
    buf.n = old.n;
    C.cur = buf;
}

var B_GROUND = -1, B_SHELL = -2; // the "other body" of a contact with static geometry
// A sleeping or unfired block as the other body. Its own inverse, so it also decodes.
function staticId(x) { return -3 - x; }

/** Add a contact of block a; n runs from the other body towards a. */
function addContact(C, S, a, b, nx, ny, nz, gap, dt, P, slopV) {
    if (C.cur.n >= C.cur.cap) growContacts(C);
    var K = C.cur, c = K.n++;
    K.a[c] = a; K.b[c] = b; K.nx[c] = nx; K.ny[c] = ny; K.nz[c] = nz;
    K.next[c] = C.head[a]; C.head[a] = c;
    var vb = b >= 0;
    var rvx = S.vx[a] - (vb ? S.vx[b] : 0), rvy = S.vy[a] - (vb ? S.vy[b] : 0), rvz = S.vz[a] - (vb ? S.vz[b] : 0);
    var vn = rvx * nx + rvy * ny + rvz * nz;
    // Speculative when apart: only stop the approach that would close the gap this step.
    // Newton restitution on real impacts only, so a resting load isn't inflated.
    K.target[c] = gap > 0 ? -gap / dt : (vn < -slopV ? -P.restitution * vn : 0);
    // Warm start from the same contact last step, resolved onto this step's plane.
    var jn = 0, jx = 0, jy = 0, jz = 0;
    var Pv = C.prev;
    for (var e = C.prevHead[a]; e >= 0; e = Pv.next[e]) {
        if (Pv.b[e] !== b) continue;
        jn = Pv.jn[e];
        var dot = Pv.jx[e] * nx + Pv.jy[e] * ny + Pv.jz[e] * nz;
        jx = Pv.jx[e] - dot * nx; jy = Pv.jy[e] - dot * ny; jz = Pv.jz[e] - dot * nz;
        break;
    }
    K.jn[c] = jn; K.jx[c] = jx; K.jy[c] = jy; K.jz[c] = jz;
    if (jn > 0 || jx !== 0 || jy !== 0 || jz !== 0) {
        var ix = jn * nx + jx, iy = jn * ny + jy, iz = jn * nz + jz;
        var ia = C.im[a];
        S.vx[a] += ix * ia; S.vy[a] += iy * ia; S.vz[a] += iz * ia;
        if (vb) { var ib = C.im[b]; S.vx[b] -= ix * ib; S.vy[b] -= iy * ib; S.vz[b] -= iz * ib; }
    }
}

var SUPPORT_CHECK_S = 0.1; // s between checks that sleepers still have something under them

/** Wake any sleeping block with nothing left beneath its centre: its support moved away. */
function wakeUnsupported(S, H, SB, C, marginF) {
    var cs = H.cellSize, out = C.out;
    for (var a = 0; a < S.N; a++) {
        if (S.state[a] !== ST_REST) continue;
        var ra = S.rad[a], ax = S.px[a], ay = S.py[a], az = S.pz[a], reach = ra * (1 + 2 * marginF);
        if (az - S.groundZ - ra < ra * 2 * marginF) continue;
        if (SB && shellClosest(SB, ax, ay, az, reach, out) && out[3] > 0) continue;
        var supported = false;
        var cxi = Math.floor(ax / cs), cyi = Math.floor(ay / cs), czi = Math.floor(az / cs);
        search:
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 0; dz++) {
            var h = H.key(cxi + dx, cyi + dy, czi + dz);
            for (var k = H.count[h], end = H.count[h + 1]; k < end; k++) {
                var b = H.entries[k];
                if (b === a || S.pz[b] >= az) continue;
                var ex = ax - S.px[b], ey = ay - S.py[b], ez = az - S.pz[b];
                var rr = (ra + S.rad[b]) * (1 + 2 * marginF);
                if (ex * ex + ey * ey + ez * ez < rr * rr) { supported = true; break search; }
            }
        }
        if (!supported) { S.state[a] = ST_ACTIVE; C.restT[a] = 0; C.lastX[a] = ax; C.lastY[a] = ay; C.lastZ[a] = az; }
    }
}

/**
 * One step of the "coulomb" contact model: velocity-level contact dynamics, in the
 * manner of Moreau (1994) and Jean (1999) non-smooth contact dynamics (SECONDARY, from
 * memory) with warm-started sequential impulses (Catto 2005; SECONDARY, from memory).
 *
 *  - The accumulated normal impulse carries a pile's true load between layers, so the
 *    friction limit |jt| <= mu jn holds at depth as well as at the surface.
 *  - Blocks don't roll: rock isn't round, and rotation here is only cosmetic.
 *  - Overlap, including the overlap made by bulking, is removed by moving positions.
 *    That adds no velocity, so bulking can't act as a second launch.
 *  - Mass is the rock's (baseRad cubed): it doesn't change as a block bulks.
 *  - Sleeping blocks act as static geometry until an impact or a lost support wakes them.
 *
 * @returns {{ active: number, resting: number }}
 */
export function physicsStepCoulomb(S, H, SB, dt, time, P, rng) {
    var rand = rng || Math.random;
    var N = S.N, g = P.g, mu = P.friction, gz = S.groundZ;
    var bulking = P.bulking !== false;
    var swellCapLin = P.swellCapLin > 0 ? P.swellCapLin : 1;
    var bulkT = P.bulkT > 0 ? P.bulkT : 0.6;
    var D = COULOMB_DEFAULTS;
    var passes = P.solverPasses > 0 ? P.solverPasses : D.solverPasses;
    var posPasses = P.positionPasses != null ? P.positionPasses : D.positionPasses;
    var minV = P.restitutionMinV != null ? P.restitutionMinV : D.restitutionMinV;
    var sleepV = P.sleepV > 0 ? P.sleepV : D.sleepV, sleepT = P.sleepT > 0 ? P.sleepT : D.sleepT;
    var wakeV = P.wakeV > 0 ? P.wakeV : D.wakeV;
    var slopF = P.slopFraction != null ? P.slopFraction : D.slopFraction;
    var marginF = P.marginFraction != null ? P.marginFraction : D.marginFraction;

    var C = S.coulomb;
    if (!C) {
        C = S.coulomb = coulombState(S);
        for (var i0 = 0; i0 < N; i0++) { var br = S.baseRad[i0]; C.im[i0] = 1 / (br * br * br); }
    }
    var px = S.px, py = S.py, pz = S.pz, vx = S.vx, vy = S.vy, vz = S.vz, rad = S.rad, state = S.state;

    // Launch, gravity, growth
    C.supportT += dt;
    for (var i = 0; i < N; i++) {
        if (state[i] === ST_INACTIVE && time >= S.at[i]) {
            state[i] = ST_ACTIVE;
            vx[i] = S.ivx[i]; vy[i] = S.ivy[i]; vz[i] = S.ivz[i];
            var sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) / rad[i] * 0.4;
            S.wx[i] = (rand() - 0.5) * sp; S.wy[i] = (rand() - 0.5) * sp; S.wz[i] = (rand() - 0.5) * sp;
        }
        if (state[i] !== ST_ACTIVE) continue;
        vz[i] -= g * dt;
        C.lastX[i] = px[i]; C.lastY[i] = py[i]; C.lastZ[i] = pz[i];
        if (bulking) {
            var capR = S.baseRad[i] * swellCapLin;
            if (rad[i] < capR) rad[i] = Math.min(capR, rad[i] + (capR - S.baseRad[i]) * dt / bulkT);
        }
    }

    // Find contacts; last step's list becomes the warm-start source.
    var swapB = C.prev; C.prev = C.cur; C.cur = swapB; C.cur.n = 0;
    var swapH = C.prevHead; C.prevHead = C.head; C.head = swapH; C.head.fill(-1);
    H.build(S);
    var cs = H.cellSize, out = C.out, stamp = C.stamp;
    if (C.supportT >= SUPPORT_CHECK_S) { C.supportT = 0; wakeUnsupported(S, H, SB, C, marginF); }
    for (var a = 0; a < N; a++) {
        if (state[a] !== ST_ACTIVE) continue;
        var ra = rad[a], ax = px[a], ay = py[a], az = pz[a];
        var cxi = Math.floor(ax / cs), cyi = Math.floor(ay / cs), czi = Math.floor(az / cs);
        var mark = ++C.mark;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
            var h = H.key(cxi + dx, cyi + dy, czi + dz);
            for (var k = H.count[h], kEnd = H.count[h + 1]; k < kEnd; k++) {
                var b = H.entries[k];
                if (b === a || stamp[b] === mark) continue;
                stamp[b] = mark; // hash buckets can repeat across neighbour cells
                var stB = state[b];
                if (stB === ST_ACTIVE && b < a) continue;
                var ex = ax - px[b], ey = ay - py[b], ez = az - pz[b];
                var minD = ra + rad[b], reach = minD * (1 + marginF);
                var d2 = ex * ex + ey * ey + ez * ez;
                if (d2 >= reach * reach || d2 < 1e-12) continue;
                var d = Math.sqrt(d2), inv = 1 / d;
                ex *= inv; ey *= inv; ez *= inv;
                if (stB === ST_REST) {
                    var rvn = vx[a] * ex + vy[a] * ey + vz[a] * ez;
                    var ma = 1 / C.im[a], mb = 1 / C.im[b];
                    // An inelastic hit would leave this block moving at this speed.
                    if (-rvn * ma / (ma + mb) > wakeV) { state[b] = ST_ACTIVE; stB = ST_ACTIVE; C.restT[b] = 0; }
                }
                var gap = d - minD;
                if (stB === ST_ACTIVE) {
                    addContact(C, S, a, b, ex, ey, ez, gap, dt, P, minV);
                } else {
                    addContact(C, S, a, staticId(b), ex, ey, ez, gap, dt, P, minV);
                }
            }
        }
        // Static floor: one shell contact (the closest), plus the ground plane.
        var reachS = ra * (1 + marginF);
        if (SB && shellClosest(SB, ax, ay, az, reachS, out)) addContact(C, S, a, B_SHELL, out[1], out[2], out[3], out[0] - ra, dt, P, minV);
        var gapG = az - gz - ra;
        if (gapG < ra * marginF) addContact(C, S, a, B_GROUND, 0, 0, 1, gapG, dt, P, minV);
    }

    // Velocity passes: normal first, then friction limited by the normal impulse so far.
    var K = C.cur, nC = K.n, im = C.im;
    for (var pass = 0; pass < passes; pass++) {
        for (var c = 0; c < nC; c++) {
            var ca = K.a[c], cb = K.b[c], dyn = cb >= 0;
            var ima = im[ca], imb = dyn ? im[cb] : 0, sumIm = ima + imb;
            var nx = K.nx[c], ny = K.ny[c], nz = K.nz[c];
            var rx = vx[ca] - (dyn ? vx[cb] : 0), ry = vy[ca] - (dyn ? vy[cb] : 0), rz = vz[ca] - (dyn ? vz[cb] : 0);
            var vn = rx * nx + ry * ny + rz * nz;
            var lam = (K.target[c] - vn) / sumIm;
            var jnOld = K.jn[c], jnNew = jnOld + lam;
            if (jnNew < 0) jnNew = 0;
            lam = jnNew - jnOld;
            K.jn[c] = jnNew;
            if (lam !== 0) {
                vx[ca] += lam * nx * ima; vy[ca] += lam * ny * ima; vz[ca] += lam * nz * ima;
                if (dyn) { vx[cb] -= lam * nx * imb; vy[cb] -= lam * ny * imb; vz[cb] -= lam * nz * imb; }
                rx += lam * nx * sumIm; ry += lam * ny * sumIm; rz += lam * nz * sumIm;
                vn += lam * sumIm;
            }
            // Tangential: the impulse that would stop sliding, clamped to mu jn.
            var tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
            var nextX = K.jx[c] - tx / sumIm, nextY = K.jy[c] - ty / sumIm, nextZ = K.jz[c] - tz / sumIm;
            var lim = mu * jnNew, mag2 = nextX * nextX + nextY * nextY + nextZ * nextZ;
            if (mag2 > lim * lim) {
                var scale = mag2 > 0 ? lim / Math.sqrt(mag2) : 0;
                nextX *= scale; nextY *= scale; nextZ *= scale;
            }
            var ix = nextX - K.jx[c], iy = nextY - K.jy[c], iz = nextZ - K.jz[c];
            K.jx[c] = nextX; K.jy[c] = nextY; K.jz[c] = nextZ;
            vx[ca] += ix * ima; vy[ca] += iy * ima; vz[ca] += iz * ima;
            if (dyn) { vx[cb] -= ix * imb; vy[cb] -= iy * imb; vz[cb] -= iz * imb; }
        }
    }

    // Positions move with the solved velocities.
    for (var n = 0; n < N; n++) {
        if (state[n] !== ST_ACTIVE) continue;
        px[n] += vx[n] * dt; py[n] += vy[n] * dt; pz[n] += vz[n] * dt;
        S.rx[n] += S.wx[n] * dt; S.ry[n] += S.wy[n] * dt; S.rz[n] += S.wz[n] * dt;
    }

    // Remove overlap by moving positions only, mass-weighted, against the live geometry.
    for (var q = 0; q < posPasses; q++) {
        for (var c2 = 0; c2 < nC; c2++) {
            var a2 = K.a[c2], b2 = K.b[c2];
            if (b2 === B_GROUND || b2 === B_SHELL) continue;
            var other = b2 >= 0 ? b2 : staticId(b2);
            var sx = px[a2] - px[other], sy = py[a2] - py[other], sz = pz[a2] - pz[other];
            var dd = sx * sx + sy * sy + sz * sz, md = rad[a2] + rad[other], al = md * (1 - slopF);
            if (dd >= al * al || dd < 1e-12) continue;
            var len = Math.sqrt(dd), push = (al - len) / len;
            if (b2 >= 0) {
                var wa = im[a2] / (im[a2] + im[b2]), wb = 1 - wa;
                px[a2] += sx * push * wa; py[a2] += sy * push * wa; pz[a2] += sz * push * wa;
                px[b2] -= sx * push * wb; py[b2] -= sy * push * wb; pz[b2] -= sz * push * wb;
            } else {
                px[a2] += sx * push; py[a2] += sy * push; pz[a2] += sz * push;
            }
        }
    }

    S.contact.fill(0);
    for (var c3 = 0; c3 < nC; c3++) {
        S.contact[K.a[c3]] = 1;
        if (K.b[c3] >= 0) S.contact[K.b[c3]] = 1;
    }

    // Floors have the last word, then sleeping.
    var activeN = 0, restN = 0;
    for (var m = 0; m < N; m++) {
        var st = state[m];
        if (st === ST_REST) { restN++; continue; }
        if (st !== ST_ACTIVE) continue;
        activeN++;
        var rm = rad[m];
        if (SB && shellClosest(SB, px[m], py[m], pz[m], rm, out)) {
            var pen = rm * (1 - slopF) - out[0];
            if (pen > 0) { px[m] += out[1] * pen; py[m] += out[2] * pen; pz[m] += out[3] * pen; }
        }
        if (pz[m] < gz + rm) pz[m] = gz + rm;
        var touching = S.contact[m] !== 0;
        if (touching) { S.wx[m] *= 0.85; S.wy[m] *= 0.85; S.wz[m] *= 0.85; }
        var mvx = (px[m] - C.lastX[m]) / dt, mvy = (py[m] - C.lastY[m]) / dt, mvz = (pz[m] - C.lastZ[m]) / dt;
        var moved2 = mvx * mvx + mvy * mvy + mvz * mvz;
        var fullyBulked = !bulking || rm >= S.baseRad[m] * swellCapLin * 0.999;
        if (touching && moved2 < sleepV * sleepV && fullyBulked) {
            C.restT[m] += dt;
            if (C.restT[m] >= sleepT) {
                state[m] = ST_REST;
                vx[m] = 0; vy[m] = 0; vz[m] = 0; S.wx[m] = 0; S.wy[m] = 0; S.wz[m] = 0;
            }
        } else {
            C.restT[m] = 0;
        }
        var ddx = px[m] - S.ox[m], ddy = py[m] - S.oy[m], ddz = pz[m] - S.oz[m];
        S.dist[m] = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    }
    return { active: activeN, resting: restN };
}

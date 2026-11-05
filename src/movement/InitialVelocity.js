/**
 * InitialVelocity.js — Per-block launch velocities for the blast movement simulator
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * Two launch models:
 *
 * 1) KINEMATIC LOADING, based on Yang & Kavetsky (1990) Eq 8-14 — default.
 *    Their b = 2 Pr - 1. Differences from the paper: charge is weighted by rho d^2 / 4
 *    (their Pe is calibrated per site, and Eq 21 scales it with sqrt(rho)); their
 *    confinement and inter-row delay terms (Eq 15-18) are replaced by the unsourced
 *    relief steering and timing window below; and blocks continue into a DEM rather
 *    than stopping on landing. See docs/verification/README.md.
 *    Each explosive deck is split into charge elements; a block receives
 *      |ΔV| = Pe · ρe · d² · Δl / (4 · r^b)
 *    from every element of every hole firing within the timing window of the
 *    block's motion time (its dominant hole), summed VECTORIALLY. Direction
 *    emerges from charge geometry: collar rock lifts, mid-bench heaves
 *    radially, toe pulls outward. Between cooperating charges the horizontal
 *    vector sum cancels; that confined momentum is recovered (steer c) and
 *    pointed down the timing gradient (toward relief).
 *
 * 2) ENERGY-PARTITION DEPTH-ZONE model — simpler alternative.
 *      v0 = √(2 · η · E · PF / ρ)   per hole (PF = mass / (B·S·H) kg/bcm)
 *    Direction: timing gradient blended with radial fan-out; depth zones from
 *    the charge column (stemming zone held back and more vertical, sub-grade
 *    flatter).
 *
 * 3) YANG & KAVETSKY (1990) AS PUBLISHED, behind velocityModel: "yang1990". Eq 12-14
 *    from the row behind, Eq 15-17 confinement, Eq 18 delay, Eq 21 density, with no
 *    steering, timing window, jitter or cap. See assignYang1990Velocities.
 *
 * Ported from the Kirra blast-throw simulator (prepareEnergetics /
 * assignThrowVectors, both generations).
 */

import { firingRows } from "./ThrowDirections.js";

export var ELEM_RCUT = 14;      // m — element contribution cutoff
// Tuned to one shot, not from a published model; Pe still has to be fitted per site.
export var PE_SCALE = 0.35;     // Pe=1.0, b=1.5 → ~17 m/s median on SWELLFACTOR
export var MAX_LAUNCH_SPEED = 45; // m/s hard cap

export var YANG_DEFAULTS = {
    Pe: 1.0,            // explosive strength parameter (scales all velocities)
    bExp: 1.5,          // |dV| falls as 1/r^b; b = 2 Pr - 1 (their calibrated Pr = 1.35 gives 1.7)
    cSteer: 0.85,       // relief steering + confined-momentum recovery
    timingWindowMs: 40, // charges cooperate within this window of the block's motion time
    fallbackVelocity: 5,// m/s when no charge element reaches the block
    rockDensity: 2650,  // kg/bcm; v ∝ √(2650/ρ)
    jitter: 0.1         // ±10 % random scatter on velocity
};

/**
 * velocityModel: "yang1990". Evidence levels are labelled on each value. Pe, Pr and Pd
 * are meant to be calibrated per site by Eq 20; every result at another site is
 * uncalibrated until that is done.
 */
export var YANG1990_DEFAULTS = {
    // PRIMARY, but one site: second case study, Eq 20 fit, ANFO decks in 290 mm holes on
    // an 18 m bench. Eq 21 covers changing explosive "with the same hole diameter" only,
    // and Eq 12 has no diameter term, so this Pe embeds that hole size. Named PeAnfo
    // because the older model's `Pe` has different units.
    PeAnfo: 55,
    Pr: 1.35,          // PRIMARY, same fit. Rock parameter; |dV| falls as 1/r^(2 Pr - 1)
    Pd: 0.01,          // PRIMARY (s). Same value at all three of their sites, 5-6 rows each
    C1: 0.2,           // PRIMARY. "Constant with an empirically determined value"
    rhoAnfo: 850,      // kg/m3. Judgement: usual ANFO density; the pages we hold give none
    rowWindowMs: 25,   // Judgement, from their Fig 1 (25 ms within a row, 120 ms between)
    rowRangeM: 30,     // Judgement: "spaced within a certain distance", no value given
    minRadiusM: null,  // Judgement: null = block half-width, a block's centre being the
                       // nearest it can stand for. Eq 8 is singular at r = 0
    sideFreeFace: false, // Judgement: rock edge along a row counts as confined, their Types 2, 4, 6
    delayS: null,      // Td override (s); null = from fire times (DERIVED, see firingRows)
    segmentM: 0.25,    // Integration step along the charge
    maxLaunchSpeed: null // No cap: none is sourced. launchDiag reports the speeds
};

export var ENERGY_DEFAULTS = {
    energyKJkg: 3000,   // explosive energy (kJ/kg) → E (J/kg)
    efficiency: 0.05,   // η — fraction of energy converted to kinetic
    verticalRatio: 0.35,// vertical/horizontal launch ratio
    fallbackVelocity: 5,
    rockDensity: 2650,
    maxSpeed: 40
};

/**
 * Sim-hole records from HoleEntry + DeckEntry lists.
 * @param {Array} holeEntries
 * @param {Array} deckEntries
 * @param {Object} [opts] - { fireTimeSource: 'deck'|'hole' (default 'deck') }
 * @returns {Array<{ index, id, cx,cy,cz, tx,ty,tz, diameter, fireT, mass, burden, spacing, gradeZ, benchHeight, stemLen, chargeBaseDepth, explDecks }>}
 */
export function simHolesFromEntries(holeEntries, deckEntries, opts) {
    opts = opts || {};
    var useDeck = opts.fireTimeSource !== "hole";
    var holes = [];
    for (var i = 0; i < holeEntries.length; i++) {
        var h = holeEntries[i];
        holes.push({
            index: i, id: String(h.holeID != null ? h.holeID : i), entityName: h.entityName || "",
            cx: h.collarX, cy: h.collarY, cz: h.collarZ, tx: h.toeX, ty: h.toeY, tz: h.toeZ,
            diameter: (h.holeDiamMm > 0 ? h.holeDiamMm : 165) / 1000,
            fireT: (h.holeTime || 0) / 1000,
            mass: h.massPerHole > 0 ? h.massPerHole : 0,
            burden: h.burden > 0 ? h.burden : 0, spacing: h.spacing > 0 ? h.spacing : 0,
            gradeZ: (typeof h.gradeZ === "number") ? h.gradeZ : (h.benchHeight > 0 ? h.collarZ - h.benchHeight : null),
            benchHeight: h.benchHeight > 0 ? h.benchHeight : 0,
            stemLen: 0, chargeBaseDepth: 0, explDecks: null, _deckFire: Infinity, _deckMass: 0
        });
    }
    for (var d = 0; d < (deckEntries || []).length; d++) {
        var dk = deckEntries[d];
        if (!dk || !(dk.mass > 0)) continue;
        var sh = holes[dk.holeIndex];
        if (!sh) continue;
        var dxh = sh.tx - sh.cx, dyh = sh.ty - sh.cy, dzh = sh.tz - sh.cz;
        var len = Math.sqrt(dxh * dxh + dyh * dyh + dzh * dzh) || 1;
        var top = Math.sqrt((dk.topX - sh.cx) ** 2 + (dk.topY - sh.cy) ** 2 + (dk.topZ - sh.cz) ** 2);
        var base = Math.sqrt((dk.baseX - sh.cx) ** 2 + (dk.baseY - sh.cy) ** 2 + (dk.baseZ - sh.cz) ** 2);
        if (!sh.explDecks) sh.explDecks = [];
        sh.explDecks.push({ top: Math.min(top, len), base: Math.min(base, len), rho: (dk.density > 0 ? dk.density : 1.15) * 1000, mass: dk.mass });
        if (sh.stemLen === 0 || top < sh.stemLen) sh.stemLen = top;
        if (base > sh.chargeBaseDepth) sh.chargeBaseDepth = base;
        sh._deckMass += dk.mass;
        var ft = (Number(dk.timingMs) || 0) / 1000;
        if (ft < sh._deckFire) sh._deckFire = ft;
    }
    for (var k = 0; k < holes.length; k++) {
        var s = holes[k];
        if (useDeck && s._deckFire < Infinity) s.fireT = s._deckFire;
        if (!(s.mass > 0) && s._deckMass > 0) s.mass = s._deckMass;
        delete s._deckFire; delete s._deckMass;
    }
    return holes;
}

/**
 * Discretise each hole's explosive decks into charge elements
 * { x, y, z, w } with w = ρe·d²·Δl/4 (element length ≥ 0.3 m), and build a
 * 10 m XY hole bin for fast gathering.
 *
 * @param {Array} holes - sim holes (from simHolesFromEntries)
 * @returns {{ total: number, bin: { mnX, mnY, cell, nx, ny, bins } }}
 */
export function prepareChargeElements(holes) {
    var total = 0;
    for (var hi = 0; hi < holes.length; hi++) {
        var h = holes[hi];
        h.elems = [];
        var hdx = h.tx - h.cx, hdy = h.ty - h.cy, hdz = h.tz - h.cz;
        var len = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz);
        if (len < 0.1) continue;
        var ux = hdx / len, uy = hdy / len, uz = hdz / len;
        var d = h.diameter > 0.01 ? h.diameter : 0.165;
        var decks = h.explDecks;
        if (!decks || !decks.length) {
            var top = h.stemLen > 0 ? h.stemLen : Math.min(2.5, len * 0.25);
            decks = [{ top: top, base: len, rho: 1150 }];
        }
        var el = Math.max(d, 0.3);
        for (var di = 0; di < decks.length; di++) {
            var dk = decks[di];
            var t0 = Math.max(0, dk.top), b0 = Math.min(len, dk.base);
            for (var sd = t0 + el / 2; sd < b0; sd += el) {
                h.elems.push({ x: h.cx + ux * sd, y: h.cy + uy * sd, z: h.cz + uz * sd, w: (dk.rho || 1150) * d * d * el / 4 });
                total++;
            }
        }
    }
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (var i = 0; i < holes.length; i++) {
        mnX = Math.min(mnX, holes[i].cx); mxX = Math.max(mxX, holes[i].cx);
        mnY = Math.min(mnY, holes[i].cy); mxY = Math.max(mxY, holes[i].cy);
    }
    var cell = 10;
    var nx = Math.max(1, Math.ceil((mxX - mnX) / cell) + 1);
    var ny = Math.max(1, Math.ceil((mxY - mnY) / cell) + 1);
    var bins = new Array(nx * ny);
    for (var j = 0; j < holes.length; j++) {
        var ci = Math.min(nx - 1, Math.max(0, Math.floor((holes[j].cx - mnX) / cell)));
        var cj = Math.min(ny - 1, Math.max(0, Math.floor((holes[j].cy - mnY) / cell)));
        var c = cj * nx + ci;
        if (!bins[c]) bins[c] = [];
        bins[c].push(j);
    }
    return { total: total, bin: { mnX: mnX, mnY: mnY, cell: cell, nx: nx, ny: ny, bins: bins } };
}

/**
 * Nearest hole (by distance to the hole axis segment) for a world point,
 * using a coarse XY bin. Returns [holeIndex, distance].
 * @param {Array} holes
 * @param {Object} hb  - hole bin (from buildHoleBin)
 * @param {number} wx @param {number} wy @param {number} wz
 * @returns {[number, number]}
 */
export function nearestHole(holes, hb, wx, wy, wz) {
    var ci = Math.min(hb.nx - 1, Math.max(0, Math.floor((wx - hb.mnX) / hb.cell)));
    var cj = Math.min(hb.ny - 1, Math.max(0, Math.floor((wy - hb.mnY) / hb.cell)));
    var best = -1, bestD = Infinity;
    for (var ring = 0; ring <= 3; ring++) {
        for (var dj = -ring; dj <= ring; dj++) {
            for (var di = -ring; di <= ring; di++) {
                if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
                var ii = ci + di, jj = cj + dj;
                if (ii < 0 || ii >= hb.nx || jj < 0 || jj >= hb.ny) continue;
                var bin = hb.bins[jj * hb.nx + ii];
                if (!bin) continue;
                for (var b = 0; b < bin.length; b++) {
                    var h = holes[bin[b]];
                    var dx = h.tx - h.cx, dy = h.ty - h.cy, dz = h.tz - h.cz;
                    var L2 = dx * dx + dy * dy + dz * dz;
                    var t = L2 > 1e-6 ? ((wx - h.cx) * dx + (wy - h.cy) * dy + (wz - h.cz) * dz) / L2 : 0;
                    t = Math.max(0, Math.min(1, t));
                    var qx = h.cx + t * dx, qy = h.cy + t * dy, qz = h.cz + t * dz;
                    var d = Math.sqrt((wx - qx) * (wx - qx) + (wy - qy) * (wy - qy) + (wz - qz) * (wz - qz));
                    if (d < bestD) { bestD = d; best = bin[b]; }
                }
            }
        }
        if (best >= 0 && bestD < ring * hb.cell) break;
    }
    if (best < 0) {
        for (var k = 0; k < holes.length; k++) {
            var hh = holes[k];
            var dd = Math.sqrt((wx - hh.cx) * (wx - hh.cx) + (wy - hh.cy) * (wy - hh.cy));
            if (dd < bestD) { bestD = dd; best = k; }
        }
    }
    return [best, bestD];
}

/**
 * Kinematic launch velocities based on Yang & Kavetsky (1990) Eq 8-14.
 *
 * @param {Object} S      - particle state: N, ox,oy,oz (local in-situ), nearH, ivx,ivy,ivz, at
 * @param {{x,y,z}} origin- local-frame origin (world = local + origin)
 * @param {Array}  holes  - sim holes with elems + thDirX/thDirY + fireT
 * @param {Object} hb     - hole bin (from prepareChargeElements)
 * @param {Object} [params] - YANG_DEFAULTS overrides
 * @param {() => number} [rng=Math.random]
 * @returns {number} v0Max (m/s)
 */
export function assignYangVelocities(S, origin, holes, hb, params, rng) {
    if (params && params.velocityModel === "yang1990") return assignYang1990Velocities(S, origin, holes, params);
    var p = Object.assign({}, YANG_DEFAULTS, params || {});
    var rand = rng || Math.random;
    var N = S.N;
    if (!holes.length || !N || !hb) return 0;
    var rhoScale = Math.sqrt(2650 / Math.max(1000, p.rockDensity));
    var Pe = p.Pe * PE_SCALE * rhoScale;
    var bExp = p.bExp, cSteer = p.cSteer;
    var Tw = p.timingWindowMs / 1000;
    var fallbackV = p.fallbackVelocity;
    var rcut2 = ELEM_RCUT * ELEM_RCUT;
    var jit = p.jitter;
    var vMax = 0;

    for (var i = 0; i < N; i++) {
        var hi = S.nearH[i];
        if (hi < 0) continue;
        var hd = holes[hi];
        var tb = hd.fireT;
        var wx = S.ox[i] + origin.x, wy = S.oy[i] + origin.y, wz = S.oz[i] + origin.z;

        var vx = 0, vy = 0, vz = 0, hPot = 0;
        var ci = Math.min(hb.nx - 1, Math.max(0, Math.floor((wx - hb.mnX) / hb.cell)));
        var cj = Math.min(hb.ny - 1, Math.max(0, Math.floor((wy - hb.mnY) / hb.cell)));
        for (var dj = -2; dj <= 2; dj++) {
            for (var di = -2; di <= 2; di++) {
                var ii = ci + di, jj = cj + dj;
                if (ii < 0 || ii >= hb.nx || jj < 0 || jj >= hb.ny) continue;
                var bin = hb.bins[jj * hb.nx + ii];
                if (!bin) continue;
                for (var b = 0; b < bin.length; b++) {
                    var hj = holes[bin[b]];
                    if (Math.abs(hj.fireT - tb) > Tw) continue;
                    var pdx = wx - hj.cx, pdy = wy - hj.cy;
                    if (pdx * pdx + pdy * pdy > rcut2 * 1.4) continue;
                    var elems = hj.elems;
                    if (!elems) continue;
                    for (var e = 0; e < elems.length; e++) {
                        var el = elems[e];
                        var ex = wx - el.x, ey = wy - el.y, ez = wz - el.z;
                        var r2 = ex * ex + ey * ey + ez * ez;
                        if (r2 > rcut2) continue;
                        var r = Math.sqrt(r2);
                        if (r < 0.3) r = 0.3;
                        var m = Pe * el.w / Math.pow(r, bExp + 1);
                        vx += m * ex; vy += m * ey; vz += m * ez;
                        hPot += m * Math.sqrt(ex * ex + ey * ey);
                    }
                }
            }
        }

        if (vx === 0 && vy === 0 && vz === 0) {
            var rdx = wx - hd.cx, rdy = wy - hd.cy;
            var rL = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
            vx = rdx / rL * fallbackV; vy = rdy / rL * fallbackV; vz = fallbackV * 0.25;
        } else if (hd.thDirX !== 0 || hd.thDirY !== 0) {
            var hLen = Math.sqrt(vx * vx + vy * vy);
            var hMag = hLen + cSteer * 0.6 * Math.max(0, hPot - hLen);
            var steerW = Math.min(cSteer, 1);
            var ix, iy;
            if (hLen > 0.01) { ix = vx / hLen; iy = vy / hLen; }
            else { ix = hd.thDirX; iy = hd.thDirY; }
            var bx = (1 - steerW) * ix + steerW * hd.thDirX;
            var by = (1 - steerW) * iy + steerW * hd.thDirY;
            var bl = Math.sqrt(bx * bx + by * by) || 1;
            vx = hMag * bx / bl; vy = hMag * by / bl;
        }

        var j = 1 - jit + rand() * 2 * jit;
        vx *= j; vy *= j; vz *= (1 - jit + rand() * 2 * jit);
        var sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (sp > MAX_LAUNCH_SPEED) { var f = MAX_LAUNCH_SPEED / sp; vx *= f; vy *= f; vz *= f; sp = MAX_LAUNCH_SPEED; }

        S.ivx[i] = vx; S.ivy[i] = vy; S.ivz[i] = vz;
        S.at[i] = hd.fireT;
        if (sp > vMax) vMax = sp;
    }
    return vMax || fallbackV;
}

/**
 * Split a hole's explosive decks into segments of exactly the charge's length.
 * @param {Object} hole - sim hole
 * @param {number} [segmentM=0.25]
 * @returns {Array<{x,y,z,dl,rho}>} rho in kg/m3
 */
export function holeChargeSegments(hole, segmentM) {
    var dx = hole.tx - hole.cx, dy = hole.ty - hole.cy, dz = hole.tz - hole.cz;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var out = [];
    if (len < 0.1) return out;
    var step = segmentM > 0 ? segmentM : 0.25;
    var decks = hole.explDecks;
    if (!decks || !decks.length) decks = [{ top: hole.stemLen > 0 ? hole.stemLen : Math.min(2.5, len * 0.25), base: len, rho: 1150 }];
    for (var d = 0; d < decks.length; d++) {
        var top = Math.max(0, decks[d].top), base = Math.min(len, decks[d].base);
        if (!(base > top)) continue;
        var count = Math.max(1, Math.round((base - top) / step)), dl = (base - top) / count;
        for (var i = 0; i < count; i++) {
            var f = (top + (i + 0.5) * dl) / len;
            out.push({ x: hole.cx + dx * f, y: hole.cy + dy * f, z: hole.cz + dz * f, dl: dl, rho: decks[d].rho || 1150 });
        }
    }
    return out;
}

/**
 * Eq 12-14 with Eq 21: the sum over charge segments of
 * Pe sqrt(rho / rho_ANFO) dl (X - Xe) / r^(2 Pr). r is held at rMin near a charge, keeping
 * direction, so a segment's |dV| can't exceed its Eq 8 value at rMin.
 *
 * @param {number} x @param {number} y @param {number} z
 * @param {Array<{x,y,z,dl,rho}>} segments
 * @param {{PeAnfo:number, Pr:number, rhoAnfo:number, rMin:number}} params
 * @param {{clipped:number}} [tally] - counts segments the near-charge limit applied to
 * @returns {{x:number, y:number, z:number}}
 */
export function chargeVelocity1990(x, y, z, segments, params, tally) {
    var vx = 0, vy = 0, vz = 0;
    var exponent = 2 * params.Pr - 1, rMin = params.rMin;
    for (var s = 0; s < segments.length; s++) {
        var e = segments[s];
        var ex = x - e.x, ey = y - e.y, ez = z - e.z;
        var r = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (r === 0) continue; // no direction
        var rEff = r;
        if (r < rMin) { rEff = rMin; if (tally) tally.clipped++; }
        var m = params.PeAnfo * Math.sqrt(e.rho / params.rhoAnfo) * e.dl / (Math.pow(rEff, exponent) * r);
        vx += m * ex; vy += m * ey; vz += m * ez;
    }
    return { x: vx, y: vy, z: vz };
}

/** Eq 15-17. D = Infinity is the paper's setting for a blast confined that way. */
export function confinementFactor(distanceM, C1) {
    return distanceM === Infinity ? 0 : Math.exp(-C1 * distanceM);
}

/** Eq 18. n rows in front, Td in seconds. */
export function delayFactor(Pd, rowsInFront, delayS) {
    return rowsInFront > 0 ? Math.exp(-Pd * rowsInFront / delayS) : 1;
}

/**
 * Occupancy grid of the rock, holding each block's launch time.
 * @param {ArrayLike<number>} positions - flat x,y,z block centres on a lattice of `cell`
 * @param {ArrayLike<number>} times     - launch time per block (s)
 * @param {number} cell
 */
export function buildRockGrid(positions, times, cell) {
    var count = positions.length / 3;
    var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < count; i++) {
        var x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    var grid = {
        x0: minX - cell / 2, y0: minY - cell / 2, z0: minZ - cell / 2, cell: cell,
        nx: Math.round((maxX - minX) / cell) + 1, ny: Math.round((maxY - minY) / cell) + 1, nz: Math.round((maxZ - minZ) / cell) + 1
    };
    grid.time = new Float64Array(grid.nx * grid.ny * grid.nz).fill(NaN);
    for (var b = 0; b < count; b++) {
        var ci = Math.floor((positions[b * 3] - grid.x0) / cell), cj = Math.floor((positions[b * 3 + 1] - grid.y0) / cell), ck = Math.floor((positions[b * 3 + 2] - grid.z0) / cell);
        grid.time[(ck * grid.ny + cj) * grid.nx + ci] = times[b];
    }
    return grid;
}

/**
 * Distance along a ray through rock still in place, to rock that fired before
 * `movedBefore` (s), or to the edge of the rock.
 * @param {boolean} [edgeIsFree=true] - false: reaching the edge of the rock means confined
 * @returns {number} metres, or Infinity when confined
 */
export function freeDistance(grid, x, y, z, ux, uy, uz, movedBefore, edgeIsFree) {
    var step = grid.cell / 2;
    var limit = (grid.nx + grid.ny + grid.nz) * grid.cell;
    for (var d = step; d <= limit; d += step) {
        var i = Math.floor((x + ux * d - grid.x0) / grid.cell);
        var j = Math.floor((y + uy * d - grid.y0) / grid.cell);
        var k = Math.floor((z + uz * d - grid.z0) / grid.cell);
        var t = (i < 0 || j < 0 || k < 0 || i >= grid.nx || j >= grid.ny || k >= grid.nz) ? NaN : grid.time[(k * grid.ny + j) * grid.nx + i];
        if (t !== t) return edgeIsFree === false ? Infinity : d; // NaN: no rock here
        if (t < movedBefore) return d;
    }
    return Infinity;
}

/**
 * Launch velocities as Yang & Kavetsky (1990) publish them. PRIMARY for the equations;
 * these choices are ours, because the paper leaves them open:
 * - Rows from fire time (their rows are hand-defined). A block belongs to the nearest
 *   hole behind it along that hole's firing direction, or its nearest hole if none is.
 *   That hole's row is the holes within rowWindowMs, rowRangeM and half a row spacing of
 *   its line.
 * - V_h is along that hole's -grad t, V_r across it. With flat timing, V_h is along the
 *   block's own horizontal velocity.
 * - D_sh runs through rock not yet fired, to rock fired over min(rowWindowMs, Td/2) earlier,
 *   or to the edge of the rock. V_h against the firing direction runs into unfired
 *   rock, so D_sh = infinity. Blocks know only their own mesh, not the shell, so
 *   a front edge counts as a free face even where intact rock lies beyond it.
 * - D_sr: moved rock counts; the rock's edge counts only with sideFreeFace.
 * - D_sv is "to the surface of the blast", as the paper says, whichever way V_z points.
 * - r is limited to minRadiusM, by default the block's half-width.
 * Eq 19 (centre-plane collisions in a V) isn't applied; the DEM has its own collisions.
 *
 * Writes S.ivx/ivy/ivz, S.at and S.launchDiag; uses no random numbers.
 *
 * @param {Object} S - particle state
 * @param {{x,y,z}} origin
 * @param {Array} holes - sim holes with thDirX/thDirY (computeThrowDirections) and fireT
 * @param {Object} [params] - YANG1990_DEFAULTS overrides
 * @returns {number} fastest launch speed (m/s)
 */
export function assignYang1990Velocities(S, origin, holes, params) {
    var p = Object.assign({}, YANG1990_DEFAULTS, params || {});
    if (p.Pe !== undefined && p.Pe !== YANG_DEFAULTS.Pe) {
        throw new Error("velocityModel yang1990 takes PeAnfo in the paper's units; the older Pe has different units, so it isn't converted. BlastMovementSimulator.calibrate() fits that Pe to throw and doesn't apply here.");
    }
    var N = S.N, H = holes.length;
    if (!H || !N) return 0;

    var res = S.baseR > 0 ? S.baseR / 0.47 : 1; // assignBlockRadii: baseR = 0.47 res
    var rMin = p.minRadiusM > 0 ? p.minRadiusM : res / 2;
    var velocityParams = { PeAnfo: p.PeAnfo, Pr: p.Pr, rhoAnfo: p.rhoAnfo, rMin: rMin };

    var rows = firingRows(holes);
    var Td = p.delayS > 0 ? p.delayS : rows.delayS;
    var rowDepth = 0.5 * rows.spacing;
    var windowS = p.rowWindowMs / 1000;
    var movedLag = Td > 0 ? Math.min(windowS, Td / 2) : windowS;
    var rowRange2 = p.rowRangeM * p.rowRangeM;

    var segmentsOf = new Array(H);
    for (var a = 0; a < H; a++) segmentsOf[a] = holeChargeSegments(holes[a], p.segmentM);
    var rowSegments = new Array(H);

    // A block's launching hole: nearest behind it, else nearest.
    var launchHoleAt = function (x, y) {
        var best = -1, bestD2 = rowRange2, any = 0, anyD2 = Infinity;
        for (var h = 0; h < H; h++) {
            var hole = holes[h];
            var dx = x - hole.cx, dy = y - hole.cy;
            var d2 = dx * dx + dy * dy;
            if (d2 < anyD2) { anyD2 = d2; any = h; }
            if (d2 < bestD2 && dx * (hole.thDirX || 0) + dy * (hole.thDirY || 0) >= 0) { bestD2 = d2; best = h; }
        }
        return best >= 0 ? best : any;
    };
    var launchHole = new Int32Array(N);
    var world = new Float64Array(N * 3), launchTime = new Float64Array(N);
    for (var i = 0; i < N; i++) {
        var x = S.ox[i] + origin.x, y = S.oy[i] + origin.y, z = S.oz[i] + origin.z;
        world[i * 3] = x; world[i * 3 + 1] = y; world[i * 3 + 2] = z;
        launchHole[i] = launchHoleAt(x, y);
        launchTime[i] = holes[launchHole[i]].fireT;
    }
    var grid;
    if (S.rockCells) {
        // Merged blocks: the rock is every cell from before the merge, not the blocks left after it.
        var cells = S.rockCells.ox.length;
        var cellWorld = new Float64Array(cells * 3), cellTime = new Float64Array(cells);
        for (var c = 0; c < cells; c++) {
            var cx = S.rockCells.ox[c] + origin.x, cy = S.rockCells.oy[c] + origin.y;
            cellWorld[c * 3] = cx; cellWorld[c * 3 + 1] = cy; cellWorld[c * 3 + 2] = S.rockCells.oz[c] + origin.z;
            cellTime[c] = holes[launchHoleAt(cx, cy)].fireT;
        }
        grid = buildRockGrid(cellWorld, cellTime, res);
    } else {
        grid = buildRockGrid(world, launchTime, res);
    }

    var vMax = 0, capped = 0, nearCharge = 0, confinedH = 0, delaySum = 0, tally = { clipped: 0 };
    for (var b = 0; b < N; b++) {
        var hi = launchHole[b], hd = holes[hi];
        if (!rowSegments[hi]) rowSegments[hi] = rowChargeSegments(hi, holes, segmentsOf, windowS, rowDepth, rowRange2);
        var bx = world[b * 3], by = world[b * 3 + 1], bz = world[b * 3 + 2];
        tally.clipped = 0;
        var v = chargeVelocity1990(bx, by, bz, rowSegments[hi], velocityParams, tally);
        if (tally.clipped > 0) nearCharge++;

        // Firing direction, or the block's own horizontal velocity when timing is flat.
        var nx = hd.thDirX || 0, ny = hd.thDirY || 0;
        var directed = nx !== 0 || ny !== 0;
        if (!directed) {
            var flat = Math.sqrt(v.x * v.x + v.y * v.y);
            nx = flat > 0 ? v.x / flat : 1; ny = flat > 0 ? v.y / flat : 0;
        }
        var rx = -ny, ry = nx;
        var vh = v.x * nx + v.y * ny, vr = v.x * rx + v.y * ry;
        var movedBefore = hd.fireT - movedLag;

        var dh = vh < 0 ? Infinity : freeDistance(grid, bx, by, bz, nx, ny, 0, movedBefore, true);
        var side = vr < 0 ? -1 : 1;
        var dr = freeDistance(grid, bx, by, bz, rx * side, ry * side, 0, movedBefore, p.sideFreeFace === true);
        var dv = freeDistance(grid, bx, by, bz, 0, 0, 1, -Infinity, true);

        var delay = delayFactor(p.Pd, rows.rowsInFront[hi], Td);
        var hOut = vh * confinementFactor(dh, p.C1) * delay;
        var rOut = vr * confinementFactor(dr, p.C1);
        var vx = hOut * nx + rOut * rx, vy = hOut * ny + rOut * ry, vz = v.z * confinementFactor(dv, p.C1);
        if (dh === Infinity) confinedH++;
        delaySum += delay;

        var speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (p.maxLaunchSpeed > 0 && speed > p.maxLaunchSpeed) {
            var f = p.maxLaunchSpeed / speed;
            vx *= f; vy *= f; vz *= f; speed = p.maxLaunchSpeed; capped++;
        }
        S.ivx[b] = vx; S.ivy[b] = vy; S.ivz[b] = vz;
        S.at[b] = hd.fireT;
        if (speed > vMax) vMax = speed;
    }
    var maxRows = 0;
    for (var m = 0; m < H; m++) if (rows.rowsInFront[m] > maxRows) maxRows = rows.rowsInFront[m];
    S.launchDiag = {
        model: "yang1990", calibration: "uncalibrated unless PeAnfo, Pr and Pd were fitted to this site by Eq 20",
        PeAnfo: p.PeAnfo, Pr: p.Pr, Pd: p.Pd, C1: p.C1,
        rMinM: rMin, delayS: Td, maxRowsInFront: maxRows,
        nearChargeShare: nearCharge / N, confinedHorizontalShare: confinedH / N,
        meanDelayFactor: delaySum / N, cappedShare: capped / N
    };
    return vMax;
}

/** The charges in hole hi's row: Eq 12-14's "all relevant charges". */
function rowChargeSegments(hi, holes, segmentsOf, windowS, rowDepth, rowRange2) {
    var hd = holes[hi], out = [];
    for (var j = 0; j < holes.length; j++) {
        var other = holes[j];
        if (Math.abs(other.fireT - hd.fireT) > windowS) continue;
        var dx = other.cx - hd.cx, dy = other.cy - hd.cy;
        if (dx * dx + dy * dy > rowRange2) continue;
        if (Math.abs(dx * (hd.thDirX || 0) + dy * (hd.thDirY || 0)) > rowDepth) continue;
        for (var s = 0; s < segmentsOf[j].length; s++) out.push(segmentsOf[j][s]);
    }
    return out;
}

/**
 * Energy-partition depth-zone launch velocities (alternative model).
 *
 * @param {Object} S       - particle state: N, ox,oy,oz, nearH, nearD, ivx,ivy,ivz, at
 * @param {{x,y,z}} origin
 * @param {Array}  holes   - sim holes (mass, burden, spacing, benchHeight, gradeZ, stemLen, thDir)
 * @param {Object} [params] - ENERGY_DEFAULTS overrides
 * @param {() => number} [rng]
 * @returns {number} v0Max
 */
export function assignEnergyPartitionVelocities(S, origin, holes, params, rng) {
    var p = Object.assign({}, ENERGY_DEFAULTS, params || {});
    var rand = rng || Math.random;
    var N = S.N;
    if (!holes.length || !N) return 0;
    var eJ = p.energyKJkg * 1000;
    var medS = 0, cnt = 0;
    for (var h0 = 0; h0 < holes.length; h0++) if (holes[h0].spacing > 0) { medS += holes[h0].spacing; cnt++; }
    medS = cnt ? medS / cnt : 5;

    var v0Max = 0;
    for (var hi = 0; hi < holes.length; hi++) {
        var h = holes[hi];
        var B = h.burden > 0 ? h.burden : medS;
        var Sp = h.spacing > 0 ? h.spacing : medS;
        var BH = h.benchHeight > 0 ? h.benchHeight : (h.gradeZ != null ? Math.max(1, h.cz - h.gradeZ) : 10);
        if (h.mass > 0) {
            var pf = h.mass / (B * Sp * BH);
            h.v0 = Math.min(p.maxSpeed, Math.sqrt(2 * p.efficiency * eJ * pf / p.rockDensity));
            h.pf = pf;
        } else { h.v0 = p.fallbackVelocity; h.pf = 0; }
        h.chargeTopZ = (h.stemLen > 0) ? h.cz - h.stemLen : null;
        h.spacingEff = Sp;
        if (h.v0 > v0Max) v0Max = h.v0;
    }

    for (var i = 0; i < N; i++) {
        var idx = S.nearH[i];
        if (idx < 0) continue;
        var hh = holes[idx];
        var wx = S.ox[i] + origin.x, wy = S.oy[i] + origin.y, wz = S.oz[i] + origin.z;
        var rdx = wx - hh.cx, rdy = wy - hh.cy;
        var rL = Math.sqrt(rdx * rdx + rdy * rdy);
        if (rL > 0.01) { rdx /= rL; rdy /= rL; } else { rdx = 1; rdy = 0; }
        var dX, dY;
        if (hh.thDirX !== 0 || hh.thDirY !== 0) {
            dX = hh.thDirX * 0.8 + rdx * 0.2; dY = hh.thDirY * 0.8 + rdy * 0.2;
            var dL = Math.sqrt(dX * dX + dY * dY) || 1; dX /= dL; dY /= dL;
        } else { dX = rdx; dY = rdy; }
        var f = 1 - 0.3 * Math.min(S.nearD[i] / hh.spacingEff, 1);
        var vertR = p.verticalRatio;
        if (hh.chargeTopZ != null && wz > hh.chargeTopZ) { f *= 0.55; vertR = Math.max(vertR, 0.5); }
        else if (hh.gradeZ != null && wz < hh.gradeZ) { f *= 0.5; vertR = vertR * 0.5; }
        var vm = hh.v0 * f;
        S.ivx[i] = dX * vm * (0.9 + rand() * 0.2);
        S.ivy[i] = dY * vm * (0.9 + rand() * 0.2);
        S.ivz[i] = vm * vertR * (0.6 + rand() * 0.8);
        S.at[i] = hh.fireT;
    }
    return v0Max || p.fallbackVelocity;
}

/**
 * Displacement.js — Results extraction for the blast movement simulator
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 *   displacementVectors(S, origin)      — per-block in-situ → final vectors (world coords)
 *   centreOfMassShift(S)                — volume-weighted horizontal CoM shift (m, bearing)
 *   swellPrescribed(S) / swellEmergent(S) — achieved bulk swell factors
 *   swellBulk(S)                        — measured bulk of the pile vs in-situ rock
 *   muckpileHeightfield(S, origin, cell)— settled pile top-of-block raster + surface object
 *   surveyTargets(surfaces)             — swell + CoM throw from PREBLAST_VOLUME / SHELL / POSTBLAST meshes
 *
 * Ported from the Kirra blast-throw simulator (STEP 20 back-calculation).
 */

import { ST_INACTIVE, ST_REST } from "./SphereDEM.js";
import { calibrationGrid, rasterTop, columnThickness, surfaceFromHeightfield } from "./SurfaceMesh.js";

/**
 * Per-block displacement vectors in world coordinates.
 * @param {Object} S      - particle state
 * @param {{x,y,z}} origin
 * @param {Object} [opts] - { firedOnly=true }
 * @returns {{ count, index: Int32Array, x0,y0,z0, x1,y1,z1, dx,dy,dz, dist }} Float64Arrays
 */
export function displacementVectors(S, origin, opts) {
    opts = opts || {};
    var firedOnly = opts.firedOnly !== false;
    var idx = [];
    for (var i = 0; i < S.N; i++) if (!firedOnly || S.state[i] !== ST_INACTIVE) idx.push(i);
    var n = idx.length;
    var out = {
        count: n, index: Int32Array.from(idx),
        x0: new Float64Array(n), y0: new Float64Array(n), z0: new Float64Array(n),
        x1: new Float64Array(n), y1: new Float64Array(n), z1: new Float64Array(n),
        dx: new Float64Array(n), dy: new Float64Array(n), dz: new Float64Array(n),
        dist: new Float64Array(n)
    };
    for (var k = 0; k < n; k++) {
        var i2 = idx[k];
        out.x0[k] = S.ox[i2] + origin.x; out.y0[k] = S.oy[i2] + origin.y; out.z0[k] = S.oz[i2] + origin.z;
        out.x1[k] = S.px[i2] + origin.x; out.y1[k] = S.py[i2] + origin.y; out.z1[k] = S.pz[i2] + origin.z;
        out.dx[k] = S.px[i2] - S.ox[i2]; out.dy[k] = S.py[i2] - S.oy[i2]; out.dz[k] = S.pz[i2] - S.oz[i2];
        out.dist[k] = Math.sqrt(out.dx[k] * out.dx[k] + out.dy[k] * out.dy[k] + out.dz[k] * out.dz[k]);
    }
    return out;
}

/**
 * Volume-weighted (∝ r³) horizontal centre-of-mass shift of fired blocks.
 * @param {Object} S
 * @returns {{ D: number, dx: number, dy: number, bearing: number, count: number }} bearing: 0=N clockwise
 */
export function centreOfMassShift(S) {
    var sx = 0, sy = 0, sw = 0, n = 0;
    for (var i = 0; i < S.N; i++) {
        if (S.state[i] === ST_INACTIVE) continue;
        var w = S.baseRad[i] * S.baseRad[i] * S.baseRad[i];
        sx += w * (S.px[i] - S.ox[i]); sy += w * (S.py[i] - S.oy[i]); sw += w; n++;
    }
    var dx = sw > 0 ? sx / sw : 0, dy = sw > 0 ? sy / sw : 0;
    return { D: Math.hypot(dx, dy), dx: dx, dy: dy, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, count: n };
}

/**
 * Prescribed swell actually reached: Σ rad³ / Σ baseRad³ over fired blocks.
 * @param {Object} S
 * @returns {number}
 */
export function swellPrescribed(S) {
    var vSum = 0, vBase = 0;
    for (var i = 0; i < S.N; i++) {
        if (S.state[i] === ST_INACTIVE) continue;
        vSum += S.rad[i] * S.rad[i] * S.rad[i];
        vBase += S.baseRad[i] * S.baseRad[i] * S.baseRad[i];
    }
    return vBase > 0 ? vSum / vBase : 1;
}

/**
 * Emergent swell: settled bulk volume (occupied 2 m columns × height span)
 * vs packed in-situ volume of fired blocks.
 * @param {Object} S
 * @param {number} [cell=2]
 * @returns {number|null}
 */
export function swellEmergent(S, cell) {
    if (!S.N) return null;
    cell = cell > 0 ? cell : 2.0;
    var occ = new Map();
    var insituV = 0;
    for (var i = 0; i < S.N; i++) {
        if (S.state[i] === ST_INACTIVE) continue;
        // One voxel of rock per cell a block holds; baseR is 0.47 of the voxel edge.
        var voxel = S.baseR / 0.47;
        insituV += voxel * voxel * voxel * (S.cells ? S.cells[i] : 1);
        var k = Math.floor(S.px[i] / cell) + "|" + Math.floor(S.py[i] / cell);
        var e = occ.get(k);
        if (!e) occ.set(k, { lo: S.pz[i], hi: S.pz[i] });
        else { if (S.pz[i] < e.lo) e.lo = S.pz[i]; if (S.pz[i] > e.hi) e.hi = S.pz[i]; }
    }
    var bulkV = 0;
    occ.forEach(function (e) { bulkV += (e.hi - e.lo + 2 * S.baseR) * cell * cell; });
    return insituV > 0 ? bulkV / insituV : null;
}

/**
 * Visit every grid column whose centre lies under a sphere, skipping any off the grid.
 * @param {number} x - sphere centre, in the grid's coordinates
 * @param {number} y
 * @param {number} r - sphere radius
 * @param {{gx0, gy0, cell, nx, ny}} G
 * @param {function(number, number)} visit - (column index, half the sphere's height over that centre)
 */
export function sphereColumns(x, y, r, G, visit) {
    var cell = G.cell;
    var i0 = Math.max(0, Math.floor((x - r - G.gx0) / cell)), i1 = Math.min(G.nx - 1, Math.floor((x + r - G.gx0) / cell));
    var j0 = Math.max(0, Math.floor((y - r - G.gy0) / cell)), j1 = Math.min(G.ny - 1, Math.floor((y + r - G.gy0) / cell));
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
        var ex = G.gx0 + (i + 0.5) * cell - x, ey = G.gy0 + (j + 0.5) * cell - y, h2 = r * r - ex * ex - ey * ey;
        if (h2 < 0) continue;
        visit(j * G.nx + i, Math.sqrt(h2));
    }
}

/**
 * Measured bulk swell: the volume between the top of the fired spheres and the floor
 * under them, column by column, against the in-situ rock they came from. Each sphere
 * is drawn at its true size, so it reads the same whether or not blocks outsize a cell.
 * @param {Object} S
 * @param {Object} [opts]
 *   cell=1: column size (m)
 *   floorAt(x, y): floor height in local coords. Taken as the base where it lies within
 *     one block's size under the lowest sphere; otherwise the sphere's underside is.
 *   insituM3: in-situ rock of all N blocks. Default: one voxel per block.
 *   restedOnly: measure only blocks at rest, against the rock those blocks hold. A block in
 *     the air would otherwise read as a column of bulk down to the pile under it. In a run
 *     stopped early this is the part that has landed, not the whole pile.
 * @returns {number|null} null when no block is counted
 */
export function swellBulk(S, opts) {
    if (!S.N) return null;
    opts = opts || {};
    var cell = opts.cell > 0 ? opts.cell : 1.0;
    var counted = opts.restedOnly
        ? function (n) { return S.state[n] === ST_REST; }
        : function (n) { return S.state[n] !== ST_INACTIVE; };
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity, fired = 0, largest = 0;
    for (var i = 0; i < S.N; i++) {
        if (!counted(i)) continue;
        fired += S.cells ? S.cells[i] : 1;
        var r = S.rad[i];
        if (r > largest) largest = r;
        if (S.px[i] - r < mnX) mnX = S.px[i] - r; if (S.px[i] + r > mxX) mxX = S.px[i] + r;
        if (S.py[i] - r < mnY) mnY = S.py[i] - r; if (S.py[i] + r > mxY) mxY = S.py[i] + r;
    }
    if (!fired) return null;
    var nx = Math.ceil((mxX - mnX) / cell) + 1, ny = Math.ceil((mxY - mnY) / cell) + 1;
    var hi = new Float64Array(nx * ny).fill(-Infinity), lo = new Float64Array(nx * ny).fill(Infinity);
    var G = { gx0: mnX, gy0: mnY, cell: cell, nx: nx, ny: ny }, z;
    var widen = function (q, h) {
        if (z + h > hi[q]) hi[q] = z + h;
        if (z - h < lo[q]) lo[q] = z - h;
    };
    for (var k = 0; k < S.N; k++) {
        if (!counted(k)) continue;
        z = S.pz[k];
        sphereColumns(S.px[k], S.py[k], S.rad[k], G, widen);
    }
    var bulk = 0;
    for (var bb = 0; bb < ny; bb++) for (var aa = 0; aa < nx; aa++) {
        var c = bb * nx + aa;
        if (!(hi[c] > lo[c])) continue;
        var base = lo[c];
        if (opts.floorAt) {
            var f = opts.floorAt(mnX + (aa + 0.5) * cell, mnY + (bb + 0.5) * cell);
            if (f < base && base - f < 2 * largest) base = f;
        }
        bulk += hi[c] - base;
    }
    var voxel = S.baseR / 0.47;
    var insitu = opts.insituM3 > 0 ? opts.insituM3 * fired / (S.cellsTotal || S.N) : fired * voxel * voxel * voxel;
    return bulk * cell * cell / insitu;
}

/**
 * Raster of the settled pile: highest block top per column (world coords).
 * @param {Object} S
 * @param {{x,y,z}} origin
 * @param {number} [cell=2]
 * @param {Object} [opts] - { pad=10, name='POSTBLAST_SIM', firedOnly=true, spheres=false }
 *   spheres: draw each sphere at its true size over every column centre it covers, so
 *   blocks larger than a cell leave no holes. The default bins centres only.
 * @returns {{ grid: {gx0,gy0,cell,nx,ny}, z: Float64Array, surface: Object|null }}
 */
export function muckpileHeightfield(S, origin, cell, opts) {
    opts = opts || {};
    cell = cell > 0 ? cell : 2;
    var pad = opts.pad != null ? opts.pad : 10;
    var firedOnly = opts.firedOnly !== false;
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (var i = 0; i < S.N; i++) {
        if (firedOnly && S.state[i] === ST_INACTIVE) continue;
        var x = S.px[i] + origin.x, y = S.py[i] + origin.y;
        if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    }
    if (mnX === Infinity) return { grid: null, z: new Float64Array(0), surface: null };
    var G = { gx0: mnX - pad, gy0: mnY - pad, cell: cell, nx: Math.ceil((mxX - mnX + 2 * pad) / cell) + 1, ny: Math.ceil((mxY - mnY + 2 * pad) / cell) + 1 };
    var z = new Float64Array(G.nx * G.ny).fill(-1e9), zc;
    var raiseToCap = function (q, h) { if (zc + h > z[q]) z[q] = zc + h; };
    for (var k = 0; k < S.N; k++) {
        if (firedOnly && S.state[k] === ST_INACTIVE) continue;
        var wx = S.px[k] + origin.x, wy = S.py[k] + origin.y, top = S.pz[k] + origin.z + S.rad[k];
        if (opts.spheres) {
            zc = S.pz[k] + origin.z;
            sphereColumns(wx, wy, S.rad[k], G, raiseToCap);
            continue;
        }
        var ci = Math.floor((wx - G.gx0) / cell), cj = Math.floor((wy - G.gy0) / cell);
        if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.ny) continue;
        var q = cj * G.nx + ci;
        if (top > z[q]) z[q] = top;
    }
    var surface = surfaceFromHeightfield(z, G, { name: opts.name || "POSTBLAST_SIM", nodata: -1e8 });
    return { grid: G, z: z, surface: surface };
}

/**
 * Survey targets for calibration: swell and CoM throw from meshes.
 * Needs volumes (role 'voxelblk'), a base (role 'shell' or 'shelltopo') and a
 * reference (role 'reference' — the surveyed post-blast muckpile).
 *
 * @param {Array} surfaces
 * @param {Object} [opts] - { pad=40, cell=2, minDepth=0.3 }
 * @returns {{ swell, insituVol, muckVol, D, dx, dy, bearing }|{ err: string }}
 */
export function surveyTargets(surfaces, opts) {
    opts = opts || {};
    var refs = surfaces.filter(function (x) { return x.role === "reference"; });
    var vols = surfaces.filter(function (x) { return x.role === "voxelblk"; });
    var bases = surfaces.filter(function (x) { return x.role === "shell" || x.role === "shelltopo"; });
    if (!refs.length) return { err: "No POSTBLAST reference surface." };
    if (!vols.length) return { err: "No blast volume surface (PREBLAST_VOLUME / VOXEL-BLK*)." };
    var G = calibrationGrid(vols, opts.pad != null ? opts.pad : 40, opts.cell > 0 ? opts.cell : 2);
    var zPost = rasterTop(refs, G);
    var zPre = bases.length ? rasterTop(bases, G) : null;
    var VC = columnThickness(vols, G);
    var minDepth = opts.minDepth != null ? opts.minDepth : 0.3;
    var insitu = 0, muck = 0, vX = 0, vY = 0, mX = 0, mY = 0;
    for (var j = 0; j < G.ny; j++) for (var i = 0; i < G.nx; i++) {
        var q = j * G.nx + i;
        var x = G.gx0 + (i + 0.5) * G.cell, y = G.gy0 + (j + 0.5) * G.cell;
        if (VC.thick[q] > 0) { insitu += VC.thick[q]; vX += VC.thick[q] * x; vY += VC.thick[q] * y; }
        if (zPost[q] > -1e8) {
            var base = VC.thick[q] > 0 ? VC.zbot[q] : (zPre && zPre[q] > -1e8 ? zPre[q] : null);
            if (base !== null) {
                var d = zPost[q] - base;
                if (d > minDepth) { muck += d; mX += d * x; mY += d * y; }
            }
        }
    }
    if (insitu <= 0 || muck <= 0) return { err: "Column rasterisation found no overlap." };
    var dx = mX / muck - vX / insitu, dy = mY / muck - vY / insitu;
    var A = G.cell * G.cell;
    return { swell: muck / insitu, insituVol: insitu * A, muckVol: muck * A, D: Math.hypot(dx, dy), dx: dx, dy: dy,
             bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, grid: G };
}

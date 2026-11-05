/**
 * ShellCollider.js — Static triangle-mesh collision for the sphere DEM
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * The confinement geometry (trusted SHELL / remaining-ground surface, or the
 * pre-blast topography as a fallback) is packed into an XY-binned triangle
 * table with precomputed normals. Each active block is tested against the
 * triangles in its column and pushed back to the side it came from.
 *
 * Lid exclusion: when only a pre-blast topo is available, the triangles whose
 * centroid sits over the voxelised blast volume (plus one 2 m ring for the
 * free face) ARE the material being blasted and must not cap the heave.
 *
 * Ported from the Kirra blast-throw simulator (buildShellBin / shellCollide).
 */

export var OCC_CELL = 2.0;

/**
 * Column key for the lid-exclusion occupancy set.
 * @param {number} x @param {number} y
 * @returns {string}
 */
export function occKey(x, y) {
    return Math.floor(x / OCC_CELL) + "|" + Math.floor(y / OCC_CELL);
}

/**
 * Occupancy keys of a voxel position set (local coords), dilated by `ring` cells.
 * @param {Float32Array|Float64Array} positions - xyz triples (local)
 * @param {number} [ring=1]
 * @returns {Set<string>}
 */
export function lidExclusionKeys(positions, ring) {
    ring = ring != null ? ring : 1;
    var occ = new Set();
    for (var i = 0; i < positions.length; i += 3) occ.add(occKey(positions[i], positions[i + 1]));
    if (ring <= 0) return occ;
    var dil = new Set(occ);
    occ.forEach(function (k) {
        var parts = k.split("|");
        var ix = +parts[0], iy = +parts[1];
        for (var a = -ring; a <= ring; a++) for (var b = -ring; b <= ring; b++) dil.add((ix + a) + "|" + (iy + b));
    });
    return dil;
}

/**
 * Build the binned shell collider.
 *
 * @param {Float32Array|number[]} flat - triangle soup, 9 floats per tri (local coords)
 * @param {Set<string>|null} [excludeKeys] - occupancy keys to strip (lid exclusion)
 * @param {number} [cell=3] - bin size (m)
 * @returns {{ ready, nt, tris: Float32Array, cell, minX, minY, nx, ny, cellStart: Int32Array, triIdx: Int32Array, excluded }}
 */
export function buildShellBin(flat, excludeKeys, cell) {
    var src = flat || [];
    var excluded = 0;
    if (excludeKeys && excludeKeys.size && src.length) {
        var kept = [];
        for (var t = 0; t < src.length / 9; t++) {
            var o = t * 9;
            var cx = (src[o] + src[o + 3] + src[o + 6]) / 3;
            var cy = (src[o + 1] + src[o + 4] + src[o + 7]) / 3;
            if (excludeKeys.has(occKey(cx, cy))) { excluded++; continue; }
            for (var k = 0; k < 9; k++) kept.push(src[o + k]);
        }
        src = kept;
    }
    var nt = src.length / 9;
    var SB = { ready: false, nt: nt, tris: null, cell: cell > 0 ? cell : 3.0, minX: 0, minY: 0, nx: 1, ny: 1, cellStart: null, triIdx: null, excluded: excluded };
    if (!nt) return SB;

    SB.tris = new Float32Array(nt * 12);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nt; i++) {
        var q = i * 12, s = i * 9;
        var ax = src[s], ay = src[s + 1], az = src[s + 2];
        var bx = src[s + 3], by = src[s + 4], bz = src[s + 5];
        var cx2 = src[s + 6], cy2 = src[s + 7], cz2 = src[s + 8];
        SB.tris[q] = ax; SB.tris[q + 1] = ay; SB.tris[q + 2] = az;
        SB.tris[q + 3] = bx; SB.tris[q + 4] = by; SB.tris[q + 5] = bz;
        SB.tris[q + 6] = cx2; SB.tris[q + 7] = cy2; SB.tris[q + 8] = cz2;
        var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        var e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
        var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        SB.tris[q + 9] = nx / nl; SB.tris[q + 10] = ny / nl; SB.tris[q + 11] = nz / nl;
        minX = Math.min(minX, ax, bx, cx2); maxX = Math.max(maxX, ax, bx, cx2);
        minY = Math.min(minY, ay, by, cy2); maxY = Math.max(maxY, ay, by, cy2);
    }
    SB.minX = minX - SB.cell; SB.minY = minY - SB.cell;
    SB.nx = Math.max(1, Math.ceil((maxX - minX + 2 * SB.cell) / SB.cell));
    SB.ny = Math.max(1, Math.ceil((maxY - minY + 2 * SB.cell) / SB.cell));
    var nCells = SB.nx * SB.ny;
    var counts = new Int32Array(nCells + 1);
    var spanOf = function (t) {
        var q = t * 12;
        var x0 = Math.min(SB.tris[q], SB.tris[q + 3], SB.tris[q + 6]), x1 = Math.max(SB.tris[q], SB.tris[q + 3], SB.tris[q + 6]);
        var y0 = Math.min(SB.tris[q + 1], SB.tris[q + 4], SB.tris[q + 7]), y1 = Math.max(SB.tris[q + 1], SB.tris[q + 4], SB.tris[q + 7]);
        return [
            Math.max(0, Math.floor((x0 - SB.minX) / SB.cell)), Math.min(SB.nx - 1, Math.floor((x1 - SB.minX) / SB.cell)),
            Math.max(0, Math.floor((y0 - SB.minY) / SB.cell)), Math.min(SB.ny - 1, Math.floor((y1 - SB.minY) / SB.cell))
        ];
    };
    for (var t1 = 0; t1 < nt; t1++) { var s1 = spanOf(t1); for (var i1 = s1[0]; i1 <= s1[1]; i1++) for (var j1 = s1[2]; j1 <= s1[3]; j1++) counts[j1 * SB.nx + i1]++; }
    var sum = 0;
    for (var c = 0; c < nCells; c++) { sum += counts[c]; counts[c] = sum; }
    counts[nCells] = sum;
    SB.triIdx = new Int32Array(sum);
    for (var t2 = 0; t2 < nt; t2++) { var s2 = spanOf(t2); for (var i2 = s2[0]; i2 <= s2[1]; i2++) for (var j2 = s2[2]; j2 <= s2[3]; j2++) { var cc = j2 * SB.nx + i2; counts[cc]--; SB.triIdx[counts[cc]] = t2; } }
    SB.cellStart = counts;
    // Height span of each bin, so a block well above the floor skips its triangles.
    SB.binZMin = new Float32Array(nCells).fill(Infinity);
    SB.binZMax = new Float32Array(nCells).fill(-Infinity);
    for (var cz0 = 0; cz0 < nCells; cz0++) for (var e = counts[cz0]; e < counts[cz0 + 1]; e++) {
        var q2 = SB.triIdx[e] * 12;
        var lo = Math.min(SB.tris[q2 + 2], SB.tris[q2 + 5], SB.tris[q2 + 8]), hi = Math.max(SB.tris[q2 + 2], SB.tris[q2 + 5], SB.tris[q2 + 8]);
        if (lo < SB.binZMin[cz0]) SB.binZMin[cz0] = lo;
        if (hi > SB.binZMax[cz0]) SB.binZMax[cz0] = hi;
    }
    SB.ready = true;
    return SB;
}

/**
 * Collide block i (sphere radius r) against the shell. Mutates position /
 * velocity arrays in `S` (px,py,pz,vx,vy,vz).
 *
 * @param {Object} SB   - from buildShellBin
 * @param {Object} S    - particle state with px,py,pz,vx,vy,vz typed arrays
 * @param {number} i
 * @param {number} rest - restitution
 * @param {number} fric - friction
 * @param {number} r    - block radius
 * @returns {boolean} true when a contact occurred
 */
export function shellCollide(SB, S, i, rest, fric, r) {
    if (!SB || !SB.ready) return false;
    var px = S.px[i], py = S.py[i], pz = S.pz[i];
    var ci = Math.floor((px - SB.minX) / SB.cell);
    var cj = Math.floor((py - SB.minY) / SB.cell);
    if (ci < 0 || ci >= SB.nx || cj < 0 || cj >= SB.ny) return false;
    var c = cj * SB.nx + ci;
    var s0 = SB.cellStart[c], s1 = SB.cellStart[c + 1];
    var hit = false;
    var tris = SB.tris;
    for (var k = s0; k < s1; k++) {
        var q = SB.triIdx[k] * 12;
        var ax = tris[q], ay = tris[q + 1], az = tris[q + 2];
        var nx = tris[q + 9], ny = tris[q + 10], nz = tris[q + 11];
        var pd = (px - ax) * nx + (py - ay) * ny + (pz - az) * nz;
        if (pd > r || pd < -r * 3) continue;
        var bx = tris[q + 3], by = tris[q + 4], bz = tris[q + 5];
        var cx = tris[q + 6], cy = tris[q + 7], cz = tris[q + 8];
        var qx = px - pd * nx, qy = py - pd * ny, qz = pz - pd * nz;
        var v0x = cx - ax, v0y = cy - ay, v0z = cz - az;
        var v1x = bx - ax, v1y = by - ay, v1z = bz - az;
        var v2x = qx - ax, v2y = qy - ay, v2z = qz - az;
        var d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z;
        var d02 = v0x * v2x + v0y * v2y + v0z * v2z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
        var d12 = v1x * v2x + v1y * v2y + v1z * v2z;
        var denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-12) continue;
        var inv = 1 / denom;
        var u = (d11 * d02 - d01 * d12) * inv;
        var v = (d00 * d12 - d01 * d02) * inv;
        if (u < -0.02 || v < -0.02 || u + v > 1.02) continue;

        var sgn = pd >= 0 ? 1 : -1;
        var pen = r - pd * sgn;
        if (pen > 0) {
            // Push to the side of the surface the block came from. Plane
            // tests keep using the pre-push position (matches the reference
            // simulator; multiple tris in one column each contribute).
            S.px[i] += nx * sgn * pen; S.py[i] += ny * sgn * pen; S.pz[i] += nz * sgn * pen;
            var vn = S.vx[i] * nx * sgn + S.vy[i] * ny * sgn + S.vz[i] * nz * sgn;
            if (vn < 0) {
                S.vx[i] -= (1 + rest) * vn * nx * sgn;
                S.vy[i] -= (1 + rest) * vn * ny * sgn;
                S.vz[i] -= (1 + rest) * vn * nz * sgn;
                var tf = 1 - fric * 0.3;
                S.vx[i] *= tf; S.vy[i] *= tf;
            }
            hit = true;
        }
    }
    return hit;
}

/**
 * Highest shell surface directly above or below a point.
 * @param {Object} SB - from buildShellBin
 * @param {number} x @param {number} y
 * @returns {number} world-local Z, or -Infinity where the shell doesn't reach
 */
export function shellHeightAt(SB, x, y) {
    if (!SB || !SB.ready) return -Infinity;
    var ci = Math.floor((x - SB.minX) / SB.cell), cj = Math.floor((y - SB.minY) / SB.cell);
    if (ci < 0 || ci >= SB.nx || cj < 0 || cj >= SB.ny) return -Infinity;
    var c = cj * SB.nx + ci, top = -Infinity, tris = SB.tris;
    for (var k = SB.cellStart[c], end = SB.cellStart[c + 1]; k < end; k++) {
        var q = SB.triIdx[k] * 12;
        var ax = tris[q], ay = tris[q + 1], bx = tris[q + 3], by = tris[q + 4], cx = tris[q + 6], cy = tris[q + 7];
        var det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(det) < 1e-12) continue;
        var u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / det, v = ((y - ay) * (bx - ax) - (x - ax) * (by - ay)) / det;
        if (u < -0.001 || v < -0.001 || u + v > 1.001) continue;
        var z = tris[q + 2] + u * (tris[q + 5] - tris[q + 2]) + v * (tris[q + 8] - tris[q + 2]);
        if (z > top) top = z;
    }
    return top;
}

/**
 * The one shell contact of a sphere: the closest point on any triangle near it.
 * True sphere-to-triangle distance (Ericson 2005, Real-Time Collision Detection,
 * section 5.1.5; SECONDARY, from memory), so the answer doesn't depend on how the
 * same surface is meshed, and edges and corners act like the faces beside them.
 *
 * @param {Object} SB - from buildShellBin
 * @param {number} px @param {number} py @param {number} pz - sphere centre
 * @param {number} reach - distance to look (radius + contact margin)
 * @param {Float64Array} out - [dist, nx, ny, nz]: normal runs from the surface to the centre
 * @returns {boolean} true when a surface point lies within reach
 */
export function shellClosest(SB, px, py, pz, reach, out) {
    if (!SB || !SB.ready) return false;
    var i0 = Math.max(0, Math.floor((px - reach - SB.minX) / SB.cell)), i1 = Math.min(SB.nx - 1, Math.floor((px + reach - SB.minX) / SB.cell));
    var j0 = Math.max(0, Math.floor((py - reach - SB.minY) / SB.cell)), j1 = Math.min(SB.ny - 1, Math.floor((py + reach - SB.minY) / SB.cell));
    var best2 = reach * reach, found = false, tris = SB.tris;
    var bx0 = 0, by0 = 0, bz0 = 0;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
        var c = j * SB.nx + i;
        if (pz - reach > SB.binZMax[c] || pz + reach < SB.binZMin[c]) continue;
        for (var k = SB.cellStart[c], end = SB.cellStart[c + 1]; k < end; k++) {
            var q = SB.triIdx[k] * 12;
            var ax = tris[q], ay = tris[q + 1], az = tris[q + 2];
            var pd = (px - ax) * tris[q + 9] + (py - ay) * tris[q + 10] + (pz - az) * tris[q + 11];
            if (pd * pd >= best2) continue;
            var abx = tris[q + 3] - ax, aby = tris[q + 4] - ay, abz = tris[q + 5] - az;
            var acx = tris[q + 6] - ax, acy = tris[q + 7] - ay, acz = tris[q + 8] - az;
            var apx = px - ax, apy = py - ay, apz = pz - az;
            var d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
            var cx, cy, cz;
            if (d1 <= 0 && d2 <= 0) { cx = ax; cy = ay; cz = az; }
            else {
                var bpx = px - tris[q + 3], bpy = py - tris[q + 4], bpz = pz - tris[q + 5];
                var d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
                var vc = d1 * d4 - d3 * d2;
                if (d3 >= 0 && d4 <= d3) { cx = tris[q + 3]; cy = tris[q + 4]; cz = tris[q + 5]; }
                else if (vc <= 0 && d1 >= 0 && d3 <= 0) { var t1 = d1 / (d1 - d3); cx = ax + t1 * abx; cy = ay + t1 * aby; cz = az + t1 * abz; }
                else {
                    var cpx = px - tris[q + 6], cpy = py - tris[q + 7], cpz = pz - tris[q + 8];
                    var d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
                    var vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
                    if (d6 >= 0 && d5 <= d6) { cx = tris[q + 6]; cy = tris[q + 7]; cz = tris[q + 8]; }
                    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { var t2 = d2 / (d2 - d6); cx = ax + t2 * acx; cy = ay + t2 * acy; cz = az + t2 * acz; }
                    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                        var t3 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                        cx = tris[q + 3] + t3 * (tris[q + 6] - tris[q + 3]); cy = tris[q + 4] + t3 * (tris[q + 7] - tris[q + 4]); cz = tris[q + 5] + t3 * (tris[q + 8] - tris[q + 5]);
                    } else {
                        var dn = 1 / (va + vb + vc), vv = vb * dn, ww = vc * dn;
                        cx = ax + abx * vv + acx * ww; cy = ay + aby * vv + acy * ww; cz = az + abz * vv + acz * ww;
                    }
                }
            }
            var ex = px - cx, ey = py - cy, ez = pz - cz, e2 = ex * ex + ey * ey + ez * ez;
            if (e2 < best2) {
                best2 = e2; bx0 = cx; by0 = cy; bz0 = cz; found = true;
                if (e2 < 1e-12) { out[1] = tris[q + 9]; out[2] = tris[q + 10]; out[3] = tris[q + 11]; }
            }
        }
    }
    if (!found) return false;
    var dist = Math.sqrt(best2);
    out[0] = dist;
    if (dist > 1e-6) { out[1] = (px - bx0) / dist; out[2] = (py - by0) / dist; out[3] = (pz - bz0) / dist; }
    return true;
}

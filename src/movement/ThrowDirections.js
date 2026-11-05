/**
 * ThrowDirections.js — Timing-gradient throw directions per hole
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * For each hole, least-squares fit fireT = a + gx·x + gy·y over neighbours
 * within a radius (2.6 × median nearest-neighbour spacing). The throw
 * direction is −∇t: from late-firing toward early-firing ground — i.e. toward
 * the relief that has already fired. Flat timing → zero vector (callers fall
 * back to radial-from-hole).
 *
 * Ported from the Kirra blast-throw simulator (computeThrowDirections).
 */

/**
 * Median-ish nearest-neighbour spacing (mean of nearest distances over the
 * first 100 holes).
 * @param {Array<{cx:number, cy:number}>} holes
 * @returns {number} metres (5 when undeterminable)
 */
export function estimateSpacing(holes) {
    var n = holes.length;
    var minD2Sum = 0, cnt = 0;
    for (var i = 0; i < Math.min(n, 100); i++) {
        var best = Infinity;
        for (var j = 0; j < n; j++) {
            if (i === j) continue;
            var dx = holes[i].cx - holes[j].cx, dy = holes[i].cy - holes[j].cy;
            var d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        if (best < Infinity) { minD2Sum += Math.sqrt(best); cnt++; }
    }
    return cnt ? minD2Sum / cnt : 5;
}

/**
 * Compute per-hole unit throw directions from the timing gradient.
 *
 * @param {Array<{cx:number, cy:number, fireT:number}>} holes - fireT in seconds (or ms — consistent units)
 * @param {Object} [opts]
 * @param {number} [opts.radiusFactor=2.6] - neighbour radius = factor × spacing
 * @param {number} [opts.radius]           - explicit neighbour radius (m), overrides factor
 * @returns {Array<{ thDirX: number, thDirY: number, gx: number, gy: number, neighbours: number }>}
 *   Also writes thDirX/thDirY onto each hole object.
 */
export function computeThrowDirections(holes, opts) {
    opts = opts || {};
    var n = holes.length;
    var out = new Array(n);
    if (!n) return out;
    var R = opts.radius > 0 ? opts.radius : (opts.radiusFactor > 0 ? opts.radiusFactor : 2.6) * estimateSpacing(holes);
    var R2 = R * R;
    for (var i = 0; i < n; i++) {
        var hi = holes[i];
        var sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0, m = 0;
        for (var j = 0; j < n; j++) {
            var dx = holes[j].cx - hi.cx, dy = holes[j].cy - hi.cy;
            var d2 = dx * dx + dy * dy;
            if (d2 > R2) continue;
            var dt = holes[j].fireT - hi.fireT;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
            sxt += dx * dt; syt += dy * dt;
            m++;
        }
        var gx = 0, gy = 0;
        var det = sxx * syy - sxy * sxy;
        if (m >= 3 && Math.abs(det) > 1e-9) {
            gx = (syy * sxt - sxy * syt) / det;
            gy = (sxx * syt - sxy * sxt) / det;
        }
        var gm = Math.sqrt(gx * gx + gy * gy);
        var tx = 0, ty = 0;
        if (gm > 1e-7) { tx = -gx / gm; ty = -gy / gm; }
        hi.thDirX = tx; hi.thDirY = ty;
        out[i] = { thDirX: tx, thDirY: ty, gx: gx, gy: gy, neighbours: m };
    }
    return out;
}

/**
 * Median nearest-neighbour distance over all holes. Unlike estimateSpacing it isn't
 * pulled down when the first holes listed are closely spaced trim holes.
 * @param {Array<{cx:number, cy:number}>} holes
 * @returns {number} metres (5 when undeterminable)
 */
export function medianSpacing(holes) {
    var nearest = [];
    for (var i = 0; i < holes.length; i++) {
        var best = Infinity;
        for (var j = 0; j < holes.length; j++) {
            if (i === j) continue;
            var dx = holes[i].cx - holes[j].cx, dy = holes[i].cy - holes[j].cy;
            var d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        if (best < Infinity) nearest.push(Math.sqrt(best));
    }
    nearest.sort(function (a, b) { return a - b; });
    return nearest.length ? nearest[nearest.length >> 1] : 5;
}

/**
 * Firing rows from fire time, for Yang & Kavetsky (1990) Eq 18. The paper defines
 * rows by hand ("holes detonated within a small time period and spaced within a certain
 * distance") and says so as a limitation (their journal p. 33). This is our automation
 * (judgement), not theirs: from each hole, step to the nearest earlier-firing hole that
 * lies at least half a row spacing ahead along its firing direction. The number of steps
 * to the front is n, "the number of rows in front"; the median step time is Td, which
 * the paper treats as one value per blast.
 *
 * Needs thDirX/thDirY from computeThrowDirections. A hole with flat timing has no
 * direction, so nothing counts as in front of it.
 *
 * @param {Array<{cx:number, cy:number, fireT:number, thDirX:number, thDirY:number}>} holes
 * @param {Object} [opts]
 * @param {number} [opts.spacing]         - row spacing (m); default medianSpacing
 * @param {number} [opts.reachFactor=3]   - furthest next row, in spacings (judgement)
 * @returns {{ rowsInFront: Int32Array, delayS: (number|null), spacing: number }}
 */
export function firingRows(holes, opts) {
    opts = opts || {};
    var n = holes.length;
    var spacing = opts.spacing > 0 ? opts.spacing : medianSpacing(holes);
    var rowDepth = 0.5 * spacing;
    var reach = (opts.reachFactor > 0 ? opts.reachFactor : 3) * spacing;
    var order = [];
    for (var o = 0; o < n; o++) order.push(o);
    order.sort(function (a, b) { return holes[a].fireT - holes[b].fireT; });
    var rowsInFront = new Int32Array(n);
    var gaps = [];
    for (var k = 0; k < n; k++) {
        var i = order[k], h = holes[i];
        if (!h.thDirX && !h.thDirY) continue;
        var best = -1, bestD2 = reach * reach;
        for (var q = 0; q < k; q++) {
            var j = order[q], other = holes[j];
            if (!(other.fireT < h.fireT)) continue;
            var dx = other.cx - h.cx, dy = other.cy - h.cy;
            if (dx * h.thDirX + dy * h.thDirY < rowDepth) continue;
            var d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = j; }
        }
        if (best >= 0) {
            rowsInFront[i] = rowsInFront[best] + 1;
            gaps.push(h.fireT - holes[best].fireT);
        }
    }
    gaps.sort(function (a, b) { return a - b; });
    return { rowsInFront: rowsInFront, delayS: gaps.length ? gaps[gaps.length >> 1] : null, spacing: spacing };
}

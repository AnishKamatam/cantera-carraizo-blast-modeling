/**
 * Break zone worked out from the charges, in place of a hand-drawn block cut.
 *
 * Each terrain column is tested at a set depth spacing with the repo's Holmberg-Persson
 * model. Holes fire in order, and the current ground is the terrain less whatever has
 * broken so far, so a free face and rock fired earlier are the same thing: open space.
 *
 *   1. A hole breaks rock only if open space that exposes its charge lies within twice its
 *      contour radius: Ash's burden, B = 2 R_d. The contour need not touch the face, since
 *      the wave reflected there does the rest. A hole with none is choked, breaks nothing
 *      and is reported.
 *   2. It breaks down to the lowest level where that holds, and never below its toe.
 *      Rock under the toe has nowhere to go.
 *   3. All around the hole it breaks as far as the threshold gives, and no further. That
 *      distance behind the last row is the back-break.
 *   4. Toward the opening, the burden between the contour and the opening goes too. The same
 *      distance away from the opening has no way out, and stands.
 *   5. Rock above a broken level has lost its support and comes down, reported as overhang.
 *
 * Different holes never add, as in the library, so the wall scallops and the floor humps
 * between holes come straight from hole positions. There is no random term.
 *
 * Results are uncalibrated at Carraizo. Evidence levels for the threshold are in
 * BREAK_THRESHOLD and in docs/verification/README.md, under "Break zone".
 */

import { computeHolmbergPerssonDamage } from "../../src/damage/HolmbergPerssonDamage.js";
import { rasterTop } from "../../src/movement/SurfaceMesh.js";
import { assumption, validateScenario } from "./schema.js";
import { buildTopo, buildVolume, enclosedVolume } from "./block.js";
import { heightAt } from "./terrain.js";

/**
 * PPV above which rock is taken as broken, used with K 700, alpha 0.7, beta 1.5 in the
 * NIOSH form. Only K / threshold matters, so this range also covers doubt in K.
 *
 *   1850: over-break limit, Stillwater, drift holes. Iverson et al. 2008, PRIMARY. Low end,
 *         since K, alpha and beta there differ and a limit does not carry across hole size.
 *   2540: "break up of rock mass". Bauer and Calder, in Singh, SECONDARY.
 *   3500: central. DERIVED: this form's PPV at the Modified Ash pressure radius (Iverson and
 *         Hustrulid 2011 Eq 3.11, PRIMARY) for coupled emulsion, 3200-4050 across 165-229 mm.
 *   6500: high end. DERIVED: the same at R_d = 25 r_h, as for ANFO in a 229 mm hole.
 */
export const BREAK_THRESHOLD = Object.freeze(assumption(3500, [1850, 6500],
    "PPV at which rock is broken, not first-crack PPV; bridged from Modified Ash radii, uncalibrated, not Carraizo data"));

/** New crack formation, Swedish igneous rock (Iverson et al. 2008, PRIMARY). Cracked, not broken. */
export const FIRST_CRACK_MM_S = 1000;

export const BREAK_DEFAULTS = Object.freeze({
    thresholdMmS: BREAK_THRESHOLD.value,
    K_hp: 700, alpha_hp: 0.7, beta_hp: 1.5,
    useNioshModified: true,
    elemsPerDeck: 8,
    cutoffDistance: 0.3,
    depthStepM: 0.5,
    burdenRatio: 2,
    breakoutDeg: 45,
    pillarMaxAreaM2: 25,
    ribMaxM: 4,
    minFragmentFraction: 0.01,
    wallMinM: 2,
    maxFilled: 0.25,
    shellPadM: 100,
});

const SAME_TIME_MS = 1e-6;

function hpParams(p) {
    return {
        K_hp: p.K_hp, alpha_hp: p.alpha_hp, beta_hp: p.beta_hp, useNioshModified: p.useNioshModified,
        elemsPerDeck: p.elemsPerDeck, cutoffDistance: p.cutoffDistance,
    };
}

/** Iverson and Hustrulid 2011 Eq 3.11: R_d = r_h 25 sqrt(P_wall / 1300) sqrt(2.65 / rho). */
export function modifiedAshRadiusM({ densityKgL, vodMs, holeDiamMm, rockDensityKgM3 }) {
    const wallMPa = (densityKgL * 1000 * vodMs * vodMs) / 8 / 1e6;
    return (holeDiamMm / 2000) * 25 * Math.sqrt(wallMPa / 1300) * Math.sqrt(2650 / rockDensityKgM3);
}

function chargeSpan(decks) {
    let topZ = -Infinity, baseZ = Infinity, x = 0, y = 0, offset = 0;
    for (const d of decks) {
        topZ = Math.max(topZ, d.topZ, d.baseZ);
        baseZ = Math.min(baseZ, d.topZ, d.baseZ);
        x += (d.topX + d.baseX) / 2;
        y += (d.topY + d.baseY) / 2;
    }
    x /= decks.length;
    y /= decks.length;
    for (const d of decks) {
        offset = Math.max(offset, Math.hypot(d.topX - x, d.topY - y), Math.hypot(d.baseX - x, d.baseY - y));
    }
    return { topZ, baseZ, x, y, offset };
}

/** Widest radius at which one hole's PPV reaches a threshold, in mm/s, in the plane of its charge. */
export function breakRadiusM(decks, thresholdMmS, params = {}) {
    const hp = hpParams({ ...BREAK_DEFAULTS, ...params });
    const { topZ, baseZ, x, y } = chargeSpan(decks);
    let widest = 0;
    for (let n = 0; n <= 8; n++) {
        const z = baseZ + ((topZ - baseZ) * n) / 8;
        const ppv = (r) => computeHolmbergPerssonDamage({ x: x + r, y, z }, decks, hp);
        if (ppv(0) < thresholdMmS) continue;
        let low = 0, high = 1;
        while (ppv(high) >= thresholdMmS && high < 4096) { low = high; high *= 2; }
        for (let k = 0; k < 20; k++) {
            const mid = (low + high) / 2;
            if (ppv(mid) >= thresholdMmS) low = mid; else high = mid;
        }
        widest = Math.max(widest, low);
    }
    return widest;
}

function checkHoles(terrain, holes, decks) {
    const byHole = new Map();
    for (const d of decks) {
        if (!(d.mass > 0)) continue;
        if (!byHole.has(d.holeIndex)) byHole.set(d.holeIndex, []);
        byHole.get(d.holeIndex).push(d);
    }
    const charged = [];
    for (const [index, list] of byHole) {
        const hole = holes[index];
        if (!hole) throw new Error(`breakZone: a deck names hole index ${index}, which does not exist`);
        const id = hole.holeID ?? index;
        if (Number.isNaN(heightAt(terrain.dtm, hole.collarX, hole.collarY))) {
            throw new Error(`breakZone: hole ${id} sits on NODATA ground at (${hole.collarX}, ${hole.collarY})`);
        }
        if (terrain.filled && heightAt(terrain.filled, hole.collarX, hole.collarY) > 0.5) {
            throw new Error(`breakZone: hole ${id} sits on interpolated ground at (${hole.collarX}, ${hole.collarY})`);
        }
        const fired = Math.min(...list.map((d) => d.timingMs ?? hole.holeTime ?? 0));
        charged.push({ index, id: String(id), hole, decks: list, time: fired, ...chargeSpan(list) });
    }
    if (charged.length === 0) throw new Error("breakZone: no charged holes");
    charged.sort((a, b) => a.time - b.time || a.index - b.index);
    return charged;
}

function columnGrid(dtm, charged, stride) {
    const cell = dtm.cell * stride;
    const minX = Math.min(...charged.map((h) => h.x - h.reach)), maxX = Math.max(...charged.map((h) => h.x + h.reach));
    const minY = Math.min(...charged.map((h) => h.y - h.reach)), maxY = Math.max(...charged.map((h) => h.y + h.reach));
    const firstI = Math.max(0, Math.floor((minX - dtm.x0) / cell) - 2);
    const firstJ = Math.max(0, Math.floor((minY - dtm.y0) / cell) - 2);
    const lastI = Math.min(Math.floor(dtm.cols / stride) - 1, Math.ceil((maxX - dtm.x0) / cell) + 2);
    const lastJ = Math.min(Math.floor(dtm.rows / stride) - 1, Math.ceil((maxY - dtm.y0) / cell) + 2);
    const cols = lastI - firstI + 1, rows = lastJ - firstJ + 1;
    const ground = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            // A column is the mean of its grid cells, and unknown if any of them is.
            let sum = 0;
            for (let b = 0; b < stride; b++) {
                for (let a = 0; a < stride; a++) {
                    sum += dtm.z[((firstJ + j) * stride + b) * dtm.cols + (firstI + i) * stride + a];
                }
            }
            ground[j * cols + i] = sum / (stride * stride);
        }
    }
    return { x0: dtm.x0 + firstI * cell, y0: dtm.y0 + firstJ * cell, cell, cols, rows, ground };
}

/** Columns within a hole's reach, nearest first, so results don't depend on scan order. */
function columnsNear(hole, grid) {
    const { x0, y0, cell, cols, rows } = grid;
    const list = [];
    const firstI = Math.max(0, Math.floor((hole.x - hole.reach - x0) / cell));
    const lastI = Math.min(cols - 1, Math.floor((hole.x + hole.reach - x0) / cell));
    const firstJ = Math.max(0, Math.floor((hole.y - hole.reach - y0) / cell));
    const lastJ = Math.min(rows - 1, Math.floor((hole.y + hole.reach - y0) / cell));
    for (let j = firstJ; j <= lastJ; j++) {
        for (let i = firstI; i <= lastI; i++) {
            const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
            const r = Math.hypot(x - hole.x, y - hole.y);
            if (r <= hole.reach) list.push({ q: j * cols + i, x, y, r });
        }
    }
    return list.sort((a, b) => a.r - b.r || a.q - b.q);
}

/**
 * Lowest level with a way out. Open space counts only if it exposes the charge, so a dip
 * in the bench top above the charge is not a free face. Below that open floor, rock can
 * still rise out along the breakout angle.
 */
function reliefLevel(hole, near, surface, levels, ppvAt, p, cell) {
    const open = near.filter((c) => surface[c.q] < hole.topZ).map((c) => {
        // Measured to the opening's near edge, so the answer doesn't depend on column size.
        const r = Math.max(0, c.r - cell / 2), scale = c.r > 0 ? r / c.r : 0;
        const inward = scale / p.burdenRatio;
        return { x: hole.x + (c.x - hole.x) * inward, y: hole.y + (c.y - hole.y) * inward, r, top: surface[c.q] };
    });
    if (open.length === 0) return null;
    const rise = Math.tan((p.breakoutDeg * Math.PI) / 180);
    const hasWayOut = (z) => {
        for (const c of open) if (c.top < z + c.r * rise && ppvAt(c.x, c.y, z) >= p.thresholdMmS) return true;
        return false;
    };
    const clip = hole.baseZ;
    if (hasWayOut(clip)) return clip;
    let below = clip;
    for (let k = 0; k < levels.count; k++) {
        const z = levels.at(k);
        if (z <= clip) continue;
        if (z > hole.topZ) return null;
        if (hasWayOut(z)) {
            // The contour moves smoothly, so close in on the level between depth steps.
            let high = z;
            for (let n = 0; n < 6; n++) {
                const mid = (below + high) / 2;
                if (hasWayOut(mid)) high = mid; else below = mid;
            }
            return high;
        }
        below = z;
    }
    return null;
}

/** Break one hole's rock: new floors in `floors`, and each broken level in `brokenLevels`. */
function breakAround(hole, near, surface, relief, levels, brokenLevels, floors, ppvAt, p) {
    const T = p.thresholdMmS;
    const firstLevel = Math.max(0, Math.ceil((relief - levels.base) / levels.step - 1e-9));
    for (const c of near) {
        const top = surface[c.q];
        if (!(top > relief)) continue;
        let previousZ = relief, previous = ppvAt(c.x, c.y, relief);
        let floor = previous >= T ? relief : null;
        for (let k = firstLevel; k < levels.count; k++) {
            const z = levels.at(k);
            if (z > top) break;
            if (z <= previousZ) continue;
            const ppv = ppvAt(c.x, c.y, z);
            if (ppv >= T) {
                brokenLevels[c.q * levels.count + k] = 1;
                if (floor === null) floor = z - ((ppv - T) / Math.max(ppv - previous, 1e-9)) * (z - previousZ);
            }
            previousZ = z;
            previous = ppv;
        }
        if (floor !== null && floor < floors[c.q]) floors[c.q] = Math.max(floor, relief);
    }
}

/**
 * The burden: rock between a hole and an opening it can break out to. For each column the
 * ray outward from the hole looks for the first opening. Levels whose contour reaches
 * 1 / burdenRatio of the way to that opening go; a column with no opening ahead stands.
 */
function sweepBurden(hole, wide, surface, relief, levels, brokenLevels, floors, ppvAt, grid, p) {
    const { x0, y0, cell, cols, rows } = grid;
    const rise = Math.tan((p.breakoutDeg * Math.PI) / 180);
    const firstLevel = Math.max(0, Math.ceil((relief - levels.base) / levels.step - 1e-9));
    const openAt = (x, y) => {
        const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
        if (i < 0 || j < 0 || i >= cols || j >= rows) return NaN;
        return surface[j * cols + i];
    };
    for (const c of wide) {
        const top = surface[c.q];
        if (!(top > relief) || c.r < cell / 2 || c.r > hole.reliefReach) continue;
        const dx = (c.x - hole.x) / c.r, dy = (c.y - hole.y) / c.r;
        // Open space under the charge's top, ahead of this column, and not this column itself.
        let opening = null;
        for (let r = c.r + cell / 2; r <= hole.reliefReach; r += cell / 2) {
            const z = openAt(hole.x + dx * r, hole.y + dy * r);
            if (z < hole.topZ && z < top) { opening = { r: r - cell / 2, z }; break; }
        }
        if (!opening) continue;
        const px = hole.x + (dx * opening.r) / p.burdenRatio, py = hole.y + (dy * opening.r) / p.burdenRatio;
        const lowest = Math.max(relief, opening.z - (opening.r - c.r) * rise);
        let floor = null;
        for (let k = firstLevel; k < levels.count; k++) {
            const z = levels.at(k);
            if (z > top) break;
            if (z < lowest || ppvAt(px, py, z) < p.thresholdMmS) continue;
            brokenLevels[c.q * levels.count + k] = 1;
            if (floor === null) floor = z;
        }
        if (floor !== null && floor < floors[c.q]) floors[c.q] = floor;
    }
}

function neighbours(q, cols, rows) {
    const j = Math.floor(q / cols), i = q - j * cols;
    const out = [];
    if (i > 0) out.push(q - 1);
    if (i < cols - 1) out.push(q + 1);
    if (j > 0) out.push(q - cols);
    if (j < rows - 1) out.push(q + cols);
    return out;
}

/** Four-connected pieces of the cells where wanted(q) is true, in scan order. */
function components(n, cols, rows, wanted) {
    const seen = new Uint8Array(n), found = [];
    for (let start = 0; start < n; start++) {
        if (seen[start] || !wanted(start)) continue;
        const cells = [start];
        seen[start] = 1;
        for (let at = 0; at < cells.length; at++) {
            for (const next of neighbours(cells[at], cols, rows)) {
                if (!seen[next] && wanted(next)) { seen[next] = 1; cells.push(next); }
            }
        }
        found.push(cells);
    }
    return found;
}

function dropFragments(grid, surface, p, area) {
    const { cols, rows, ground } = grid, n = cols * rows;
    const removed = (q) => surface[q] < ground[q];
    const pieces = components(n, cols, rows, removed);
    const size = pieces.map((cells) => cells.reduce((v, q) => v + (ground[q] - surface[q]) * area, 0));
    const total = size.reduce((a, b) => a + b, 0);
    let volume = 0, count = 0;
    pieces.forEach((cells, k) => {
        if (size[k] >= p.minFragmentFraction * total) return;
        for (const q of cells) surface[q] = ground[q];
        volume += size[k];
        count++;
    });
    return { fragmentsRemovedM3: volume, fragmentsRemovedCount: count };
}

/**
 * Rock enclosed by the zone stands on its own, with nothing beside it. Small plugs are
 * taken down to the floor around them; large ones are left in place and listed.
 */
function clearPillars(grid, surface, p, area) {
    const { cols, rows, ground, x0, y0, cell } = grid, n = cols * rows;
    const removed = (q) => surface[q] < ground[q];
    const known = (q) => !Number.isNaN(ground[q]);
    const onEdge = (q) => {
        const j = Math.floor(q / cols), i = q - j * cols;
        return i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
    };
    let volume = 0, count = 0;
    const standingIslands = [];
    for (const cells of components(n, cols, rows, (q) => !removed(q))) {
        if (cells.some((q) => onEdge(q) || !known(q))) continue;
        const areaM2 = cells.length * area;
        if (areaM2 > p.pillarMaxAreaM2) {
            let x = 0, y = 0;
            for (const q of cells) {
                const j = Math.floor(q / cols), i = q - j * cols;
                x += x0 + (i + 0.5) * cell;
                y += y0 + (j + 0.5) * cell;
            }
            standingIslands.push({ areaM2, x: x / cells.length, y: y / cells.length });
            continue;
        }
        // Fill inward from the plug's edge, so its new floor continues the one around it.
        const pending = new Set(cells), newFloor = new Map();
        while (pending.size) {
            const ready = [];
            for (const q of pending) {
                const known2 = neighbours(q, cols, rows).filter((m) => !pending.has(m)).map((m) => newFloor.get(m) ?? surface[m]);
                if (known2.length) ready.push([q, known2.reduce((a, b) => a + b, 0) / known2.length]);
            }
            for (const [q, floor] of ready) { pending.delete(q); newFloor.set(q, floor); }
        }
        let taken = 0;
        for (const [q, floor] of newFloor) {
            if (floor < ground[q]) {
                surface[q] = floor;
                taken += (ground[q] - floor) * area;
            }
        }
        if (taken > 0) count++;
        volume += taken;
    }
    return { pillarsRemovedM3: volume, pillarsRemovedCount: count, standingIslands };
}

/**
 * A slender rib left between the zone and ground that was already open is not rock that
 * stays. Across x or y: no wider than ribMaxM, taller than wide above both sides, with the
 * zone on exactly one side. With the zone on both sides it is a cusp between holes, which
 * is attached behind and stays, or a pillar, which clearPillars handles.
 */
function clearRibs(grid, surface, p, area) {
    const { cols, rows, ground, cell } = grid;
    if (!(p.ribMaxM > 0)) return { ribsRemovedM3: 0, ribCellsRemoved: 0 };
    const removed = (q) => surface[q] < ground[q];
    const steps = Math.floor(p.ribMaxM / cell);
    const marks = new Map();
    const probe = (i, j, di, dj, top) => {
        for (let k = 1; k <= steps; k++) {
            const a = i + di * k, b = j + dj * k;
            if (a < 0 || b < 0 || a >= cols || b >= rows) return null;
            const m = b * cols + a;
            if (Number.isNaN(surface[m])) return null;
            if (surface[m] <= top - p.wallMinM) return { k, m };
        }
        return null;
    };
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const q = j * cols + i;
            if (removed(q) || Number.isNaN(ground[q])) continue;
            for (const [di, dj] of [[1, 0], [0, 1]]) {
                const one = probe(i, j, di, dj, ground[q]), two = probe(i, j, -di, -dj, ground[q]);
                if (!one || !two) continue;
                const width = (one.k + two.k - 1) * cell;
                if (width > p.ribMaxM || removed(one.m) === removed(two.m)) continue;
                const drop = Math.min(ground[q] - surface[one.m], ground[q] - surface[two.m]);
                if (drop < width) continue;
                const floor = (surface[one.m] + surface[two.m]) / 2;
                if (floor < ground[q] && !(marks.get(q) <= floor)) marks.set(q, floor);
            }
        }
    }
    let volume = 0;
    for (const [q, floor] of marks) {
        surface[q] = floor;
        volume += (ground[q] - floor) * area;
    }
    return { ribsRemovedM3: volume, ribCellsRemoved: marks.size };
}

/**
 * Cells touching only at a corner would share one vertical mesh edge among four walls.
 * Fill one of the two empty cells, or if there is no rock to fill, drop a touching cell.
 */
function fixPinches(grid, surface, area) {
    const { cols, rows, ground } = grid;
    const removed = (q) => surface[q] < ground[q];
    let net = 0, changed = true, passes = 0;
    while (changed && passes++ < 100) {
        changed = false;
        for (let j = 0; j < rows - 1; j++) {
            for (let i = 0; i < cols - 1; i++) {
                const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
                let pair = null, gap = null;
                if (removed(a) && removed(d) && !removed(b) && !removed(c)) { pair = [a, d]; gap = [b, c]; }
                else if (removed(b) && removed(c) && !removed(a) && !removed(d)) { pair = [b, c]; gap = [a, d]; }
                if (!pair) continue;
                const floor = (surface[pair[0]] + surface[pair[1]]) / 2;
                const fill = gap.find((q) => ground[q] > floor);
                if (fill !== undefined) {
                    net += (ground[fill] - floor) * area;
                    surface[fill] = floor;
                } else {
                    net -= (ground[pair[1]] - surface[pair[1]]) * area;
                    surface[pair[1]] = ground[pair[1]];
                }
                changed = true;
            }
        }
    }
    return net;
}

export function convexHull(points) {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const unique = sorted.filter((p, k) => k === 0 || p[0] !== sorted[k - 1][0] || p[1] !== sorted[k - 1][1]);
    if (unique.length < 3) return unique;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => {
        const out = [];
        for (const p of list) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
            out.push(p);
        }
        out.pop();
        return out;
    };
    return half(unique).concat(half(unique.slice().reverse()));
}

/** Distance from a point to a convex hull, 0 inside. */
export function distanceToHull(x, y, hull) {
    if (hull.length === 1) return Math.hypot(x - hull[0][0], y - hull[0][1]);
    let nearest = Infinity, inside = hull.length >= 3;
    for (let k = 0; k < hull.length; k++) {
        const [ax, ay] = hull[k], [bx, by] = hull[(k + 1) % hull.length];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        if (dx * (y - ay) - dy * (x - ax) < 0) inside = false;
    }
    return inside ? 0 : nearest;
}

function stats(values) {
    if (values.length === 0) return { n: 0, meanM: 0, minM: 0, maxM: 0, p10M: 0, p90M: 0 };
    const sorted = values.slice().sort((a, b) => a - b);
    const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    return {
        n: sorted.length, meanM: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        minM: sorted[0], maxM: sorted[sorted.length - 1], p10M: at(0.1), p90M: at(0.9),
    };
}

/** How far the standing wall lies past the hole pattern (behind the last row). */
function measureWall(grid, surface, charged, p) {
    const { cols, rows, ground, x0, y0, cell } = grid;
    const hull = convexHull(charged.map((h) => [h.x, h.y]));
    const behindPattern = [], fromNearestHole = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const q = j * cols + i;
            if (!(surface[q] < ground[q])) continue;
            const sides = [[i + 1, j, 0.5, 0], [i - 1, j, -0.5, 0], [i, j + 1, 0, 0.5], [i, j - 1, 0, -0.5]];
            for (const [a, b, ox, oy] of sides) {
                if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
                const m = b * cols + a;
                if (surface[m] < ground[m] || !(ground[m] - surface[q] >= p.wallMinM)) continue;
                const x = x0 + (i + 0.5 + ox) * cell, y = y0 + (j + 0.5 + oy) * cell;
                const past = distanceToHull(x, y, hull);
                if (past > 0) behindPattern.push(past);
                fromNearestHole.push(Math.min(...charged.map((h) => Math.hypot(x - h.x, y - h.y))));
            }
        }
    }
    return { backBreak: stats(behindPattern), wallToNearestHole: stats(fromNearestHole) };
}

/**
 * @param {{dtm, filled}} terrain - grids from loadTerrain or terrainFromSurface
 * @param {Array} holes - hole entries; decks refer to them by holeIndex
 * @param {Array} decks
 * @param {Object} [params] - see BREAK_DEFAULTS; `stride` is grid cells per column
 * @returns {{mask, floorZ, grid, volumeM3, volume, shell, preblast, chokedHoles, backBreak, cleaning}}
 */
export function breakZoneFromCharges(terrain, holes, decks, params = {}) {
    const p = { ...BREAK_DEFAULTS, ...params };
    const { dtm } = terrain;
    const stride = p.stride ?? Math.max(1, Math.round(1 / dtm.cell));
    const hp = hpParams(p);
    const charged = checkHoles(terrain, holes, decks);
    for (const h of charged) {
        const radius = breakRadiusM(h.decks, p.thresholdMmS, p);
        h.contourReach = radius + h.offset + dtm.cell * stride;
        h.reliefReach = p.burdenRatio * radius + h.offset + dtm.cell * stride;
        h.reach = h.reliefReach;
    }

    const grid = columnGrid(dtm, charged, stride);
    const { cols, rows, ground, cell } = grid, n = cols * rows, area = cell * cell;
    const surface = ground.slice();

    let highest = -Infinity;
    for (const z of ground) if (z > highest) highest = z;
    const base = Math.min(...charged.map((h) => h.baseZ));
    const levels = { base, step: p.depthStepM, count: Math.ceil((highest - base) / p.depthStepM) + 2, at: (k) => base + k * p.depthStepM };
    const brokenLevels = new Uint8Array(n * levels.count);

    const chokedHoles = [];
    let nodataColumnsInReach = 0;
    for (let start = 0; start < charged.length;) {
        // Rock fired at the same moment cannot relieve itself, so a group sees only earlier rock.
        let end = start + 1;
        while (end < charged.length && charged[end].time - charged[start].time <= SAME_TIME_MS) end++;
        const floors = new Float64Array(n).fill(Infinity);
        for (let g = start; g < end; g++) {
            const hole = charged[g];
            const wide = columnsNear(hole, grid);
            const near = wide.filter((c) => c.r <= hole.contourReach);
            nodataColumnsInReach += near.filter((c) => Number.isNaN(ground[c.q])).length;
            const ppvAt = (x, y, z) => computeHolmbergPerssonDamage({ x, y, z }, hole.decks, hp);
            const relief = reliefLevel(hole, wide, surface, levels, ppvAt, p, cell);
            if (relief === null) {
                chokedHoles.push(hole.id);
                continue;
            }
            breakAround(hole, near, surface, relief, levels, brokenLevels, floors, ppvAt, p);
            sweepBurden(hole, wide, surface, relief, levels, brokenLevels, floors, ppvAt, grid, p);
        }
        for (let q = 0; q < n; q++) if (floors[q] < surface[q]) surface[q] = floors[q];
        start = end;
    }

    // Columns barely scratched are not a wall or a floor: they are below the depth step.
    for (let q = 0; q < n; q++) if (ground[q] - surface[q] < p.depthStepM / 2) surface[q] = ground[q];

    // Rock above a broken level has lost its support, measured before any cleaning.
    let overhangCollapsedM3 = 0;
    for (let q = 0; q < n; q++) {
        if (!(surface[q] < ground[q])) continue;
        let direct = 0;
        for (let k = 0; k < levels.count; k++) direct += brokenLevels[q * levels.count + k];
        overhangCollapsedM3 += Math.max(0, ground[q] - surface[q] - direct * levels.step) * area;
    }

    const fragments = dropFragments(grid, surface, p, area);
    const pillars = clearPillars(grid, surface, p, area);
    const ribs = clearRibs(grid, surface, p, area);
    const pinchFillM3 = fixPinches(grid, surface, area);

    const mask = new Uint8Array(n), floorZ = new Float64Array(n).fill(NaN), cells = [];
    let columnVolumeM3 = 0, filledColumns = 0, centroid = { x: 0, y: 0, z: 0 };
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const q = j * cols + i;
            if (!(surface[q] < ground[q])) continue;
            mask[q] = 1;
            floorZ[q] = surface[q];
            cells.push({ i, j, z: ground[q], floor: surface[q] });
            const v = (ground[q] - surface[q]) * area;
            const x = grid.x0 + (i + 0.5) * cell, y = grid.y0 + (j + 0.5) * cell;
            columnVolumeM3 += v;
            centroid.x += v * x;
            centroid.y += v * y;
            centroid.z += (v * (ground[q] + surface[q])) / 2;
            if (terrain.filled && heightAt(terrain.filled, x, y) > 0.5) filledColumns++;
        }
    }
    const filledFraction = cells.length ? filledColumns / cells.length : 0;
    if (filledFraction > p.maxFilled) {
        throw new Error(`breakZone: zone's filled fraction ${filledFraction.toFixed(2)} exceeds the limit of ${p.maxFilled}`);
    }
    if (columnVolumeM3 > 0) centroid = { x: centroid.x / columnVolumeM3, y: centroid.y / columnVolumeM3, z: centroid.z / columnVolumeM3 };

    const shape = { x0: grid.x0, y0: grid.y0, cell, cols, rows };
    const volume = cells.length ? buildVolume(shape, cells, null) : { id: "block-volume", name: "block-volume", role: "voxelblk", pos: new Float64Array(0), idx: new Uint32Array(0), np: 0, nt: 0 };

    const footprint = cellsOutline(cells, shape, charged);
    const shellStride = p.shellStride ?? Math.max(1, Math.round(2 / dtm.cell));
    const floorAt = (x, y, sample) => lowestFloor(shape, mask, floorZ, x, y, sample);
    const shell = buildTopo(dtm, footprint, p.shellPadM, shellStride, null, "terrain-shell", "shell", floorAt);
    const preblast = buildTopo(dtm, footprint, p.shellPadM, shellStride, null, "preblast-terrain", "other");

    return {
        mask, floorZ, grid: shape, ground,
        volumeM3: enclosedVolume(volume),
        columnVolumeM3,
        footprintM2: cells.length * area,
        centroid,
        volume, shell, preblast,
        polygon: footprint,
        chokedHoles,
        nodataColumnsInReach,
        filledFraction,
        ...measureWall(grid, surface, charged, p),
        cleaning: { ...fragments, ...pillars, ...ribs, pinchFillM3, overhangCollapsedM3 },
        randomness: "none",
        params: p,
    };
}

function cellsOutline(cells, { x0, y0, cell }, charged) {
    const corners = [];
    for (const c of cells) {
        corners.push([x0 + c.i * cell, y0 + c.j * cell], [x0 + (c.i + 1) * cell, y0 + c.j * cell]);
        corners.push([x0 + c.i * cell, y0 + (c.j + 1) * cell], [x0 + (c.i + 1) * cell, y0 + (c.j + 1) * cell]);
    }
    if (corners.length === 0) {
        for (const h of charged) corners.push([h.x - 1, h.y - 1], [h.x + 1, h.y - 1], [h.x, h.y + 1]);
    }
    return convexHull(corners);
}

/**
 * Floor for a shell sample. Inside the zone it follows the floor under that sample. A
 * sample beside the zone drops to the floor too, as block.js does, so that a wall cannot
 * cut into the zone's edge and start rock behind it.
 */
function lowestFloor({ x0, y0, cell, cols, rows }, mask, floorZ, x, y, sample) {
    const lowest = (half) => {
        const firstI = Math.max(0, Math.floor((x - half - x0) / cell)), lastI = Math.min(cols - 1, Math.ceil((x + half - x0) / cell) - 1);
        const firstJ = Math.max(0, Math.floor((y - half - y0) / cell)), lastJ = Math.min(rows - 1, Math.ceil((y + half - y0) / cell) - 1);
        let best = Infinity;
        for (let j = firstJ; j <= lastJ; j++) {
            for (let i = firstI; i <= lastI; i++) {
                if (mask[j * cols + i] && floorZ[j * cols + i] < best) best = floorZ[j * cols + i];
            }
        }
        return best;
    };
    const under = lowest(sample / 2);
    if (under !== Infinity) return under;
    const beside = lowest(sample);
    return beside !== Infinity ? beside : null;
}

/** Terrain from a surveyed mesh, where every cell is measured, none interpolated. */
export function terrainFromSurface(surface, cell) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < surface.pos.length; k += 3) {
        minX = Math.min(minX, surface.pos[k]);
        maxX = Math.max(maxX, surface.pos[k]);
        minY = Math.min(minY, surface.pos[k + 1]);
        maxY = Math.max(maxY, surface.pos[k + 1]);
    }
    const G = { gx0: minX, gy0: minY, cell, nx: Math.ceil((maxX - minX) / cell), ny: Math.ceil((maxY - minY) / cell) };
    const z = rasterTop([surface], G).map((v) => (v < -1e8 ? NaN : v));
    const grid = (values) => ({ cols: G.nx, rows: G.ny, x0: minX, y0: minY, cell, z: values });
    return { dtm: grid(Float64Array.from(z)), filled: grid(new Float64Array(G.nx * G.ny)) };
}

/** The same holes and charges, with the zone's meshes in place of whatever cut they had. */
export function withBreakZone(scenario, terrain, params = {}) {
    const a = scenario.assumptions || {};
    const fromDesign = {};
    if (a.holmbergK) fromDesign.K_hp = a.holmbergK.value;
    if (a.holmbergAlpha) fromDesign.alpha_hp = a.holmbergAlpha.value;
    if (a.holmbergBeta) fromDesign.beta_hp = a.holmbergBeta.value;
    const z = breakZoneFromCharges(terrain, scenario.holes, scenario.decks, { ...fromDesign, ...params });
    if (!(z.volumeM3 > 0)) throw new Error(`withBreakZone: no rock breaks; choked holes ${z.chokedHoles.join(", ")}`);
    const T = z.params.thresholdMmS;
    let floorMin = Infinity;
    for (const v of z.floorZ) if (v < floorMin) floorMin = v;
    return validateScenario({
        ...scenario,
        twin: scenario.twin ? { ...scenario.twin, filledFraction: z.filledFraction } : scenario.twin,
        block: { ...(scenario.block || {}), designPolygon: scenario.block?.polygon ?? null, designFloorZ: scenario.block?.floorZ ?? null, polygon: z.polygon, floorZ: floorMin },
        surfaces: [z.volume, z.shell, z.preblast],
        measured: ["preblast-terrain"],
        assumptions: {
            ...a,
            breakThresholdMmS: assumption(T, [Math.min(T, BREAK_THRESHOLD.range[0]), Math.max(T, BREAK_THRESHOLD.range[1])], BREAK_THRESHOLD.source),
            burdenRatio: assumption(z.params.burdenRatio, [1, 2], "burden over broken radius; B = 2 R_d, Iverson and Hustrulid 2011 Eq 3.3; not Carraizo data"),
            breakoutDeg: assumption(z.params.breakoutDeg, [0, 60], "judgement: angle rock can rise out over a lower floor; not measured, not Carraizo data"),
            ppvForm: { value: z.params.useNioshModified ? "NIOSH-modified Holmberg-Persson" : "Holmberg-Persson 1979", source: "Iverson et al. 2008 show the 1979 integral step is invalid" },
        },
        zone: {
            volumeM3: z.volumeM3,
            columnVolumeM3: z.columnVolumeM3,
            footprintM2: z.footprintM2,
            centroid: z.centroid,
            floorMinZ: floorMin,
            chokedHoles: z.chokedHoles,
            backBreak: z.backBreak,
            wallToNearestHole: z.wallToNearestHole,
            cleaning: z.cleaning,
            nodataColumnsInReach: z.nodataColumnsInReach,
            randomness: z.randomness,
            depthStepM: z.params.depthStepM,
            cellM: z.grid.cell,
        },
    });
}

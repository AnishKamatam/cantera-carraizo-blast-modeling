/**
 * Cut a closed blast-block mesh from terrain: top follows the DTM, bottom is flat
 * at floorZ, and walls close the boundary. Terrain with the block removed becomes
 * the collision surface. Blocks must rest on real ground, so NODATA is an error and
 * heavily interpolated ground is rejected.
 */

import { surfaceFromHeightfield } from "../../src/movement/SurfaceMesh.js";
import { heightAt } from "./terrain.js";

const COLLISION_CELL_M = 2;

export function insidePolygon(x, y, polygon) {
    let inside = false;
    for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
        const [xa, ya] = polygon[a], [xb, yb] = polygon[b];
        if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
}

export function surface(id, role, positions, triangles) {
    return {
        id, name: id, role,
        pos: new Float64Array(positions),
        idx: new Uint32Array(triangles),
        np: positions.length / 3,
        nt: triangles.length / 3,
    };
}

function selectCells(dtm, polygon) {
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    const firstI = Math.max(0, Math.floor((Math.min(...xs) - dtm.x0) / dtm.cell));
    const lastI = Math.min(dtm.cols - 1, Math.floor((Math.max(...xs) - dtm.x0) / dtm.cell));
    const firstJ = Math.max(0, Math.floor((Math.min(...ys) - dtm.y0) / dtm.cell));
    const lastJ = Math.min(dtm.rows - 1, Math.floor((Math.max(...ys) - dtm.y0) / dtm.cell));
    const cells = [];
    for (let j = firstJ; j <= lastJ; j++) {
        for (let i = firstI; i <= lastI; i++) {
            const x = dtm.x0 + (i + 0.5) * dtm.cell, y = dtm.y0 + (j + 0.5) * dtm.cell;
            if (insidePolygon(x, y, polygon)) cells.push({ i, j, x, y, z: dtm.z[j * dtm.cols + i] });
        }
    }
    return cells;
}

/**
 * Closed mesh over grid cells: top follows each cell's z, and the bottom is floorZ,
 * or, when floorZ is null, each cell's own floor. A corner's bottom is then the mean
 * floor of the cells touching it, so a corner's bottom stays under its top.
 */
export function buildVolume(dtm, cells, floorZ) {
    const key = (i, j) => j * (dtm.cols + 1) + i;
    const cellSet = new Set(cells.map((c) => key(c.i, c.j)));

    // A corner's top height is the mean of the block cells touching it.
    const corners = new Map();
    for (const c of cells) {
        for (const [ci, cj] of [[c.i, c.j], [c.i + 1, c.j], [c.i, c.j + 1], [c.i + 1, c.j + 1]]) {
            const k = key(ci, cj);
            const corner = corners.get(k) || { ci, cj, sum: 0, floorSum: 0, n: 0, index: corners.size };
            corner.sum += c.z;
            corner.floorSum += floorZ === null ? c.floor : 0;
            corner.n++;
            corners.set(k, corner);
        }
    }
    const positions = new Array(corners.size * 6);
    for (const corner of corners.values()) {
        const x = dtm.x0 + corner.ci * dtm.cell, y = dtm.y0 + corner.cj * dtm.cell;
        const at = corner.index * 3, under = (corners.size + corner.index) * 3;
        positions[at] = x; positions[at + 1] = y; positions[at + 2] = corner.sum / corner.n;
        positions[under] = x; positions[under + 1] = y;
        positions[under + 2] = floorZ === null ? corner.floorSum / corner.n : floorZ;
    }
    const top = (i, j) => corners.get(key(i, j)).index;
    const bottom = (i, j) => corners.size + top(i, j);

    const triangles = [];
    for (const { i, j } of cells) {
        // Split along the (i+1, j)-(i, j+1) diagonal. The voxeliser offsets its rays
        // by +eps in x and y, which can land on the other diagonal of an aligned
        // grid, where both triangles' hits cancel and the column is lost.
        triangles.push(top(i, j), top(i + 1, j), top(i, j + 1), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
        triangles.push(bottom(i, j), bottom(i, j + 1), bottom(i + 1, j), bottom(i + 1, j), bottom(i, j + 1), bottom(i + 1, j + 1));
        // Each side runs counterclockwise seen from above, so walls face outward.
        const sides = [
            [i, j - 1, [i, j], [i + 1, j]],
            [i + 1, j, [i + 1, j], [i + 1, j + 1]],
            [i, j + 1, [i + 1, j + 1], [i, j + 1]],
            [i - 1, j, [i, j + 1], [i, j]],
        ];
        for (const [ni, nj, p, q] of sides) {
            if (ni >= 0 && nj >= 0 && cellSet.has(key(ni, nj))) continue;
            triangles.push(bottom(...p), bottom(...q), top(...q), bottom(...p), top(...q), top(...p));
        }
    }
    return surface("block-volume", "voxelblk", positions, triangles);
}

export function enclosedVolume({ pos, idx }) {
    let sum = 0;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        sum += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
            - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
            + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    return sum / 6;
}

/**
 * The ground after the blast: terrain outside the block and floorZ inside it, so
 * rock can land on the floor and is confined by the back wall. Walls are pushed one
 * sampling step outward, so they can never cut into the block's edge, where rock
 * would start behind them and be pushed down through the floor. A floorAt(x, y, cell)
 * function, when given, supplies the floor instead: null where there is none.
 */
export function buildTopo(dtm, polygon, padM, stride, floorZ, id = "terrain-shell", role = "shell", floorAt = null) {
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    const cell = dtm.cell * stride;
    const firstI = Math.max(0, Math.ceil((Math.min(...xs) - padM - dtm.x0) / cell));
    const firstJ = Math.max(0, Math.ceil((Math.min(...ys) - padM - dtm.y0) / cell));
    const G = { gx0: dtm.x0 + firstI * cell, gy0: dtm.y0 + firstJ * cell, cell };
    G.nx = Math.max(0, Math.min(Math.floor(dtm.cols / stride), Math.floor((Math.max(...xs) + padM - dtm.x0) / cell)) - firstI);
    G.ny = Math.max(0, Math.min(Math.floor(dtm.rows / stride), Math.floor((Math.max(...ys) + padM - dtm.y0) / cell)) - firstJ);

    const z = new Float64Array(G.nx * G.ny);
    for (let j = 0; j < G.ny; j++) {
        for (let i = 0; i < G.nx; i++) {
            const x = G.gx0 + (i + 0.5) * cell, y = G.gy0 + (j + 0.5) * cell;
            let nearBlock = false;
            for (const dx of [-cell, 0, cell]) {
                for (const dy of [-cell, 0, cell]) {
                    if (insidePolygon(x + dx, y + dy, polygon)) nearBlock = true;
                }
            }
            const ground = heightAt(dtm, x, y);
            const floor = floorAt ? floorAt(x, y, cell) : null;
            if (floor !== null) z[j * G.nx + i] = Number.isNaN(ground) ? floor : Math.min(floor, ground);
            else z[j * G.nx + i] = nearBlock && floorZ !== null ? floorZ : Number.isNaN(ground) ? -1e9 : ground;
        }
    }
    const mesh = surfaceFromHeightfield(z, G, { id, name: id });
    if (!mesh) throw new Error("cutBlock: no terrain around the polygon to collide with");
    return { id: mesh.id, name: mesh.name, role, pos: mesh.pos, idx: mesh.idx, np: mesh.pos.length / 3, nt: mesh.idx.length / 3 };
}

export function cutBlock(terrain, polygon, { floorZ, maxFilled = 0.25, topoPadM = 100, topoStride }) {
    const { dtm, filled } = terrain;
    // Near block size: the library's collision pushes once per triangle touched, so a
    // much finer mesh stops rock settling, and a coarser one widens the edge trench.
    const stride = topoStride ?? Math.max(1, Math.round(COLLISION_CELL_M / dtm.cell));
    const cells = selectCells(dtm, polygon);
    if (cells.length === 0) throw new Error("cutBlock: polygon contains no grid cells");

    const missing = cells.filter((c) => Number.isNaN(c.z)).length;
    if (missing) throw new Error(`cutBlock: polygon crosses ${missing} NODATA cells`);

    const below = cells.filter((c) => c.z <= floorZ).length;
    if (below) throw new Error(`cutBlock: floorZ ${floorZ} is at or above the ground in ${below} of ${cells.length} cells`);

    const nFilled = cells.filter((c) => heightAt(filled, c.x, c.y) > 0.5).length;
    const filledFraction = nFilled / cells.length;
    if (filledFraction > maxFilled) {
        throw new Error(`cutBlock: filled fraction ${filledFraction.toFixed(2)} exceeds the limit of ${maxFilled}`);
    }

    const volume = buildVolume(dtm, cells, floorZ);
    let mass = 0, cx = 0, cy = 0, cz = 0;
    for (const c of cells) {
        const h = c.z - floorZ;
        mass += h;
        cx += h * c.x;
        cy += h * c.y;
        cz += h * (floorZ + h / 2);
    }
    return {
        volume,
        topo: buildTopo(dtm, polygon, topoPadM, stride, floorZ),
        preblast: buildTopo(dtm, polygon, topoPadM, stride, null, "preblast-terrain", "other"),
        filledFraction,
        volumeM3: enclosedVolume(volume),
        centroid: { x: cx / mass, y: cy / mass, z: cz / mass },
        polygon,
        floorZ,
        topoPadM,
        topoStride: stride,
    };
}

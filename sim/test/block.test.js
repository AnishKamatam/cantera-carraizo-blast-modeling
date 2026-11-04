import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsc, heightAt, loadTerrain } from "../scenario/terrain.js";
import { cutBlock } from "../scenario/block.js";
import { voxeliseVolumes } from "../../src/movement/Voxeliser.js";

/** Build .asc text from f(x, y) at cell centres; the first row written is north. */
function asc(cols, rows, cell, f) {
    const lines = [`ncols ${cols}`, `nrows ${rows}`, "xllcorner 0", "yllcorner 0", `cellsize ${cell}`, "NODATA_value -9999"];
    for (let j = rows - 1; j >= 0; j--) {
        const row = [];
        for (let i = 0; i < cols; i++) row.push(f((i + 0.5) * cell, (j + 0.5) * cell));
        lines.push(row.join(" "));
    }
    return lines.join("\n") + "\n";
}

const SIZE = 60;
const flat = (z, fill = () => 0, nodata = () => false) => ({
    dtm: parseAsc(asc(SIZE, SIZE, 1, (x, y) => (nodata(x, y) ? -9999 : z))),
    filled: parseAsc(asc(SIZE, SIZE, 1, fill)),
});
const inSquare = (x, y) => x >= 20 && x <= 40 && y >= 20 && y <= 40;
const square = [[20, 20], [40, 20], [40, 40], [20, 40]];

function openEdges({ idx }) {
    const counts = new Map();
    for (let t = 0; t < idx.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = idx[t + e], b = idx[t + (e + 1) % 3];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    let open = 0;
    for (const n of counts.values()) if (n !== 2) open++;
    return open;
}

function signedVolume({ pos, idx }) {
    let v = 0;
    for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    return v / 6;
}

describe("parseAsc", () => {
    it("reads the first row as north", () => {
        const g = parseAsc(asc(10, 100, 1, (x, y) => 100 + 0.1 * y));
        expect(heightAt(g, 5, 95)).toBeGreaterThan(heightAt(g, 5, 5));
        expect(heightAt(g, 5, 95)).toBeCloseTo(109.55, 5);
    });
    it("reads NODATA as NaN", () => {
        const g = parseAsc(asc(4, 4, 1, () => -9999));
        expect(heightAt(g, 1, 1)).toBeNaN();
    });
    it("returns NaN outside the grid", () => {
        const g = parseAsc(asc(4, 4, 1, () => 5));
        expect(heightAt(g, -1, 1)).toBeNaN();
        expect(heightAt(g, 1, 400)).toBeNaN();
    });
    it("rejects a file with too few values", () => {
        expect(() => parseAsc("ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n1 2 3\n")).toThrow(/values/);
    });
});

describe("loadTerrain", () => {
    it("loads the height and interpolated-cell grids", () => {
        const dir = mkdtempSync(join(tmpdir(), "terrain-"));
        writeFileSync(join(dir, "dtm.asc"), asc(4, 4, 1, () => 5));
        writeFileSync(join(dir, "filled.asc"), asc(4, 4, 1, () => 1));
        const t = loadTerrain(dir);
        expect(heightAt(t.dtm, 1, 1)).toBe(5);
        expect(heightAt(t.filled, 1, 1)).toBe(1);
    });
});

describe("cutBlock", () => {
    it("computes block volume", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100 });
        expect(b.volumeM3).toBeCloseTo(20 * 20 * 10, 0);
        expect(b.floorZ).toBe(100);
    });
    it("makes a closed mesh whose enclosed volume matches, facing outward", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100 });
        expect(openEdges(b.volume)).toBe(0);
        expect(signedVolume(b.volume)).toBeCloseTo(b.volumeM3, 3);
        expect(b.volume.role).toBe("voxelblk");
    });
    it("fills with voxels at any resolution without losing columns", () => {
        // Rays landing on a shared triangle diagonal cancel in the voxeliser, so
        // the mesh's diagonals must avoid the rays at aligned resolutions.
        const b = cutBlock(flat(110), square, { floorZ: 100 });
        for (const res of [1, 1.5, 2, 2.5, 3]) {
            const { count } = voxeliseVolumes([b.volume], res);
            const ratio = (count * res ** 3) / b.volumeM3;
            expect(ratio, `resolution ${res}`).toBeGreaterThan(0.8);
            expect(ratio, `resolution ${res}`).toBeLessThan(1.15);
        }
    });
    it("follows sloped terrain on top", () => {
        const t = {
            dtm: parseAsc(asc(SIZE, SIZE, 1, (x, y) => 110 + 0.1 * y)),
            filled: parseAsc(asc(SIZE, SIZE, 1, () => 0)),
        };
        const b = cutBlock(t, square, { floorZ: 100 });
        expect(openEdges(b.volume)).toBe(0);
        // Mean surface height over the block is 113 m.
        expect(b.volumeM3).toBeCloseTo(20 * 20 * 13, -1);
    });
    it("errors when the polygon crosses NODATA", () => {
        expect(() => cutBlock(flat(110, () => 0, (x, y) => x > 30 && x < 32 && y > 30 && y < 32), square, { floorZ: 100 })).toThrow(/NODATA/);
    });
    it("rejects mostly interpolated ground and states the fraction", () => {
        expect(() => cutBlock(flat(110, inSquare_(0.5)), square, { floorZ: 100 })).toThrow(/filled.*0\.[0-9]+/);
    });
    it("reports the filled fraction of an accepted block", () => {
        const b = cutBlock(flat(110, inSquare_(0.1)), square, { floorZ: 100 });
        expect(b.filledFraction).toBeGreaterThan(0.05);
        expect(b.filledFraction).toBeLessThan(0.15);
    });
    it("errors when floorZ is above the ground", () => {
        expect(() => cutBlock(flat(110), square, { floorZ: 120 })).toThrow(/floorZ/);
    });
    it("errors when the polygon is outside the grid or smaller than a cell", () => {
        expect(() => cutBlock(flat(110), [[500, 500], [520, 500], [520, 520]], { floorZ: 100 })).toThrow(/polygon/);
    });
    it("builds surrounding terrain within the pad, and no further", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 10, topoStride: 1 });
        expect(b.topo.role).toBe("shell");
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i < b.topo.np; i++) {
            minX = Math.min(minX, b.topo.pos[i * 3]);
            maxX = Math.max(maxX, b.topo.pos[i * 3]);
        }
        expect(minX).toBeGreaterThanOrEqual(9);
        expect(maxX).toBeLessThanOrEqual(51);
        expect(b.topo.nt).toBeGreaterThan(0);
    });
    it("collision surface is the floor inside the block and terrain outside it", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 10, topoStride: 1 });
        let floor = 0, ground = 0;
        for (let i = 0; i < b.topo.np; i++) {
            const x = b.topo.pos[i * 3], y = b.topo.pos[i * 3 + 1], z = b.topo.pos[i * 3 + 2];
            if (inSquare(x, y)) { expect(z).toBe(100); floor++; }
            if (x < 18 || x > 42 || y < 18 || y > 42) { expect(z).toBe(110); ground++; }
        }
        expect(floor).toBeGreaterThan(300);
        expect(ground).toBeGreaterThan(100);
    });
    it("keeps the collision surface's walls out of the block at any sampling", () => {
        for (const topoStride of [1, 2, 3]) {
            const { topo } = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 12, topoStride });
            for (let t = 0; t < topo.nt; t++) {
                const v = [0, 1, 2].map((k) => topo.idx[t * 3 + k] * 3);
                const zs = v.map((q) => topo.pos[q + 2]);
                if (Math.max(...zs) === 100) continue;
                const xs = v.map((q) => topo.pos[q]), ys = v.map((q) => topo.pos[q + 1]);
                const overlaps = Math.max(...xs) > 20 && Math.min(...xs) < 40 && Math.max(...ys) > 20 && Math.min(...ys) < 40;
                expect(overlaps, `stride ${topoStride} triangle ${t}`).toBe(false);
            }
        }
    });
    it("samples the collision surface near block size whatever the grid's cell", () => {
        const half = {
            dtm: parseAsc(asc(120, 120, 0.5, () => 110)),
            filled: parseAsc(asc(120, 120, 0.5, () => 0)),
        };
        expect(cutBlock(half, square, { floorZ: 100 }).topoStride).toBe(4);
        expect(cutBlock(flat(110), square, { floorZ: 100 }).topoStride).toBe(2);
    });
    it("keeps the untouched ground for measuring where rock ends up", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 10 });
        expect(b.preblast.role).toBe("other");
        for (let i = 0; i < b.preblast.np; i++) expect(b.preblast.pos[i * 3 + 2]).toBe(110);
    });
    it("stores only the fields a scenario needs on the collision surface", () => {
        const { topo } = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 5 });
        expect(Object.keys(topo).sort()).toEqual(["id", "idx", "name", "np", "nt", "pos", "role"]);
    });
    it("leaves a gap in surrounding terrain at NODATA cells", () => {
        const full = cutBlock(flat(110), square, { floorZ: 100, topoPadM: 10, topoStride: 1 });
        const gap = cutBlock(flat(110, () => 0, (x, y) => x < 15 && y < 15), square, { floorZ: 100, topoPadM: 10, topoStride: 1 });
        expect(gap.topo.nt).toBeLessThan(full.topo.nt);
    });
    it("gives the block's centroid", () => {
        const b = cutBlock(flat(110), square, { floorZ: 100 });
        expect(b.centroid.x).toBeCloseTo(30, 5);
        expect(b.centroid.y).toBeCloseTo(30, 5);
        expect(b.centroid.z).toBeCloseTo(105, 5);
    });
});

function inSquare_(fraction) {
    return (x, y) => (inSquare(x, y) && x < 20 + 20 * fraction ? 1 : 0);
}

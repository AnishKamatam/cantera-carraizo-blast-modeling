import { describe, it, expect } from "vitest";
import { heightAt } from "../scenario/terrain.js";
import { cutBlock } from "../scenario/block.js";
import { DEFAULT_DESIGN, generatePattern, scenarioFromTerrain } from "../scenario/pattern.js";
import { validateScenario } from "../scenario/schema.js";
import { toSimData } from "../scenario/io.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";

function terrainFrom(f, size = 80) {
    const z = new Float64Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) z[j * size + i] = f(i + 0.5, j + 0.5);
    const grid = (values) => ({ cols: size, rows: size, x0: 0, y0: 0, cell: 1, z: values });
    return { dtm: grid(z), filled: grid(new Float64Array(size * size)) };
}

const polygon = [[20, 20], [50, 20], [50, 50], [20, 50]];
const terrain = terrainFrom((x, y) => 110 + 0.05 * x);
const block = cutBlock(terrain, polygon, { floorZ: 100 });

describe("DEFAULT_DESIGN", () => {
    it("labels every value as an assumption, not Carraizo data", () => {
        for (const record of Object.values(DEFAULT_DESIGN)) expect(record.source).toMatch(/not Carraizo data|no site geology/);
        expect(DEFAULT_DESIGN.burdenM).toMatchObject({ value: 3.5, range: [2.5, 4.5] });
        expect(DEFAULT_DESIGN.holmbergK.value).toBe(700);
        expect(DEFAULT_DESIGN.holmbergAlpha.value).toBe(0.7);
        expect(DEFAULT_DESIGN.holmbergBeta.value).toBe(1.5);
        expect(DEFAULT_DESIGN.rockType.value).toBe("unconfirmed");
    });
});

describe("generatePattern", () => {
    it("charges each hole between stemming and toe with the right mass", () => {
        const { decks, holes } = generatePattern(block, terrain);
        const d = decks[0];
        const lengthM = d.topZ - d.baseZ;
        const areaM2 = Math.PI * (0.115 / 2) ** 2;
        expect(d.mass).toBeCloseTo(areaM2 * lengthM * 1150, 1);
        expect(d.topZ).toBeCloseTo(holes[0].collarZ - 2.5, 5);
        expect(d.baseZ).toBeCloseTo(holes[0].toeZ, 5);
    });
    it("collars sit on the terrain and toes below the floor by the subdrill", () => {
        const { holes } = generatePattern(block, terrain);
        for (const h of holes) {
            expect(h.collarZ).toBeCloseTo(heightAt(terrain.dtm, h.collarX, h.collarY), 5);
            expect(h.toeZ).toBeCloseTo(block.floorZ - 1, 5);
        }
    });
    it("keeps every hole inside the polygon", () => {
        const { holes } = generatePattern(block, terrain);
        expect(holes.length).toBeGreaterThan(20);
        for (const h of holes) {
            expect(h.collarX).toBeGreaterThan(20);
            expect(h.collarX).toBeLessThan(50);
            expect(h.collarY).toBeGreaterThan(20);
            expect(h.collarY).toBeLessThan(50);
        }
    });
    it("fires later rows later, starting at the south", () => {
        const { holes } = generatePattern(block, terrain);
        const rows = [...new Set(holes.map((h) => h.collarY))].sort((a, b) => a - b);
        const first = (y) => holes.filter((h) => h.collarY === y).map((h) => h.holeTime).sort((a, b) => a - b)[0];
        expect(first(rows[0])).toBe(0);
        expect(first(rows[1])).toBe(42);
        expect(first(rows[2])).toBe(84);
    });
    it("delays holes within a row", () => {
        const { holes } = generatePattern(block, terrain);
        const row = holes.filter((h) => h.collarY === holes[0].collarY).sort((a, b) => a.collarX - b.collarX);
        expect(row[1].holeTime - row[0].holeTime).toBe(17);
    });
    it("spaces holes and rows by the design", () => {
        const { holes } = generatePattern(block, terrain);
        const ys = [...new Set(holes.map((h) => h.collarY))].sort((a, b) => a - b);
        expect(ys[1] - ys[0]).toBeCloseTo(3.5, 5);
        const row = holes.filter((h) => h.collarY === ys[0]).map((h) => h.collarX).sort((a, b) => a - b);
        expect(row[1] - row[0]).toBeCloseTo(4, 5);
    });
    it("ties each deck to its hole and fire time", () => {
        const { holes, decks } = generatePattern(block, terrain);
        expect(decks.length).toBe(holes.length);
        decks.forEach((d, k) => {
            expect(d.holeIndex).toBe(k);
            expect(d.timingMs).toBe(holes[k].holeTime);
        });
    });
    it("errors when no holes fit", () => {
        const tiny = { ...block, polygon: [[30, 30], [30.5, 30], [30.5, 30.5], [30, 30.5]] };
        expect(() => generatePattern(tiny, terrain)).toThrow(/no holes/);
    });
    it("keeps overrides labelled, widening the range if needed", () => {
        const { assumptions, holes } = generatePattern(block, terrain, { burdenM: 6 });
        expect(assumptions.burdenM.value).toBe(6);
        expect(assumptions.burdenM.source).toMatch(/override/);
        expect(assumptions.burdenM.range[1]).toBeGreaterThanOrEqual(6);
        const ys = [...new Set(holes.map((h) => h.collarY))].sort((a, b) => a - b);
        expect(ys[1] - ys[0]).toBeCloseTo(6, 5);
    });
    it("rejects an override of an unknown design value", () => {
        expect(() => generatePattern(block, terrain, { burden: 3 })).toThrow(/burden/);
    });
    it("skips holes too short to charge below the stemming", () => {
        const low = terrainFrom((x) => (x < 35 ? 101 : 110));
        const lowBlock = cutBlock(low, polygon, { floorZ: 100 });
        const { holes, decks } = generatePattern(lowBlock, low, { subdrillM: 0.5, stemmingM: 3.5 });
        expect(holes.every((h) => h.collarX >= 35)).toBe(true);
        for (const d of decks) expect(d.topZ - d.baseZ).toBeGreaterThan(0);
    });
});

describe("scenarioFromTerrain", () => {
    const s = scenarioFromTerrain(terrain, polygon, { name: "t", floorZ: 100, twinVersion: "test" });

    it("builds a valid scenario that records its twin and assumptions", () => {
        expect(() => validateScenario(s)).not.toThrow();
        expect(s.measured).toEqual(["surfaces"]);
        expect(s.twin).toEqual({ version: "test", filledFraction: 0 });
        expect(s.assumptions.spacingM.value).toBe(4);
        expect(s.surfaces.map((x) => x.role).sort()).toEqual(["other", "shell", "voxelblk"]);
    });
    it("records the cut, so it can be repeated on a newer twin", () => {
        expect(s.block).toMatchObject({ polygon, floorZ: 100, topoPadM: 100, topoStride: 2 });
        expect(() => validateScenario({ ...s, block: { polygon } })).toThrow(/block/);
    });
    it("voxelises the block and fires holes in the simulator", () => {
        const sim = new BlastMovementSimulator({ seed: 1, voxelRes: 2, maxVoxels: 3000 }).load(toSimData(s));
        const n = sim.generateVoxels();
        // 10,575 m3 at 2 m voxels is about 1,320 blocks.
        expect(n).toBeGreaterThan(1050);
        expect(n).toBeLessThan(1500);
        expect(sim.holes.length).toBe(s.holes.length);
        expect(sim.chargeElementCount).toBeGreaterThan(0);
    });
});

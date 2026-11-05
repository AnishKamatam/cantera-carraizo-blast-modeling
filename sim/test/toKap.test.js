import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseKAP, parseKAPObjects } from "../../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import { scenarioFromTerrain } from "../scenario/pattern.js";
import { toSimData } from "../scenario/io.js";
import { scenarioToKap } from "../scenario/toKap.js";

function terrainFrom(f, size = 100) {
    const z = new Float64Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) z[j * size + i] = f(i + 0.5, j + 0.5);
    const grid = (values) => ({ cols: size, rows: size, x0: 0, y0: 0, cell: 1, z: values });
    return { dtm: grid(z), filled: grid(new Float64Array(size * size)) };
}
const scenario = scenarioFromTerrain(terrainFrom((x) => (x < 60 ? 115 : 100)), [[30, 20], [58, 20], [58, 60], [30, 60]], {
    name: "t", floorZ: 100, twinVersion: "test", freeFace: "E", overrides: { holeDiamMm: 165, burdenM: 5, spacingM: 6, stemmingM: 4 },
});
const kap = scenarioToKap(scenario);

describe("scenarioToKap", () => {
    const parsed = parseKAPObjects(kap);

    it("round-trips holes, positions and fire times", () => {
        expect(parsed.holes.length).toBe(scenario.holes.length);
        parsed.holes.forEach((h, i) => {
            expect(h.collarX).toBeCloseTo(scenario.holes[i].collarX, 6);
            expect(h.toeZ).toBeCloseTo(scenario.holes[i].toeZ, 6);
            expect(h.holeTime).toBeCloseTo(scenario.holes[i].holeTime, 6);
            expect(h.holeDiamMm).toBe(165);
        });
    });
    it("round-trips charge mass within 0.5%", () => {
        const total = (decks) => decks.reduce((sum, d) => sum + d.mass, 0);
        expect(parsed.decks.length).toBe(scenario.decks.length);
        expect(Math.abs(total(parsed.decks) - total(scenario.decks)) / total(scenario.decks)).toBeLessThan(0.005);
        expect(parsed.decks[0].timingMs).toBeCloseTo(scenario.decks[0].timingMs, 6);
    });
    it("names surfaces so the reader gives them the right roles", () => {
        const roles = parsed.surfaces.map((s) => s.role).sort();
        expect(roles).toEqual(["shell", "shelltopo", "voxelblk"]);
    });
    it("survives the JSON file the demo loads", async () => {
        const again = await parseKAP(new TextEncoder().encode(JSON.stringify(kap)));
        expect(again.holes.length).toBe(scenario.holes.length);
        expect(again.surfaces.length).toBe(3);
    });
    it("runs in the repo's own simulator like the original scenario", async () => {
        const run = async (data) => {
            const sim = new BlastMovementSimulator({ seed: 2, maxVoxels: 800 }).load(data);
            sim.generateVoxels();
            await sim.runAsync();
            return sim.results();
        };
        const a = await run(parsed), b = await run(toSimData(scenario));
        expect(a.blockCount).toBe(b.blockCount);
        expect(Math.abs(a.comShift.bearing - b.comShift.bearing)).toBeLessThan(25);
    }, 60000);
    it("still parses the repo's example, as a control", async () => {
        expect((await parseKAP(readFileSync("examples/SWELLFACTOR.kap"))).holes.length).toBe(531);
    });
});

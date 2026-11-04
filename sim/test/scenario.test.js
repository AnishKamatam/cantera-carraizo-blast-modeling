import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assumption, validateScenario } from "../scenario/schema.js";
import { writeScenario, readScenario, toSimData } from "../scenario/io.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import { createHoleEntry } from "../../src/core/HoleEntry.js";
import { createDeckEntry } from "../../src/core/DeckEntry.js";

function box(id, x0, x1, y0, y1, z0, z1) {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    return { id, name: id, role: "voxelblk", pos: new Float64Array(P.flat()), idx: new Uint32Array(F.flat()), np: 8, nt: 12 };
}

const valid = {
    version: 1,
    name: "fixture",
    origin: null,
    twin: null,
    holes: [createHoleEntry({ holeID: "1", collarX: 5, collarY: 5, collarZ: 10, toeX: 5, toeY: 5, toeZ: -1, holeTime: 0 })],
    decks: [createDeckEntry({ topX: 5, topY: 5, topZ: 7, baseX: 5, baseY: 5, baseZ: -1, mass: 90, holeIndex: 0 })],
    surfaces: [box("block", 0, 10, 0, 10, 0, 10)],
    assumptions: { burdenM: assumption(3.5, [2.5, 4.5], "typical quarry value") },
    measured: ["surfaces"],
};

describe("assumption", () => {
    it("rejects an empty source", () => {
        expect(() => assumption(3.5, [3, 4.5], "")).toThrow(/source/);
    });
    it("rejects a value outside its range", () => {
        expect(() => assumption(5, [3, 4.5], "typical")).toThrow(/range/);
    });
});

describe("validateScenario", () => {
    it("accepts a complete scenario", () => {
        expect(validateScenario(valid)).toBe(valid);
    });
    it("rejects a scenario with no holes", () => {
        expect(() => validateScenario({ ...valid, holes: [] })).toThrow(/holes/);
    });
    it("rejects an unlabelled assumption by name", () => {
        expect(() => validateScenario({ ...valid, assumptions: { burdenM: 3.5 } })).toThrow(/burdenM/);
    });
    it("allows a text assumption, such as unconfirmed rock type, only with a source", () => {
        expect(() => validateScenario({ ...valid, assumptions: { rockType: { value: "unconfirmed", source: "no site geology" } } })).not.toThrow();
        expect(() => validateScenario({ ...valid, assumptions: { rockType: { value: "unconfirmed" } } })).toThrow(/rockType/);
    });
    it("rejects a surface with an unknown role", () => {
        expect(() => validateScenario({ ...valid, surfaces: [{ ...valid.surfaces[0], role: "rock" }] })).toThrow(/role/);
    });
});

describe("scenario files", () => {
    it("round-trips surfaces through sidecars without changing a value", () => {
        const dir = mkdtempSync(join(tmpdir(), "scenario-"));
        writeScenario(dir, valid);
        const back = readScenario(dir);
        expect(Array.from(back.surfaces[0].pos)).toEqual(Array.from(valid.surfaces[0].pos));
        expect(back.surfaces[0].idx).toBeInstanceOf(Uint32Array);
        expect(back.surfaces[0].role).toBe("voxelblk");
        expect(back.assumptions.burdenM.range).toEqual([2.5, 4.5]);
    });
    it("refuses to write an invalid scenario", () => {
        const dir = mkdtempSync(join(tmpdir(), "scenario-"));
        expect(() => writeScenario(dir, { ...valid, holes: [] })).toThrow(/holes/);
    });
});

describe("toSimData", () => {
    it("loads into the simulator", () => {
        const sim = new BlastMovementSimulator({ seed: 1 }).load(toSimData(valid));
        expect(sim.holes.length).toBe(valid.holes.length);
    });
});

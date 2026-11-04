import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { parseKAP } from "../../src/io/KAPReader.js";
import { scenarioFromKap } from "../scenario/fromKap.js";

describe("scenarioFromKap", () => {
    let s;
    beforeAll(async () => {
        const parsed = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
        s = scenarioFromKap(parsed, { name: "swellfactor" });
    });

    it("keeps all 531 holes", () => {
        expect(s.holes.length).toBe(531);
    });
    it("keeps the blast volume and the surveyed muckpile", () => {
        expect(s.surfaces.some((x) => x.role === "voxelblk")).toBe(true);
        expect(s.surfaces.some((x) => x.role === "reference")).toBe(true);
    });
    it("marks the design as measured, with no assumptions and no twin", () => {
        expect(s.twin).toBeNull();
        expect(s.measured).toContain("holes");
        expect(s.assumptions).toEqual({});
    });
    it("gives every surface an id that is safe as a file name", () => {
        for (const surface of s.surfaces) expect(surface.id).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(new Set(s.surfaces.map((x) => x.id)).size).toBe(s.surfaces.length);
    });
});

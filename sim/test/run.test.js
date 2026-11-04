import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKAP } from "../../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import { computePPVDeck } from "../../src/vibration/PPVDeck.js";
import { evaluateReceptor, decksFromEntries } from "../../src/vibration/ReceptorPPV.js";
import { scenarioFromKap } from "../scenario/fromKap.js";
import { scenarioFromTerrain } from "../scenario/pattern.js";
import { writeScenario, toSimData } from "../scenario/io.js";
import { abstractReceptors, runFastModels } from "../run.js";

function terrainFrom(f, size = 120) {
    const z = new Float64Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) z[j * size + i] = f(i + 0.5, j + 0.5);
    const grid = (values) => ({ cols: size, rows: size, x0: 0, y0: 0, cell: 1, z: values });
    return { dtm: grid(z), filled: grid(new Float64Array(size * size)) };
}

// A bench 15 m high, with its crest at y = 60 and a lower floor to the south.
const bench = terrainFrom((x, y) => (y > 60 ? 115 : 100));
const polygon = [[40, 62], [80, 62], [80, 80], [40, 80]];
const benchScenario = () => scenarioFromTerrain(bench, polygon, { name: "bench", floorZ: 100, twinVersion: "test" });

describe("abstractReceptors", () => {
    it("makes rings around the centre, not real locations", () => {
        const r = abstractReceptors({ x: 10, y: 20, z: 5 });
        expect(r.length).toBe(32);
        expect(Math.hypot(r[0].x - 10, r[0].y - 20)).toBeCloseTo(100, 6);
        expect(r[0].distanceM).toBe(100);
        expect(new Set(r.map((p) => p.distanceM))).toEqual(new Set([100, 250, 500, 1000]));
    });
});

describe("runFastModels on SWELLFACTOR", () => {
    let parsed, swell, res;
    beforeAll(async () => {
        parsed = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
        swell = scenarioFromKap(parsed, { name: "swellfactor" });
        res = await runFastModels(swell, { seed: 7, maxVoxels: 2000 });
    }, 60000);

    it("matches a direct simulator run with the same seed", async () => {
        const sim = new BlastMovementSimulator({ seed: 7, maxVoxels: 2000 }).load(parsed);
        sim.generateVoxels();
        await sim.runAsync();
        expect(res.throw.comShift.D).toBeCloseTo(sim.results().comShift.D, 6);
        expect(res.throw.blockCount).toBe(sim.results().blockCount);
    }, 60000);
    it("marks results uncalibrated and swell as prescribed", () => {
        expect(res.calibration).toBe("uncalibrated");
        expect(res.throw.swellIsPrescribed).toBe(true);
    });
    it("reports the library's receptor evaluation", () => {
        const first = res.vibration[0];
        const direct = evaluateReceptor({ x: first.x, y: first.y, z: first.z }, decksFromEntries(swell.decks), { distanceMode: "3D", superposeRMS: true });
        expect(first.ppvMmS).toBeCloseTo(direct.ppvPerDelay, 6);
        expect(first.ppvMaxSingleDeckMmS).toBeCloseTo(direct.ppvMax, 6);
        expect(first.ppvRmsMmS).toBeCloseTo(direct.ppvRMS, 6);
        expect(first.dominantHoleID).toBe(direct.dominantHoleID);
    });
    it("agrees within 1% with the separate per-deck PPV model away from the charges", () => {
        const far = res.vibration.filter((v) => v.distanceM >= 250);
        expect(far.length).toBe(24);
        for (const v of far) {
            const other = computePPVDeck({ x: v.x, y: v.y, z: v.z }, swell.decks, {});
            expect(Math.abs(other - v.ppvMmS) / other).toBeLessThan(0.01);
        }
    });
    it("flags receptors at the site law's cap, where the number is not meaningful", () => {
        const capped = res.vibration.filter((v) => v.atSiteLawCap);
        expect(capped.length).toBeGreaterThan(0);
        for (const v of capped) {
            expect(v.distanceM).toBe(100);
            expect(v.ppvMmS).toBeCloseTo(1140, 6);
        }
        expect(res.vibration.filter((v) => v.distanceM >= 250).every((v) => !v.atSiteLawCap)).toBe(true);
    });
    it("vibration falls with distance", () => {
        const mean = (d) => {
            const at = res.vibration.filter((v) => v.distanceM === d);
            return at.reduce((sum, v) => sum + v.ppvMmS, 0) / at.length;
        };
        expect(mean(100)).toBeGreaterThan(mean(1000));
    });
    it("gives damage and flyrock results", () => {
        expect(res.damage.peakPpvMmS).toBeGreaterThan(0);
        expect(res.damage.atPoint).toHaveProperty("x");
        expect(res.flyrock.minSdob).toBeGreaterThan(0);
        expect(res.flyrock.band).toEqual(expect.any(String));
    });
    it("names library defaults when a scenario labels no constants", () => {
        expect(res.libraryDefaultsUsed).toEqual(expect.arrayContaining(["siteLawK", "siteLawB", "holmbergK", "holmbergAlpha", "holmbergBeta"]));
    });
    it("has no trench figure without a block cut from terrain", () => {
        expect(res.throw.belowOriginalGroundFraction).toBeNull();
    });
    it("reports an unsettled run as unsettled", async () => {
        const short = await runFastModels(swell, { seed: 7, maxVoxels: 500, overrides: { maxSimTimeS: 0.05 } });
        expect(short.throw.settled).toBe(false);
    }, 60000);
});

describe("runFastModels on a terrain-built scenario", () => {
    let s, res;
    beforeAll(async () => {
        s = benchScenario();
        res = await runFastModels(s, { seed: 3, maxVoxels: 1500 });
    }, 60000);

    it("uses the assumed site law and says so", () => {
        expect(res.assumptionsUsed.siteLawK).toEqual(s.assumptions.siteLawK);
        const direct = evaluateReceptor({ x: res.vibration[0].x, y: res.vibration[0].y, z: res.vibration[0].z }, decksFromEntries(s.decks), {
            K: s.assumptions.siteLawK.value, B: s.assumptions.siteLawB.value, distanceMode: "3D", superposeRMS: true,
        });
        expect(res.vibration[0].ppvMmS).toBeCloseTo(direct.ppvPerDelay, 6);
    });
    it("drops the ground plane to 5 m below the lowest terrain", () => {
        expect(res.throw.groundZ).toBeCloseTo(95, 6);
    });
    it("keeps rock on the terrain, not fallen through the block's floor", () => {
        // Floors in this scenario are at 100 m. The plane is at 95 m.
        expect(res.throw.lowestBlockZ).toBeGreaterThan(98);
    });
    it("reports flyrock as the McKenzie scaled depth of burial of the worst hole", () => {
        // Flat bench top, so the smallest value is the shortest-charged standard hole.
        let worst = Infinity;
        for (const h of s.holes) {
            const d = s.decks.find((k) => k.holeIndex === s.holes.indexOf(h));
            const chargeM = d.topZ - d.baseZ;
            const stem = h.collarZ - d.topZ;
            const contributing = Math.min(chargeM, 1.15);
            const hand = (stem + contributing / 2) / Math.cbrt((d.mass / chargeM) * contributing);
            worst = Math.min(worst, hand);
        }
        expect(res.flyrock.minSdob).toBeCloseTo(worst, 4);
    });
    it("reports how much of the rock came to rest", () => {
        expect(res.throw.restFraction).toBeGreaterThan(0.9);
        expect(res.throw.restFraction).toBeLessThanOrEqual(1);
    });
    it("records the time limit and how far the throw moved in the last second", () => {
        expect(res.throw.timeLimitS).toBeGreaterThan(12);
        expect(res.throw.throwDriftLastSecondM).toBeGreaterThanOrEqual(0);
        expect(res.throw.throwDriftLastSecondM).toBeLessThan(1);
    });
    it("reports the rock left in solid ground behind or beside the block", async () => {
        const sim = new BlastMovementSimulator({ seed: 3, maxVoxels: 1500, groundZ: 95 }).load(toSimData(s));
        sim.generateVoxels();
        await sim.runAsync();
        let inSolidGround = 0;
        for (let i = 0; i < sim.S.N; i++) {
            const x = sim.S.px[i] + sim.origin.x, y = sim.S.py[i] + sim.origin.y, z = sim.S.pz[i] + sim.origin.z;
            // Outside the block and north of the crest, the original ground is at 115 m.
            if ((x < 40 || x > 80 || y > 80) && y > 60.5 && z < 114) inSolidGround++;
        }
        const measured = inSolidGround / sim.S.N;
        expect(measured).toBeGreaterThan(0);
        expect(measured).toBeLessThan(0.1);
        // An upper estimate: it also counts rock on the sampled slope at the crest.
        expect(res.throw.belowOriginalGroundFraction).toBeGreaterThanOrEqual(measured);
        expect(res.throw.belowOriginalGroundFraction).toBeLessThan(0.2);
    }, 60000);
    it("passes rock density to the launch model and lists it as used", async () => {
        expect(res.assumptionsUsed.rockDensityKgM3).toEqual(s.assumptions.rockDensityKgM3);
        const light = scenarioFromTerrain(bench, polygon, { name: "bench", floorZ: 100, twinVersion: "test", overrides: { rockDensityKgM3: 2400 } });
        const other = await runFastModels(light, { seed: 3, maxVoxels: 1500 });
        expect(other.throw.comShift.D).not.toBe(res.throw.comShift.D);
    }, 60000);
    it("passes the labelled damage constants to the damage model", async () => {
        expect(res.assumptionsUsed.holmbergK).toEqual(s.assumptions.holmbergK);
        const strong = scenarioFromTerrain(bench, polygon, { name: "bench", floorZ: 100, twinVersion: "test", overrides: { holmbergK: 1400 } });
        const other = await runFastModels(strong, { seed: 3, maxVoxels: 200 });
        expect(other.damage.peakPpvMmS).toBeCloseTo(res.damage.peakPpvMmS * 2, 3);
    }, 60000);
    it("says which assumptions no model in this run used", () => {
        expect(res.assumptionsNotUsedByTheseModels).toEqual(expect.arrayContaining(["vodMs", "rockType"]));
        expect(res.assumptionsNotUsedByTheseModels).not.toContain("rockDensityKgM3");
    });
    it("responds to a design override", async () => {
        const stronger = scenarioFromTerrain(bench, polygon, { name: "bench", floorZ: 100, twinVersion: "test", overrides: { spacingM: 3 } });
        const other = await runFastModels(stronger, { seed: 3, maxVoxels: 1500 });
        expect(other.vibration[0].ppvMmS).not.toBe(res.vibration[0].ppvMmS);
    }, 60000);
});

describe("run-scenario CLI", () => {
    it("writes results.json", () => {
        const dir = mkdtempSync(join(tmpdir(), "scenario-"));
        const out = mkdtempSync(join(tmpdir(), "results-"));
        writeScenario(dir, benchScenario());
        execFileSync("node", ["scripts/run-scenario.mjs", dir, "--seed", "3", "--max-voxels", "800", "--out", out], { stdio: "pipe" });
        const res = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
        expect(res.calibration).toBe("uncalibrated");
        expect(res.scenario).toBe("bench");
        expect(res.vibration.length).toBe(32);
    }, 60000);
    it("exits with an error for a missing scenario", () => {
        expect(() => execFileSync("node", ["scripts/run-scenario.mjs", "/nonexistent"], { stdio: "pipe" })).toThrow();
    });
});

/**
 * The workers repeat physics from the main thread, and nothing tested them. These
 * tests run the real worker code with a stand-in `self` and compare the results.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createDeckEntry } from "../src/core/DeckEntry.js";
import { createHoleEntry } from "../src/core/HoleEntry.js";
import { computeBlairMinchinton } from "../src/vibration/BlairMinchinton.js";
import { binDecksByTime } from "../src/vibration/ReceptorPPV.js";
import { richardsMoore } from "../src/flyrock/FlyrockTrajectory.js";

const messages = [];
globalThis.self = { postMessage: (m) => messages.push(m) };

async function loadWorker(path) {
    delete globalThis.self.onmessage;
    await import(path);
    return globalThis.self.onmessage;
}

const hole = createHoleEntry({ collarX: 0, collarY: 0, collarZ: 0, toeX: 0, toeY: 0, toeZ: -13 });
const deck = (over = {}) => createDeckEntry({ topX: 0, topY: 0, topZ: -3, baseX: 0, baseY: 0, baseZ: -13, mass: 100, ...over });

describe("BlairHeavyWorker", () => {
    let send;
    beforeAll(async () => { send = await loadWorker("../src/workers/BlairHeavyWorker.js"); });

    function atX(x, decks, modelParams = {}) {
        messages.length = 0;
        send({ data: { type: "computeStrip", payload: {
            deckEntries: decks, holeEntries: [hole],
            gridParams: { minX: x, minY: 0, elevation: -8 },
            modelParams, startRow: 0, endRow: 1, totalCols: 1, totalRows: 1, actualCellX: 1, actualCellY: 1,
        } } });
        const done = messages.find((m) => m.type === "stripResult");
        if (!done) throw new Error(JSON.stringify(messages.at(-1)));
        return done.data.strip[0];
    }

    it("matches the main-thread model", () => {
        for (const x of [10, 30, 60]) {
            const worker = atX(x, [deck()]);
            const main = computeBlairMinchinton({ x, y: 0, z: -8 }, [deck()], [hole], {});
            expect(Math.abs(worker - main) / main, `x = ${x}`).toBeLessThan(0.05);
        }
    });
    it("does not silently return zero beyond 100 m", () => {
        expect(atX(150, [deck()])).toBeGreaterThan(0);
    });
    it("gives one element the same result wherever the primer is", () => {
        const at = (primerFraction) => atX(50, [deck({ primerFraction })], { elemsPerDeck: 1 });
        expect(at(0)).toBeCloseTo(at(1), 3);
        expect(at(0)).toBeCloseTo(at(0.5), 3);
    });
});

describe("FlyrockWorker", () => {
    it("reaches the clearance distance its safety factor implies", async () => {
        const send = await loadWorker("../src/workers/FlyrockWorker.js");
        const rm = richardsMoore({ holeDiamMm: 115, stemmingLength: 2.5, burden: 3.5, massPerMetre: 12, launchAngleDeg: 45, factorOfSafety: 2 });
        messages.length = 0;
        send({ data: { type: "generate", payload: {
            holeData: [{ cx: 0, cy: 0, cz: 0, maxDistance: rm.maxDistance, maxVelocity: rm.maxVelocity, holeID: "1" }],
            params: { iterations: 40, factorOfSafety: 2 },
        } } });
        const done = messages.find((m) => m.type === "result");
        if (!done) throw new Error(JSON.stringify(messages.at(-1)));
        let radius = 0;
        for (const t of done.data.triangles) for (const v of t.vertices) radius = Math.max(radius, Math.hypot(v.x, v.y));
        expect(Math.abs(radius - rm.maxDistance) / rm.maxDistance).toBeLessThan(0.1);
    });
});

describe("binDecksByTime", () => {
    it("reports a late deck's real time", () => {
        const bins = binDecksByTime([{ x: 0, y: 0, z: 0, Q: 1, fireMs: 200 }], 10);
        expect(bins[0].tCentreMs).toBeCloseTo(205, 6);
    });
});

describe("Blair-Minchinton time window", () => {
    it("covers the earliest arrival from an interior primer close in", () => {
        // A finer time grid over the whole arrival span must not raise the peak much.
        const decks = [deck({ primerFraction: 0.5 })];
        const coarse = computeBlairMinchinton({ x: 2, y: 0, z: -8 }, decks, [hole], { elemsPerDeck: 21 });
        const fine = computeBlairMinchinton({ x: 2, y: 0, z: -8 }, decks, [hole], { elemsPerDeck: 21, dtFactor: 0.05 });
        expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.1);
    });
});

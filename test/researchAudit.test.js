/**
 * Corrections from the research audit (docs/verification/). Expected values are
 * worked by hand from the cited source or basic mechanics, not from the code.
 */

import { describe, it, expect } from "vitest";
import { createDeckEntry } from "../src/core/DeckEntry.js";
import { createHoleEntry } from "../src/core/HoleEntry.js";
import { computeBoreholePressure } from "../src/pressure/BoreholePressure.js";
import { computePowderFactor } from "../src/pressure/PowderFactor.js";
import { computePPV } from "../src/vibration/PPV.js";
import { computePPVDeck } from "../src/vibration/PPVDeck.js";
import { evaluateReceptor, decksFromEntries } from "../src/vibration/ReceptorPPV.js";
import { computeScaledHeelan } from "../src/vibration/ScaledHeelan.js";
import { computeScaledHeelanBlair } from "../src/vibration/ScaledHeelanBlair.js";
import { computeHeelanOriginal } from "../src/vibration/HeelanOriginal.js";
import { computeBlairMinchinton } from "../src/vibration/BlairMinchinton.js";
import { richardsMoore } from "../src/flyrock/FlyrockTrajectory.js";
import { generateFlyrockShroud } from "../src/flyrock/FlyrockShroud.js";
import { parseInstantelCSV } from "../src/io/MonitorCSV.js";
import { createParticleState, ST_ACTIVE } from "../src/movement/SphereDEM.js";
import { swellEmergent } from "../src/movement/Displacement.js";

const deck = (over = {}) => createDeckEntry({ topX: 0, topY: 0, topZ: -3, baseX: 0, baseY: 0, baseZ: -13, mass: 100, ...over });
const hole = createHoleEntry({ collarX: 0, collarY: 0, collarZ: 0, toeX: 0, toeY: 0, toeZ: -13 });

describe("borehole pressure", () => {
    const anfo = { density: 0.85, vod: 4300, holeDiamMm: 48 };

    it("reads Pb = rho VOD^2 / 8 at the hole wall", () => {
        const got = computeBoreholePressure({ x: 0.024, y: 0, z: -8 }, [deck(anfo)], {});
        expect(got).toBeCloseTo((850 * 4300 ** 2) / 8 / 1e6, 1); // 1964.6 MPa
    });
    it("falls as (a/R)^2 away from the wall", () => {
        const got = computeBoreholePressure({ x: 0.24, y: 0, z: -8 }, [deck(anfo)], {});
        expect(got).toBeCloseTo(1964.6 / 100, 1);
    });
    it("reproduces Iverson & Hustrulid's decoupled case, 598 MPa", () => {
        const d = deck({ ...anfo, deckType: "DECOUPLED", chargeDiamMm: 34 });
        expect(computeBoreholePressure({ x: 0.024, y: 0, z: -8 }, [d], {})).toBeCloseTo(598.8, 0);
    });
});

describe("charge concentration", () => {
    it("divides deck mass by the capsule around the column", () => {
        // 100 kg over 10 m, at R = 1 m: pi * 1 * 10 + (4/3) * pi = 35.6047 m3.
        const got = computePowderFactor({ x: 1, y: 0, z: -8 }, [deck()], {});
        expect(got).toBeCloseTo(100 / (Math.PI * 10 + (4 / 3) * Math.PI), 4);
    });
});

describe("site law charge per delay", () => {
    // Two 100 kg decks firing together 1 m apart, seen from 100 m: W is 200 kg per delay.
    const pair = [deck({ timingMs: 0 }), deck({ topX: 1, baseX: 1, timingMs: 0, holeIndex: 1 })];
    const apart = [deck({ timingMs: 0 }), deck({ topX: 1, baseX: 1, timingMs: 50, holeIndex: 1 })];
    const point = { x: 101, y: 0, z: -8 };
    const nearest = 100;
    const hand = 1140 * Math.pow(nearest / Math.sqrt(200), -1.6);
    const single = 1140 * Math.pow(nearest / Math.sqrt(100), -1.6);

    it("computePPV adds charges firing together", () => {
        expect(computePPV(point, pair, {})).toBeCloseTo(hand, 6);
    });
    it("computePPV keeps charges 50 ms apart separate", () => {
        expect(computePPV(point, apart, {})).toBeCloseTo(single, 6);
    });
    it("computePPVDeck adds charges firing together", () => {
        expect(computePPVDeck(point, pair, {})).toBeCloseTo(hand, 6);
    });
    it("ReceptorPPV reports charge per delay", () => {
        expect(evaluateReceptor(point, decksFromEntries(pair), { distanceMode: "3D" }).ppvPerDelay).toBeCloseTo(hand, 6);
    });
    it("the delay window can be turned off to get per-deck values", () => {
        expect(computePPV(point, pair, { delayWindowMs: null })).toBeCloseTo(single, 6);
    });
});

describe("no unsourced cut-off below the toe plane", () => {
    const below = { x: 200, y: 0, z: -23 };
    const siteLaw = 1140 * Math.pow(Math.hypot(200, 15) / 10, -1.6);

    it.each([
        ["ScaledHeelan", computeScaledHeelan],
        ["ScaledHeelanBlair", computeScaledHeelanBlair],
        ["HeelanOriginal", computeHeelanOriginal],
    ])("%s stays the same order as the site law 10 m below the toe at 200 m", (_, model) => {
        const got = model(below, [deck()], [hole], {});
        expect(got).toBeGreaterThan(siteLaw / 10);
    });
});

describe("Blair-Minchinton charge increments", () => {
    it("gives one element the same result wherever the primer is", () => {
        const at = (primerFraction) => computeBlairMinchinton({ x: 50, y: 0, z: -8 }, [deck({ primerFraction })], [hole], { elemsPerDeck: 1 });
        expect(at(0)).toBeCloseTo(at(1), 6);
        expect(at(0)).toBeCloseTo(at(0.5), 6);
    });
});

describe("flyrock shroud", () => {
    it("reaches the clearance distance its safety factor implies", () => {
        const rm = richardsMoore({ holeDiamMm: 115, stemmingLength: 2.5, burden: 3.5, massPerMetre: 12, launchAngleDeg: 45, factorOfSafety: 2 });
        const holeData = [{ cx: 0, cy: 0, cz: 0, maxDistance: rm.maxDistance, maxVelocity: rm.maxVelocity, holeID: "1" }];
        const shroud = generateFlyrockShroud(holeData, { iterations: 40, factorOfSafety: 2 }, () => {});
        let radius = 0;
        for (const t of shroud.triangles) {
            for (const v of t.vertices) radius = Math.max(radius, Math.hypot(v.x, v.y));
        }
        expect(Math.abs(radius - rm.maxDistance) / rm.maxDistance).toBeLessThan(0.1);
    });
});

describe("monitor units", () => {
    const csv = (units) => `"SampleRate","1024"\n"Units","${units}"\nTran,Vert,Long\n1,2,3\n4,5,6\n`;

    it("keeps mm/s as is", () => {
        expect(parseInstantelCSV(csv("mm/s")).channels.Tran[0]).toBeCloseTo(1, 6);
    });
    it("converts in/s to mm/s", () => {
        expect(parseInstantelCSV(csv("in/s")).channels.Vert[1]).toBeCloseTo(5 * 25.4, 4);
    });
    it("rejects units it can't convert", () => {
        expect(() => parseInstantelCSV(csv("furlongs"))).toThrow(/furlongs/);
    });
});

describe("emergent swell", () => {
    it("reads about 1 for an undisturbed lattice", () => {
        const res = 2, n = 12, layers = 5;
        const S = createParticleState(n * n * layers);
        S.baseR = 0.47 * res;
        S.radius = S.baseR;
        let k = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let l = 0; l < layers; l++, k++) {
            S.px[k] = i * res + 1; S.py[k] = j * res + 1; S.pz[k] = l * res + 1;
            S.baseRad[k] = S.rad[k] = S.baseR;
            S.state[k] = ST_ACTIVE;
        }
        const swell = swellEmergent(S);
        expect(swell).toBeGreaterThan(0.75);
        expect(swell).toBeLessThan(1.25);
    });
});

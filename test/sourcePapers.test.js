/**
 * Checks against the papers themselves. Expected values are printed in the source
 * or worked from its equations by hand; none come from the code being checked.
 *
 * Moore & Richards (2005), Terrock report KCG-0503.
 * McKenzie (2018), Flyrock Model Validation, ISEE Australia.
 * Yang & Kavetsky (1990), Int. J. Mining and Geological Engineering 8, 13-34.
 */

import { describe, it, expect } from "vitest";
import { richardsMoore, lundborg, mckenzie } from "../src/flyrock/FlyrockTrajectory.js";
import { ballisticApex, ballisticRange, velocityForRange } from "../src/flyrock/Ballistics.js";
import { sdobRiskBand } from "../src/flyrock/SDoB.js";
import { createParticleState } from "../src/movement/SphereDEM.js";
import { assignYangVelocities, prepareChargeElements, simHolesFromEntries, PE_SCALE } from "../src/movement/InitialVelocity.js";
import { createDeckEntry } from "../src/core/DeckEntry.js";
import { createHoleEntry } from "../src/core/HoleEntry.js";

const G_REPORT = 9.8;
const within = (got, want, tolerance) => expect(Math.abs(got - want) / want).toBeLessThan(tolerance);

describe("Moore & Richards (2005)", () => {
    // 165 mm hole with s.g. 1.15 explosive: pi * 0.0825^2 * 1150 = 24.6 kg/m, as printed.
    const hole = { holeDiamMm: 165, explosiveDensity: 1.15, burden: 100, factorOfSafety: 1 };

    it("gets a 50 m throw from the printed k of 17.2 at 4.1 m stemming", () => {
        within(richardsMoore({ ...hole, stemmingLength: 4.1, K: 17.2 }).cratering, 50, 0.02);
    });
    it("gets a 50 m throw from the printed k of 22.3 at 5.0 m stemming", () => {
        within(richardsMoore({ ...hole, stemmingLength: 5.0, K: 22.3 }).cratering, 50, 0.02);
    });
    it("reproduces the report's kg per metre charge", () => {
        within(richardsMoore({ ...hole, stemmingLength: 4.1, K: 17.2 }).massPerMetre, 24.6, 0.005);
    });
    it("scales clearance by the factor of safety", () => {
        const one = richardsMoore({ ...hole, stemmingLength: 4.1, K: 17.2 });
        const two = richardsMoore({ ...hole, stemmingLength: 4.1, K: 17.2, factorOfSafety: 2 });
        expect(two.cratering).toBeCloseTo(2 * one.cratering, 6);
    });
    it("needs the printed launch speeds for a 95 m throw", () => {
        within(velocityForRange(95, 45, G_REPORT), 30.5, 0.002);
        within(velocityForRange(95, 75, G_REPORT), 43.1, 0.002);
    });
    it("reaches the printed heights", () => {
        within(ballisticApex(30.5, 45, G_REPORT), 23.7, 0.005);
        within(ballisticApex(43.1, 75, G_REPORT), 88.4, 0.005);
    });
    it.each([[10, 92], [30, 86], [40, 82], [50, 79], [60, 74], [70, 69], [80, 62]])(
        "at 75 degrees lands %d m above the blast near the printed %d m", (height, printed) => {
            within(ballisticRange(43.1, 75, -height, G_REPORT), printed, 0.015);
        });
});

describe("Lundborg, as stated by McKenzie (2018) in inches and metres", () => {
    const tenInches = 254;
    it("crater range is 260 x Dia^(2/3)", () => {
        within(lundborg({ holeDiamMm: tenInches, lundborgCondition: "crater", factorOfSafety: 1 }).rangeMax, 260 * 10 ** (2 / 3), 0.01);
    });
    it("bench range is about 40 x Dia^(2/3)", () => {
        within(lundborg({ holeDiamMm: tenInches, lundborgCondition: "bench", factorOfSafety: 1 }).rangeMax, 40 * 10 ** (2 / 3), 0.01);
    });
});

describe("McKenzie (2018) summary slide", () => {
    const hole = { holeDiamMm: 115, stemmingLength: 2.5, chargeLength: 10, explosiveDensity: 1.15, factorOfSafety: 2 };
    const r = mckenzie(hole);

    it("range is within 3% of 10 x SDoB^-2.167 x dia^0.667, the printed rounding", () => {
        within(r.rangeMax, 10 * r.sDoB ** -2.167 * 115 ** 0.667, 0.03);
    });
    it("fragment size is within 4% of 3.1 x SDoB^-2.167 x dia^0.667 x 2.6/rho", () => {
        within(r.fragmentSizeMm, 3.1 * r.sDoB ** -2.167 * 115 ** 0.667, 0.04);
    });
    it("velocity coefficient follows the printed fit, 0.0728 x^-3.2508", () => {
        within(r.kv, 0.0728 * r.sDoB ** -3.2508, 0.001);
    });
    it("clearance is FoS x range", () => {
        expect(r.clearanceDistance).toBeCloseTo(2 * r.rangeMax, 6);
    });
});

describe("Chiappetta scaled depth of burial chart, in McKenzie (2018)", () => {
    it.each([
        [0.5, "veryHigh"], // 0 - 0.60: crater, uncontrolled energy
        [0.8, "high"],     // up to 0.88: ejection with some fallback
        [1.2, "moderate"], // 0.92 - 1.40: mounding, controlled energy
        [1.6, "low"],      // up to 1.80: very controlled energy
        [2.5, "veryLow"],  // minimal surface effects
    ])("SDoB %d is band %s", (sdob, key) => {
        expect(sdobRiskBand(sdob).key).toBe(key);
    });
});

describe("Yang & Kavetsky (1990)", () => {
    const hole = createHoleEntry({ collarX: 0, collarY: 0, collarZ: 0, toeX: 0, toeY: 0, toeZ: -20, holeDiamMm: 200 });
    const deck = createDeckEntry({ topX: 0, topY: 0, topZ: -5, baseX: 0, baseY: 0, baseZ: -15, mass: 300, density: 1.0, holeDiamMm: 200 });

    function launch(x, params) {
        const holes = simHolesFromEntries([hole], [deck], {});
        const { bin } = prepareChargeElements(holes);
        holes[0].thDirX = 0; holes[0].thDirY = 0; // no steering: the paper's velocity alone
        const S = createParticleState(1);
        S.ox[0] = x; S.oy[0] = 0; S.oz[0] = -10;
        S.nearH[0] = 0;
        assignYangVelocities(S, { x: 0, y: 0, z: 0 }, holes, bin, { jitter: 0, cSteer: 0, ...params }, () => 0.5);
        return { vx: S.ivx[0], vz: S.ivz[0], speed: Math.hypot(S.ivx[0], S.ivy[0], S.ivz[0]) };
    }

    // Eq 12: V = sum over the charge of Pe (X - Xe) dl / r^(2 Pr), so b = 2 Pr - 1.
    // The library's Pe is multiplied by PE_SCALE and charge mass per metre (rho d^2 / 4).
    function eq12(x, Pe, b) {
        const perMetre = PE_SCALE * Pe * (1000 * 0.2 * 0.2) / 4;
        const steps = 20000, dl = 10 / steps;
        let vx = 0;
        for (let n = 0; n < steps; n++) {
            const z = -5 - (n + 0.5) * dl;
            vx += (perMetre * x * dl) / Math.hypot(x, -10 - z) ** (b + 1);
        }
        return vx;
    }

    it.each([[3, 1.5], [5, 1.5], [5, 1.7], [8, 1.7]])("matches Eq 12 by integration at x = %d, b = %d", (x, b) => {
        within(launch(x, { bExp: b, Pe: 1 }).vx, eq12(x, 1, b), 0.02);
    });
    it("is linear in Pe, as Eq 8 requires", () => {
        within(launch(5, { Pe: 2 }).speed, 2 * launch(5, { Pe: 1 }).speed, 1e-9);
    });
    it("has no net vertical velocity at mid-column, by Eq 14", () => {
        const { vx, vz } = launch(5, {});
        expect(Math.abs(vz)).toBeLessThan(0.01 * Math.abs(vx));
    });
});

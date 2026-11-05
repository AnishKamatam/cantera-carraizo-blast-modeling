/**
 * Launch velocities after Yang & Kavetsky (1990), Int. J. Mining and Geological
 * Engineering 8, 13-34. Expected values are worked from the paper's equations by hand
 * or by independent integration here, never read back from the implementation.
 */
import { describe, it, expect } from "vitest";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import {
    YANG1990_DEFAULTS, YANG_DEFAULTS, assignYangVelocities, chargeVelocity1990, confinementFactor, delayFactor,
    holeChargeSegments, buildRockGrid, freeDistance, prepareChargeElements, simHolesFromEntries,
} from "../../src/movement/InitialVelocity.js";
import { computeThrowDirections, firingRows } from "../../src/movement/ThrowDirections.js";
import { createParticleState } from "../../src/movement/SphereDEM.js";
import { createDeckEntry } from "../../src/core/DeckEntry.js";
import { createHoleEntry } from "../../src/core/HoleEntry.js";

const within = (got, want, tolerance) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tolerance * Math.abs(want));

function box(id, role, x0, x1, y0, y1, z0, z1) {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    return { id, name: id, role, pos: new Float64Array(P.flat()), idx: new Uint32Array(F.flat()), np: 8, nt: 12 };
}

/**
 * A 20 x 16 x 10 m block with its free face at x = 20. Rows at x = 16, 12, 8, four holes
 * each. `timing(x, y, rowIndex)` gives each hole's fire time in ms.
 */
function bench(timing, density = 1.15) {
    const holes = [], decks = [];
    [16, 12, 8].forEach((x, row) => {
        [2, 6, 10, 14].forEach((y) => {
            const holeIndex = holes.length;
            const t = timing(x, y, row);
            holes.push({ ...createHoleEntry({ holeID: String(holeIndex), collarX: x, collarY: y, collarZ: 10, toeX: x, toeY: y, toeZ: 0, holeDiamMm: 165, benchHeight: 10, holeTime: t }), burden: 4, spacing: 4 });
            decks.push(createDeckEntry({ topX: x, topY: y, topZ: 7, baseX: x, baseY: y, baseZ: 0, mass: 200, density, timingMs: t, holeIndex }));
        });
    });
    return { holes, decks, surfaces: [box("v", "voxelblk", 0, 20, 0, 16, 0, 10)] };
}

function launched(data, options = {}) {
    const sim = new BlastMovementSimulator({ seed: 1, voxelRes: 1, maxVoxels: 8000, velocityModel: "yang1990", ...options }).load(data);
    sim.generateVoxels();
    const blocks = [];
    const S = sim.S, o = sim.origin;
    for (let i = 0; i < S.N; i++) {
        blocks.push({ x: S.ox[i] + o.x, y: S.oy[i] + o.y, z: S.oz[i] + o.z, vx: S.ivx[i], vy: S.ivy[i], vz: S.ivz[i], at: S.at[i] });
    }
    return { sim, blocks };
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const midLateral = (b) => b.y > 5 && b.y < 11;

describe("Eq 12-14: velocity from a charge column", () => {
    // A 10 m vertical column from z = -5 to -15. Pe = 55, Pr = 1.35, ANFO density.
    const hole = { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: -20, diameter: 0.2, explDecks: [{ top: 5, base: 15, rho: 850 }] };
    const segments = holeChargeSegments(hole, 0.02);
    const params = { PeAnfo: 55, Pr: 1.35, rhoAnfo: 850, rMin: 0.01 };

    function integrate(x, z, Pe, Pr) {
        let vx = 0, vz = 0;
        const steps = 200000, dl = 10 / steps;
        for (let n = 0; n < steps; n++) {
            const ze = -5 - (n + 0.5) * dl;
            const denominator = (x * x + (z - ze) ** 2) ** Pr;
            vx += (Pe * x * dl) / denominator;
            vz += (Pe * (z - ze) * dl) / denominator;
        }
        return { vx, vz };
    }

    it("the segments add up to the whole charge length", () => {
        within(segments.reduce((sum, s) => sum + s.dl, 0), 10, 1e-9);
    });
    it("matches integration at mid-column, with no net vertical velocity", () => {
        const v = chargeVelocity1990(5, 0, -10, segments, params);
        within(v.x, integrate(5, -10, 55, 1.35).vx, 0.001);
        expect(Math.abs(v.z)).toBeLessThan(1e-6);
    });
    it("matches integration above the column, moving up and out", () => {
        const v = chargeVelocity1990(5, 0, -2, segments, params);
        const want = integrate(5, -2, 55, 1.35);
        within(v.x, want.vx, 0.001);
        within(v.z, want.vz, 0.001);
        expect(v.z).toBeGreaterThan(0);
    });
    it("is linear in Pe, and falls as Pr rises", () => {
        within(chargeVelocity1990(5, 0, -10, segments, { ...params, PeAnfo: 110 }).x, 2 * chargeVelocity1990(5, 0, -10, segments, params).x, 1e-12);
        expect(chargeVelocity1990(5, 0, -10, segments, { ...params, Pr: 1.5 }).x).toBeLessThan(chargeVelocity1990(5, 0, -10, segments, params).x);
    });
    it("Eq 8: one segment gives Pe dl / r^(2 Pr - 1), by hand", () => {
        const v = chargeVelocity1990(3, 4, 0, [{ x: 0, y: 0, z: 0, dl: 0.5, rho: 850 }], params);
        const speed = (55 * 0.5) / 5 ** 1.7; // r = 5
        within(Math.hypot(v.x, v.y, v.z), speed, 1e-12);
        within(v.x, speed * 0.6, 1e-12);
        within(v.y, speed * 0.8, 1e-12);
    });
});

describe("near-charge limit", () => {
    const one = [{ x: 0, y: 0, z: 0, dl: 0.5, rho: 850 }];
    const params = { PeAnfo: 55, Pr: 1.35, rhoAnfo: 850, rMin: 1 };

    it("holds speed at the value for r = rMin, in the same direction", () => {
        const limit = (55 * 0.5) / 1 ** 1.7;
        const v = chargeVelocity1990(0.1, 0, 0, one, params);
        within(v.x, limit, 1e-12);
        expect(v.y).toBe(0);
    });
    it("does nothing beyond rMin", () => {
        const v = chargeVelocity1990(2, 0, 0, one, params);
        within(v.x, (55 * 0.5) / 2 ** 1.7, 1e-12);
    });
    it("gives zero, not NaN, exactly on a segment", () => {
        expect(chargeVelocity1990(0, 0, 0, one, params)).toEqual({ x: 0, y: 0, z: 0 });
    });
    it("defaults to the block's half-width", () => {
        const { sim } = launched(bench((x, y, row) => row * 42));
        expect(sim.S.launchDiag.rMinM).toBeCloseTo(sim.actualRes / 2, 6);
    });
    it("keeps every block's speed finite at the paper's Pe", () => {
        const { blocks } = launched(bench((x, y, row) => row * 42));
        for (const b of blocks) expect(Number.isFinite(Math.hypot(b.vx, b.vy, b.vz))).toBe(true);
    });
});

describe("Eq 21: explosive density", () => {
    const hole = (rho) => ({ cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: -20, diameter: 0.2, explDecks: [{ top: 5, base: 15, rho }] });
    const params = { PeAnfo: 55, Pr: 1.35, rhoAnfo: 850, rMin: 0.01 };

    it("ANFO takes Pe unchanged, and doubling density scales speed by sqrt 2", () => {
        const anfo = chargeVelocity1990(5, 0, -10, holeChargeSegments(hole(850), 0.1), params);
        const heavy = chargeVelocity1990(5, 0, -10, holeChargeSegments(hole(1700), 0.1), params);
        within(heavy.x / anfo.x, Math.SQRT2, 1e-12);
    });
    it("reproduces the paper's own Pe pair: HEF at 69.6 against ANFO at 55 means rho ratio 1.60", () => {
        const ratio = (69.6 / 55) ** 2;
        within(ratio, 1.601, 0.001);
        const anfo = chargeVelocity1990(5, 0, -10, holeChargeSegments(hole(850), 0.1), params);
        const hef = chargeVelocity1990(5, 0, -10, holeChargeSegments(hole(850 * ratio), 0.1), params);
        within(hef.x / anfo.x, 69.6 / 55, 1e-9);
    });
    it("carries through the simulator", () => {
        const light = launched(bench((x, y, row) => row * 42, 0.85)).blocks;
        const heavy = launched(bench((x, y, row) => row * 42, 1.7)).blocks;
        const k = light.findIndex((b) => b.x > 17 && midLateral(b) && b.z > 4 && b.z < 6);
        within(Math.hypot(heavy[k].vx, heavy[k].vy, heavy[k].vz) / Math.hypot(light[k].vx, light[k].vy, light[k].vz), Math.SQRT2, 1e-5);
    });
});

describe("Eq 15-18 factors by hand", () => {
    it("Eq 15-17: exp(-C1 D), C1 = 0.2", () => {
        expect(YANG1990_DEFAULTS.C1).toBe(0.2);
        expect(confinementFactor(5, 0.2)).toBeCloseTo(Math.exp(-1), 12);
        expect(confinementFactor(0, 0.2)).toBe(1);
    });
    it("D = infinity when confined, as the paper sets it, gives no velocity", () => {
        expect(confinementFactor(Infinity, 0.2)).toBe(0);
    });
    it("Eq 18: exp(-Pd n / Td), Pd = 0.01; a front row (n = 0) is untouched", () => {
        expect(YANG1990_DEFAULTS.Pd).toBe(0.01);
        expect(delayFactor(0.01, 3, 0.042)).toBeCloseTo(Math.exp(-0.03 / 0.042), 12);
        expect(delayFactor(0.01, 0, 0.042)).toBe(1);
    });
    it("Eq 18 keeps more horizontal velocity at longer delay", () => {
        expect(delayFactor(0.01, 3, 0.1)).toBeGreaterThan(delayFactor(0.01, 3, 0.025));
    });
    it("uses the paper's calibrated case-study values as labelled defaults", () => {
        expect(YANG1990_DEFAULTS.PeAnfo).toBe(55);
        expect(YANG1990_DEFAULTS.Pr).toBe(1.35);
    });
});

describe("free distance through rock not yet fired", () => {
    // Rock from x = 0 to 9 at 1 m cells; x >= 5 fires at t = 0, the rest at t = 1.
    const positions = [];
    const times = [];
    for (let i = 0; i < 10; i++) { positions.push(i + 0.5, 0.5, 0.5); times.push(i >= 5 ? 0 : 1); }
    const grid = buildRockGrid(positions, times, 1);

    it("ends at earlier-firing rock, which has moved", () => {
        expect(freeDistance(grid, 0.5, 0.5, 0.5, 1, 0, 0, 0.5)).toBeCloseTo(4.5, 0);
    });
    it("ends at the edge of the rock", () => {
        expect(freeDistance(grid, 7.5, 0.5, 0.5, 1, 0, 0, -0.5)).toBeCloseTo(2.5, 0);
    });
    it("is infinite at the edge of the rock when air there doesn't count as free", () => {
        expect(freeDistance(grid, 7.5, 0.5, 0.5, 1, 0, 0, -0.5, false)).toBe(Infinity);
        expect(freeDistance(grid, 0.5, 0.5, 0.5, 1, 0, 0, 0.5, false)).toBeCloseTo(4.5, 0);
    });
});

describe("firing rows from fire time", () => {
    const holes = (timing) => {
        const out = [];
        [16, 12, 8].forEach((x, row) => [2, 6, 10, 14].forEach((y) => out.push({ cx: x, cy: y, fireT: timing(x, y, row) / 1000 })));
        return out;
    };
    it("counts rows in front and finds the inter-row delay", () => {
        const h = holes((x, y, row) => row * 42);
        computeThrowDirections(h);
        const rows = firingRows(h);
        expect(Array.from(rows.rowsInFront)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
        expect(rows.delayS).toBeCloseTo(0.042, 9);
    });
    it("doesn't count a hole firing earlier in the same row", () => {
        const h = holes((x, y, row) => row * 100 + y * 2); // 8 ms between holes along each row
        computeThrowDirections(h);
        const rows = firingRows(h);
        expect(Array.from(rows.rowsInFront)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
        expect(rows.delayS).toBeCloseTo(0.1, 9);
    });
    it("has no rows in front when everything fires together", () => {
        const h = holes(() => 0);
        computeThrowDirections(h);
        expect(Array.from(firingRows(h).rowsInFront)).toEqual(new Array(12).fill(0));
    });
});

describe("launch behind velocityModel: 'yang1990'", () => {
    const rows = (delay) => (x, y, row) => row * delay;
    const nearFaceBlock = (b, x0, x1) => b.x > x0 && b.x < x1 && midLateral(b);
    const horizontal = (b) => Math.hypot(b.vx, b.vy);

    it("launches the first row faster than rock with no relief behind the last row", () => {
        const { blocks } = launched(bench(rows(42)));
        const first = mean(blocks.filter((b) => nearFaceBlock(b, 16, 20)).map(horizontal));
        const confined = mean(blocks.filter((b) => nearFaceBlock(b, 0, 7)).map(horizontal));
        expect(first).toBeGreaterThan(1);
        expect(first).toBeGreaterThan(5 * confined);
    });
    it("launches the first row faster horizontally than the rows behind it, with the same relief", () => {
        const { blocks } = launched(bench(rows(42)));
        const speed = (x0, x1) => mean(blocks.filter((b) => nearFaceBlock(b, x0, x1)).map(horizontal));
        expect(speed(16, 20)).toBeGreaterThan(speed(12, 16));
        expect(speed(12, 16)).toBeGreaterThan(speed(8, 12));
    });
    it("Eq 15: horizontal speed falls with distance to relief at the same charge distance", () => {
        // Two blocks 2 m in front of a row, at the same place: relief 4 m nearer in one case.
        const near = launched(bench(rows(42))).blocks;
        const far = launched(bench((x, y, row) => (row === 1 ? 42 : row === 0 ? 42 : 84))).blocks; // rows 0, 1 together
        const pick = (list) => list.find((b) => b.x > 13.6 && b.x < 14.6 && midLateral(b) && b.z > 3 && b.z < 5);
        expect(horizontal(pick(near))).toBeGreaterThan(horizontal(pick(far)));
    });
    it("launches each block when its own row fires", () => {
        const { blocks } = launched(bench(rows(42)));
        for (const b of blocks.filter((q) => q.x > 16.5)) expect(b.at).toBeCloseTo(0, 6);
        for (const b of blocks.filter((q) => q.x > 12.5 && q.x < 15.5)) expect(b.at).toBeCloseTo(0.042, 6);
        for (const b of blocks.filter((q) => q.x > 8.5 && q.x < 11.5)) expect(b.at).toBeCloseTo(0.084, 6);
    });
    it("Eq 18: a longer delay raises later rows' horizontal speed by exactly the delay factor", () => {
        const short = launched(bench(rows(25))).blocks;
        const long = launched(bench(rows(100))).blocks;
        const pick = (x0, x1) => short.findIndex((b) => nearFaceBlock(b, x0, x1) && b.z > 4 && b.z < 6);
        const k2 = pick(8, 12), k1 = pick(12, 16), k0 = pick(16, 20);
        const ratio = (n) => Math.exp((-0.01 * n) / 0.1) / Math.exp((-0.01 * n) / 0.025);
        within(long[k2].vx / short[k2].vx, ratio(2), 1e-4);
        within(long[k1].vx / short[k1].vx, ratio(1), 1e-4);
        within(long[k0].vx / short[k0].vx, 1, 1e-4); // the front row has no rows in front
        expect(long[k2].vx).toBeGreaterThan(short[k2].vx);
    });
    it("shorter delays favour vertical over horizontal motion, as the paper says", () => {
        const ratio = (delay) => {
            const later = launched(bench(rows(delay))).blocks.filter((b) => b.x > 8 && b.x < 16 && b.z > 6);
            return mean(later.map((b) => Math.abs(b.vz))) / mean(later.map(horizontal));
        };
        const r25 = ratio(25), r42 = ratio(42), r100 = ratio(100);
        expect(r25).toBeGreaterThan(r42);
        expect(r42).toBeGreaterThan(r100);
    });
    it("leaves vertical speed alone when delay changes (Eq 18 acts on Vh only)", () => {
        const short = launched(bench(rows(25))).blocks;
        const long = launched(bench(rows(100))).blocks;
        const k = short.findIndex((b) => b.x > 9 && b.x < 11 && midLateral(b) && b.z > 8);
        within(long[k].vz, short[k].vz, 1e-5);
    });
    it("Eq 17: higher blocks, nearer the surface, get a larger share of vertical velocity", () => {
        const { blocks } = launched(bench(rows(42)));
        const ups = blocks.filter((b) => nearFaceBlock(b, 17, 19) && b.z > 8.5).map((b) => b.vz);
        expect(mean(ups)).toBeGreaterThan(0);
        const toes = blocks.filter((b) => nearFaceBlock(b, 17, 19) && b.z < 1.5).map((b) => Math.abs(b.vz));
        expect(mean(ups)).toBeGreaterThan(mean(toes));
    });
    it("fires toward the relief: reversing the timing reverses the throw", () => {
        const forward = launched(bench(rows(42))).blocks;
        const back = launched(bench((x, y, row) => (2 - row) * 42)).blocks;
        expect(mean(forward.map((b) => b.vx))).toBeGreaterThan(0.5);
        expect(mean(back.map((b) => b.vx))).toBeLessThan(-0.5);
    });
    it("firing direction follows the initiation pattern, not the hole layout", () => {
        // Same holes, echelon timing: t = (16 - x) 10.5 + y 10.5, so -grad t points along (+1, -1).
        const echelon = launched(bench((x, y) => (16 - x) * 10.5 + y * 10.5)).blocks;
        const straight = launched(bench(rows(42))).blocks;
        const bearingOf = (list) => {
            const m = list.filter((b) => b.x > 8 && b.x < 16);
            return (Math.atan2(mean(m.map((b) => b.vy)), mean(m.map((b) => b.vx))) * 180) / Math.PI;
        };
        expect(Math.abs(bearingOf(straight))).toBeLessThan(10);
        expect(bearingOf(echelon)).toBeLessThan(-25);
        expect(bearingOf(echelon)).toBeGreaterThan(-65);
    });
    it("flanks stay confined unless the side is declared free", () => {
        const y = (b) => b.y > 15 && b.x > 16;
        const shut = launched(bench(rows(42))).blocks.filter(y);
        const open = launched(bench(rows(42)), { sideFreeFace: true }).blocks.filter(y);
        expect(mean(open.map((b) => Math.abs(b.vy)))).toBeGreaterThan(mean(shut.map((b) => Math.abs(b.vy))));
        expect(mean(shut.map((b) => Math.abs(b.vy)))).toBeLessThan(1e-9);
    });
    it("caps speed only when asked, and counts how often", () => {
        const none = launched(bench(rows(42)));
        expect(none.sim.S.launchDiag.cappedShare).toBe(0);
        const fastest = Math.max(...none.blocks.map((b) => Math.hypot(b.vx, b.vy, b.vz)));
        const capped = launched(bench(rows(42)), { maxLaunchSpeed: fastest / 2 });
        expect(capped.sim.S.launchDiag.cappedShare).toBeGreaterThan(0);
        const top = Math.max(...capped.blocks.map((b) => Math.hypot(b.vx, b.vy, b.vz)));
        within(top, fastest / 2, 1e-5);
    });
    it("is repeatable with a seed, launch and final positions both", () => {
        const go = () => {
            const { sim } = launched(bench(rows(42)), { maxVoxels: 1500, voxelRes: 2 });
            sim.run({ maxTime: 1 });
            return { launch: Array.from(sim.S.ivx), final: Array.from(sim.S.px) };
        };
        expect(go()).toEqual(go());
    });
    it("is deterministic: launch doesn't depend on the seed", () => {
        const a = launched(bench(rows(42)), { seed: 1 }).blocks;
        const b = launched(bench(rows(42)), { seed: 2 }).blocks;
        expect(a.map((q) => q.vx)).toEqual(b.map((q) => q.vx));
    });
});

describe("rock grid when cells merge into boulders", () => {
    // Merged cells are still rock until they fire. Every cell that stays a cell must launch as
    // it does with no merging, since nothing about its surroundings has changed in situ.
    it("leaves every surviving cell's launch unchanged", () => {
        const data = bench((x, y, row) => row * 42);
        const coulomb = { contactModel: "coulomb", friction: 0.5, PeAnfo: 30 };
        const plain = launched(data, coulomb).sim.S;
        const merged = launched(data, { ...coulomb, sizeModel: "kuzram", rockFactorA: 22 }).sim.S;
        const key = (S, i) => `${S.ox[i]}|${S.oy[i]}|${S.oz[i]}`;
        const inPlain = new Map();
        for (let i = 0; i < plain.N; i++) inPlain.set(key(plain, i), i);
        let survivors = 0, boulders = 0, differ = 0;
        for (let i = 0; i < merged.N; i++) {
            if (merged.cells[i] > 1) { boulders++; continue; }
            survivors++;
            const j = inPlain.get(key(merged, i));
            if (merged.ivx[i] !== plain.ivx[j] || merged.ivy[i] !== plain.ivy[j] || merged.ivz[i] !== plain.ivz[j]) differ++;
        }
        expect(boulders).toBeGreaterThan(0);
        expect(survivors).toBeGreaterThan(0);
        expect(differ).toBe(0);
    });
});

describe("unknown model names", () => {
    it.each([["contactModel", "Coulomb"], ["velocityModel", "yang90"]])("rejects %s %s instead of running the old model", (name, value) => {
        expect(() => new BlastMovementSimulator({ [name]: value })).toThrow(RangeError);
        expect(() => new BlastMovementSimulator({ [name]: value })).toThrow(new RegExp(name));
        expect(() => new BlastMovementSimulator({}).setParams({ [name]: value })).toThrow(RangeError);
    });
    it("accepts every real model name, and leaving them unset", () => {
        for (const velocityModel of ["yang", "energy", "yang1990", undefined, null]) {
            expect(() => new BlastMovementSimulator({ velocityModel })).not.toThrow();
        }
        for (const contactModel of ["coulomb", undefined, null]) {
            expect(() => new BlastMovementSimulator({ contactModel }).setParams({ contactModel })).not.toThrow();
        }
    });
});

describe("existing launch models", () => {
    const pattern = () => bench((x, y, row) => row * 42);

    it("stay the default", () => {
        const data = pattern();
        const plain = new BlastMovementSimulator({ seed: 3, voxelRes: 2, maxVoxels: 800 }).load(data);
        const named = new BlastMovementSimulator({ seed: 3, voxelRes: 2, maxVoxels: 800, velocityModel: "yang" }).load(data);
        plain.generateVoxels(); named.generateVoxels();
        expect(Array.from(plain.S.ivx)).toEqual(Array.from(named.S.ivx));
        expect(plain.opts.velocityModel).toBe("yang");
        expect(Math.max(...plain.S.ivx)).toBeLessThanOrEqual(45);
    });
    it("keep their charge-element weights", () => {
        const data = pattern();
        const holes = simHolesFromEntries(data.holes, data.decks);
        prepareChargeElements(holes);
        expect(holes[0].elems[0].w).toBeCloseTo(1150 * 0.165 * 0.165 * 0.3 / 4, 6);
    });
    it("refuse the old Pe under yang1990, whose Pe has different units", () => {
        const data = pattern();
        const holes = simHolesFromEntries(data.holes, data.decks);
        computeThrowDirections(holes);
        const { bin } = prepareChargeElements(holes);
        const S = createParticleState(1);
        expect(YANG_DEFAULTS.Pe).toBe(1);
        expect(() => assignYangVelocities(S, { x: 0, y: 0, z: 0 }, holes, bin, { velocityModel: "yang1990", Pe: 2 })).toThrow(/PeAnfo/);
    });
});

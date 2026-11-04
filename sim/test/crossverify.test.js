/**
 * Independent checks of the existing models the simulation relies on. Expected
 * values come from the formulas and textbook physics, worked out here, never from
 * the code being checked.
 */

import { describe, it, expect } from "vitest";
import { computePPVDeck } from "../../src/vibration/PPVDeck.js";
import { evaluateReceptor, decksFromEntries } from "../../src/vibration/ReceptorPPV.js";
import { computeHolmbergPerssonDamage } from "../../src/damage/HolmbergPerssonDamage.js";
import { computeHoleSDoB } from "../../src/flyrock/SDoB.js";
import { createDeckEntry } from "../../src/core/DeckEntry.js";
import { createParticleState, SpatialHash, physicsStep, SUB_DT, ST_ACTIVE } from "../../src/movement/SphereDEM.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import { voxeliseVolumes } from "../../src/movement/Voxeliser.js";
import { cutBlock } from "../scenario/block.js";
import { scenarioFromTerrain } from "../scenario/pattern.js";
import { toSimData } from "../scenario/io.js";

const G = 9.81;
const deck = (over = {}) => createDeckEntry({ topX: 0, topY: 0, topZ: -3, baseX: 0, baseY: 0, baseZ: -13, mass: 100, ...over });

describe("site-law vibration against the hand formula", () => {
    // PPV = K (R / sqrt(Q))^-B. At R = 100 m, Q = 100 kg: scaled distance 10, PPV = 1140 * 10^-1.6.
    const expected = 1140 * Math.pow(10, -1.6);
    const point = { x: 100, y: 0, z: -8 };

    it("works out to about 28.6 mm/s", () => {
        expect(expected).toBeCloseTo(28.63, 1);
    });
    it("ReceptorPPV matches at the deck's middle", () => {
        const v = evaluateReceptor(point, decksFromEntries([deck()]), { distanceMode: "3D" });
        expect(v.ppvMax).toBeCloseTo(expected, 6);
    });
    it("PPVDeck takes the nearest of the deck's top, middle and base", () => {
        // On the middle's level the middle is nearest, so it matches the same value.
        expect(computePPVDeck(point, [deck()], {})).toBeCloseTo(expected, 6);
        // Level with the top, the top is nearest: R = 100, against sqrt(100^2 + 5^2) for the middle.
        const atTop = { x: 100, y: 0, z: -3 };
        expect(computePPVDeck(atTop, [deck()], {})).toBeCloseTo(expected, 6);
        const middle = evaluateReceptor(atTop, decksFromEntries([deck()]), { distanceMode: "3D" }).ppvMax;
        expect(middle).toBeCloseTo(1140 * Math.pow(Math.hypot(100, 5) / 10, -1.6), 6);
    });
    it("doubling distance divides PPV by 2^B", () => {
        const at = (x) => evaluateReceptor({ x, y: 0, z: -8 }, decksFromEntries([deck()]), { distanceMode: "3D" }).ppvMax;
        expect(at(100) / at(200)).toBeCloseTo(Math.pow(2, 1.6), 6);
    });
    it("uses the same units in both models for two decks, with the larger charge dominating", () => {
        const decks = [deck({ mass: 100 }), deck({ topX: 50, baseX: 50, mass: 400, holeIndex: 1 })];
        const R = 50;
        const hand = 1140 * Math.pow(R / Math.sqrt(400), -1.6);
        expect(evaluateReceptor({ x: 100, y: 0, z: -8 }, decksFromEntries(decks), { distanceMode: "3D" }).ppvMax).toBeCloseTo(hand, 6);
    });
});

describe("Holmberg-Persson damage against independent integration", () => {
    const K = 700, ALPHA = 0.7, BETA = 1.5;
    const integral = (point, d, steps = 200000) => {
        const L = d.topZ - d.baseZ, q = d.mass / L, dl = L / steps;
        let sum = 0;
        for (let n = 0; n < steps; n++) {
            const z = d.topZ - (n + 0.5) * dl;
            sum += q * dl * Math.pow(Math.hypot(point.x - d.topX, point.y - d.topY, point.z - z), -BETA / ALPHA);
        }
        return K * Math.pow(sum, ALPHA);
    };

    it.each([[2], [5], [20], [100]])("agrees within 1%% at %d m from the charge", (x) => {
        const point = { x, y: 0, z: -8 };
        const got = computeHolmbergPerssonDamage(point, [deck()], {});
        expect(Math.abs(got - integral(point, deck())) / integral(point, deck())).toBeLessThan(0.01);
    });
    it("becomes K Q^alpha / R^beta far from the charge", () => {
        const got = computeHolmbergPerssonDamage({ x: 2000, y: 0, z: -8 }, [deck()], {});
        const hand = (K * Math.pow(100, ALPHA)) / Math.pow(2000, BETA);
        expect(Math.abs(got - hand) / hand).toBeLessThan(0.001);
    });
});

describe("McKenzie scaled depth of burial against the hand formula", () => {
    it("matches for a 115 mm hole", () => {
        // 115 mm: contributing length 10 diameters = 1.15 m. Hole 10 m charged with 120 kg: 12 kg/m.
        // Wt = 12 * 1.15 = 13.8 kg. Depth to centre = stemming 2.5 + 0.575 = 3.075 m.
        const hand = 3.075 / Math.cbrt(13.8);
        const got = computeHoleSDoB({ holeDiamMm: 115, stemmingLength: 2.5, chargeLength: 10, totalMassKg: 120 });
        expect(got.sDoB).toBeCloseTo(hand, 4);
    });
});

describe("sphere DEM against textbook mechanics", () => {
    function particles(list, groundZ = -1000) {
        const S = createParticleState(list.length);
        list.forEach((p, i) => {
            S.px[i] = p.x || 0; S.py[i] = p.y || 0; S.pz[i] = p.z || 0;
            S.ox[i] = S.px[i]; S.oy[i] = S.py[i]; S.oz[i] = S.pz[i];
            S.ivx[i] = p.vx || 0; S.ivy[i] = p.vy || 0; S.ivz[i] = p.vz || 0;
            S.vx[i] = S.ivx[i]; S.vy[i] = S.ivy[i]; S.vz[i] = S.ivz[i];
            S.baseRad[i] = S.rad[i] = p.r || 0.5;
            S.state[i] = ST_ACTIVE;
        });
        S.groundZ = groundZ;
        S.radius = 0.5;
        return S;
    }
    const step = (S, P, seconds, stop = () => false) => {
        const H = new SpatialHash(S.N, 2);
        let t = 0;
        while (t < seconds && !stop(S)) {
            physicsStep(S, H, null, SUB_DT, t, { g: G, restitution: 0, friction: 0, bulking: false, ...P }, () => 0.5);
            t += SUB_DT;
        }
        return t;
    };

    it("free fall takes sqrt(2h/g)", () => {
        const S = particles([{ z: 100 }]);
        const t = step(S, {}, 10, (s) => s.pz[0] <= 0);
        expect(Math.abs(t - Math.sqrt((2 * 100) / G))).toBeLessThan(0.02);
    });
    it("a 45 degree launch at 20 m/s lands v^2/g away, with no drag", () => {
        const v = 20 * Math.SQRT1_2;
        const S = particles([{ vx: v, vz: v }]);
        step(S, {}, 10, (s) => s.pz[0] < 0);
        expect(Math.abs(S.px[0] - (20 * 20) / G) / ((20 * 20) / G)).toBeLessThan(0.01);
    });
    it("rebound height follows the restitution squared", () => {
        const S = particles([{ z: 10.5 }], 0);
        let peak = 0, hit = false;
        const H = new SpatialHash(1, 2);
        for (let t = 0; t < 5; t += SUB_DT) {
            physicsStep(S, H, null, SUB_DT, t, { g: G, restitution: 0.5, friction: 0, bulking: false }, () => 0.5);
            if (S.vz[0] > 0) hit = true;
            if (hit) peak = Math.max(peak, S.pz[0]);
            if (hit && S.vz[0] < -1) break;
        }
        expect(Math.abs(peak - 0.5 - 2.5)).toBeLessThan(0.1);
    });
    it("a head-on collision conserves momentum for unequal spheres", () => {
        const S = particles([{ x: -3, vx: 5, r: 1 }, { x: 3, vx: -5, r: 0.5 }]);
        const mass = (i) => S.rad[i] ** 3;
        const before = mass(0) * S.vx[0] + mass(1) * S.vx[1];
        step(S, { g: 0, restitution: 0.2 }, 2);
        const after = mass(0) * S.vx[0] + mass(1) * S.vx[1];
        expect(S.vx[0]).toBeGreaterThan(0);
        expect(Math.abs(after - before) / Math.abs(before)).toBeLessThan(0.02);
    });
});

describe("launch and block volumes", () => {
    const size = 80;
    const z = new Float64Array(size * size).fill(115);
    const grid = (values) => ({ cols: size, rows: size, x0: 0, y0: 0, cell: 1, z: values });
    const terrain = { dtm: grid(z), filled: grid(new Float64Array(size * size)) };
    const polygon = [[20, 20], [50, 20], [50, 50], [20, 50]];
    const scenario = scenarioFromTerrain(terrain, polygon, { name: "v", floorZ: 100, twinVersion: "t" });
    const speeds = (opts) => {
        const sim = new BlastMovementSimulator({ seed: 1, voxelRes: 2, maxVoxels: 3000, jitter: 0, ...opts }).load(toSimData(scenario));
        sim.generateVoxels();
        const out = new Float64Array(sim.S.N);
        for (let i = 0; i < sim.S.N; i++) out[i] = Math.hypot(sim.S.ivx[i], sim.S.ivy[i], sim.S.ivz[i]);
        return out;
    };
    const median = (a) => Float64Array.from(a).sort()[a.length >> 1];

    it("launch speed scales with the strength parameter Pe", () => {
        expect(median(speeds({ Pe: 1 })) / median(speeds({ Pe: 0.5 }))).toBeCloseTo(2, 1);
    });
    it("launch speed scales as the square root of 2650 over rock density", () => {
        const ratio = median(speeds({ rockDensity: 2120 })) / median(speeds({ rockDensity: 2650 }));
        expect(ratio).toBeCloseTo(Math.sqrt(2650 / 2120), 1);
    });
    it("voxels reproduce the 13,500 m3 block to within 5%", () => {
        const b = cutBlock(terrain, polygon, { floorZ: 100 });
        expect(b.volumeM3).toBeCloseTo(30 * 30 * 15, 0);
        const { count } = voxeliseVolumes([b.volume], 1.5);
        expect(Math.abs(count * 1.5 ** 3 - 13500) / 13500).toBeLessThan(0.05);
    });
});

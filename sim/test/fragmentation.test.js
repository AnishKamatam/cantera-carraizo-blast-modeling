// Kuz-Ram fragment-size estimate and the mixed-size DEM path (`sizeModel: "kuzram"`).
// Hand values were worked outside this code. Published-table checks use numbers printed in
// Jug et al. 2017 (IOP, CC BY 3.0) and Adebola et al. 2016 (IISTE). They check the equations'
// form. Nothing here shows the curve predicts Carraizo or SWELLFACTOR.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseKAP } from "../../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import {
    meanSizeCm, uniformityIndex, passingFraction, retainedFraction, kuzRam, blastInputs, boulderPlan,
    ROCK_FACTOR, RELATIVE_WEIGHT_STRENGTH, FRAGMENTATION_CASES, RWS_EXPONENT_2005, RWS_EXPONENT_1987,
} from "../../src/movement/Fragmentation.js";
import {
    createParticleState, pickBoulderClusters, mergeBlocks, fitBoulders, SpatialHash, physicsStep, resetParticleState,
    ST_ACTIVE, ST_REST,
} from "../../src/movement/SphereDEM.js";
import { swellEmergent } from "../../src/movement/Displacement.js";
import { mulberry32 } from "../../src/signal/Detune.js";

const design = { A: 7, K: 1.2, Q: 1000, RWS: 83, B: 4.5, S: 5.2, dMm: 229, W: 0.3, BCL: 9, CCL: 0, L: 9, H: 12.3 };

describe("mean size", () => {
    it("matches a hand calculation of each factor", () => {
        // 1.2^-0.8 = 0.864281, 1000^(1/6) = 3.162278, (115/83)^0.95 = 1.363135; x 7 = 26.0791 cm
        expect(meanSizeCm(design)).toBeCloseTo(26.0791, 3);
    });

    it("uses 19/20 by default and takes the 1983/87 exponent 19/30 on request", () => {
        // (115/83)^(19/30) = 1.229... ; 7 x 0.864281 x 3.162278 x that = 23.5204 cm
        expect(RWS_EXPONENT_2005).toBeCloseTo(0.95, 12);
        expect(RWS_EXPONENT_1987).toBeCloseTo(0.63333, 4);
        expect(meanSizeCm({ ...design, rwsExponent: RWS_EXPONENT_1987 })).toBeCloseTo(23.5204, 3);
    });

    it("has no strength correction at RWS 115, whichever exponent is used", () => {
        const at115 = { ...design, RWS: 115 };
        expect(meanSizeCm(at115)).toBeCloseTo(meanSizeCm({ ...at115, rwsExponent: RWS_EXPONENT_1987 }), 10);
    });

    it("falls as powder factor rises: the printed K ratios of Adebola et al. 2016 Table 2", () => {
        // Same charge per hole across rows; printed K and X50.
        const rows = [[0.876, 88.33], [0.778, 97.13], [0.637, 113.98], [0.54, 130.08]];
        const base = meanSizeCm({ ...design, K: rows[0][0], Q: 110.4 });
        for (const [K, x] of rows) {
            const ratio = meanSizeCm({ ...design, K, Q: 110.4 }) / base;
            expect(Math.abs(ratio / (x / rows[0][1]) - 1)).toBeLessThan(0.002);
        }
    });

    it("scales with Q to the 1/6", () => {
        expect(meanSizeCm({ ...design, Q: 64000 }) / meanSizeCm(design)).toBeCloseTo(2, 6 - 3);
    });
});

describe("uniformity index", () => {
    it("matches a hand calculation, burden in m and diameter in mm", () => {
        // 1.924891 x 1.038161 x 0.933333 x 1.009577 x 0.731707 = 1.37779
        expect(uniformityIndex(design)).toBeCloseTo(1.37779, 4);
    });

    it("carries the bottom and column charge term", () => {
        // (|6-3|/9 + 0.1)^0.1 replaces 1.1^0.1: 1.25524
        expect(uniformityIndex({ ...design, BCL: 6, CCL: 3 })).toBeCloseTo(1.25524, 4);
    });

    it("reproduces the B, S and d trend across all 15 rows of Jug et al. 2017 Table 1", () => {
        // d = 76 mm. The table fixes B x S. W and the charge terms aren't printed, so compare ratios at W = 0.
        const rows = [
            [2.84, 4.26, 1.37], [2.89, 4.19, 1.35], [2.94, 4.12, 1.33], [3.0, 4.05, 1.31], [3.05, 3.97, 1.28],
            [3.11, 3.89, 1.26], [3.18, 3.81, 1.24], [3.25, 3.73, 1.21], [3.32, 3.65, 1.19], [3.4, 3.57, 1.16],
            [3.48, 3.48, 1.14], [3.57, 3.39, 1.11], [3.67, 3.3, 1.09], [3.78, 3.21, 1.06], [3.89, 3.11, 1.03],
        ];
        const n = ([B, S]) => uniformityIndex({ B, S, dMm: 76, W: 0, BCL: 8, CCL: 0, L: 8, H: 15 });
        const scale = rows[0][2] / n(rows[0]);
        // Table values are printed to 0.01, so a 1.5% band covers rounding at either end.
        for (const row of rows) expect(Math.abs(n(row) * scale / row[2] - 1)).toBeLessThan(0.015);
    });
});

describe("Rosin-Rammler curve", () => {
    it("is 50% at x50 within the rounding of 0.693", () => {
        expect(passingFraction(0.25, 0.25, 1.5)).toBeCloseTo(0.49993, 4);
    });

    it("matches hand values at x50 25 cm, n 1.5", () => {
        expect(passingFraction(0.1, 0.25, 1.5)).toBeCloseTo(0.160809, 5);
        expect(passingFraction(0.5, 0.25, 1.5)).toBeCloseTo(0.859156, 5);
        expect(passingFraction(1, 0.25, 1.5)).toBeCloseTo(0.996089, 5);
        expect(retainedFraction(1, 0.25, 1.5)).toBeCloseTo(1 - 0.996089, 5);
    });

    it("reproduces the shares printed by Jug et al. 2017 Table 1 from its n and Xc", () => {
        // R = exp(-(x/Xc)^n) is the same curve with x50 = Xc 0.693^(1/n).
        const rows = [[1.37, 0.284, 79.76, 98.39], [1.14, 0.3, 75.04, 95.29], [1.03, 0.311, 72.67, 92.9]];
        for (const [n, xc, at40, at80] of rows) {
            const x50 = xc * Math.pow(0.693, 1 / n);
            // n and Xc are printed to 2-3 figures: 0.5 percentage points covers that.
            expect(Math.abs(100 * passingFraction(0.4, x50, n) - at40)).toBeLessThan(0.5);
            expect(Math.abs(100 * passingFraction(0.8, x50, n) - at80)).toBeLessThan(0.5);
        }
    });

    it("rises monotonically and returns shares at the stated sizes", () => {
        const out = kuzRam(design, { sizesM: [0.5, 1, 2] });
        expect(out.x50M).toBeCloseTo(0.260791, 4);
        expect(out.x50Cm).toBeCloseTo(26.0791, 3);
        expect(out.n).toBeCloseTo(1.37779, 4);
        for (let i = 1; i < out.curve.length; i++) {
            expect(out.curve[i].xM).toBeGreaterThan(out.curve[i - 1].xM);
            expect(out.curve[i].passing).toBeGreaterThanOrEqual(out.curve[i - 1].passing);
        }
        expect(out.shares.map((s) => s.xM)).toEqual([0.5, 1, 2]);
        for (const s of out.shares) {
            expect(s.passing).toBeCloseTo(passingFraction(s.xM, out.x50M, out.n), 12);
            expect(s.oversize + s.passing).toBeCloseTo(1, 12);
        }
    });
});

describe("rejects non-physical input instead of clamping", () => {
    const bad = {
        "A zero": { A: 0 }, "A above the published range": { A: 23 }, "A below the published range": { A: 0.5 },
        "K zero": { K: 0 }, "K negative": { K: -1 }, "Q zero": { Q: 0 }, "RWS zero": { RWS: 0 }, "RWS NaN": { RWS: NaN },
        "A as text": { A: "7" }, "burden zero": { B: 0 }, "spacing negative": { S: -1 }, "diameter zero": { dMm: 0 },
        "diameter given in metres": { dMm: 0.229 }, "burden so large n is negative": { B: 40, S: 40 },
        "drill error reaching the burden": { W: 4.5 }, "drill error negative": { W: -0.1 },
        "charge length zero": { L: 0, BCL: 0 }, "bench zero": { H: 0 },
        "bottom and column charge not adding to the charge": { BCL: 20, CCL: 0 }, "column charge negative": { CCL: -1 },
    };
    for (const [name, change] of Object.entries(bad)) {
        it(name, () => expect(() => kuzRam({ ...design, ...change })).toThrow(/Kuz-Ram/));
    }
    it("a size of zero or below", () => {
        expect(() => passingFraction(0, 0.25, 1.5)).toThrow(/Kuz-Ram/);
        expect(() => kuzRam(design, { sizesM: [-1] })).toThrow(/Kuz-Ram/);
    });
    it("does not change a valid input", () => {
        expect(() => kuzRam(design)).not.toThrow();
    });
});

describe("assumed values are recorded with their evidence", () => {
    it("central and range for A sit inside the published range", () => {
        expect(ROCK_FACTOR.low).toBeLessThan(ROCK_FACTOR.central);
        expect(ROCK_FACTOR.central).toBeLessThan(ROCK_FACTOR.high);
        expect(ROCK_FACTOR.publishedMin).toBe(0.8);
        expect(ROCK_FACTOR.publishedMax).toBe(22);
        expect(ROCK_FACTOR.evidence).toMatch(/SECONDARY/);
    });
    it("RWS records its assumption", () => {
        expect(RELATIVE_WEIGHT_STRENGTH.assumed).toMatch(/emulsion/i);
        expect(RELATIVE_WEIGHT_STRENGTH.evidence).toMatch(/SECONDARY/);
    });
    it("the low, central and high cases order x50", () => {
        const x = (c) => kuzRam({ ...design, ...FRAGMENTATION_CASES[c] }).x50M;
        expect(x("low")).toBeLessThan(x("central"));
        expect(x("central")).toBeLessThan(x("high"));
    });
});

describe("blast inputs from the hole list", () => {
    const hole = {
        cx: 0, cy: 0, cz: 12, tx: 0, ty: 0, tz: -2, diameter: 0.2, mass: 1000, burden: 4, spacing: 5, benchHeight: 12,
        stemLen: 4, chargeBaseDepth: 14,
    };

    it("takes charge above grade by default: subdrill out of Q, K and L", () => {
        // 10 m charged, 2 m of it below grade: L 8, Q 800 kg, K = 2 x 800 / 500 m3 = 3.2
        const v = blastInputs([hole, hole], 500, {});
        expect(v.L).toBeCloseTo(8, 9);
        expect(v.Q).toBeCloseTo(800, 9);
        expect(v.K).toBeCloseTo(3.2, 9);
        expect(v.B).toBe(4); expect(v.S).toBe(5); expect(v.dMm).toBeCloseTo(200, 9); expect(v.H).toBe(12);
        expect(v.BCL).toBeCloseTo(8, 9); expect(v.CCL).toBe(0);
    });

    it("can count the whole charge", () => {
        const v = blastInputs([hole, hole], 500, { chargeBasis: "total" });
        expect(v.L).toBeCloseTo(10, 9);
        expect(v.Q).toBeCloseTo(1000, 9);
        expect(v.K).toBeCloseTo(4, 9);
    });

    it("measures subdrill along an angled hole", () => {
        // 3-4-5 hole: 14 m vertical is 17.5 m along it, so 2 m of depth is 2.5 m of hole.
        const angled = { ...hole, tx: 10.5, tz: -2, chargeBaseDepth: 17.5, stemLen: 7.5 };
        const v = blastInputs([angled], 500, {});
        expect(v.L).toBeCloseTo(7.5, 6);
        expect(v.Q).toBeCloseTo(750, 6);
    });

    it("rejects holes without the design data, unless it is supplied", () => {
        expect(() => blastInputs([{ ...hole, burden: 0 }], 500, {})).toThrow(/burden/);
        expect(blastInputs([{ ...hole, burden: 0 }], 500, { burdenM: 4 }).B).toBe(4);
        expect(() => blastInputs([], 500, {})).toThrow(/Kuz-Ram/);
        expect(() => blastInputs([hole], 0, {})).toThrow(/Kuz-Ram/);
    });
});

describe("boulder plan", () => {
    it("reports only what it uses", () => {
        expect(boulderPlan({ x50M: 0.5, n: 1.5, cellM: 1, cells: 100, xMaxM: 4 })).not.toHaveProperty("expectedCellsAboveMergeLimit");
    });
    // x50 0.5 m, n 1.5, 1 m cell, 10,000 cells. Worked by hand:
    // R(1) = 0.140844; R(1.5^(1/3)) = 0.090662; class 2 holds 455.76 cells, class 3 195.33 cells.
    const plan = boulderPlan({ x50M: 0.5, n: 1.5, cellM: 1, cells: 10000, xMaxM: 4.5 });

    it("reports the rock above a cell and above the merge limit", () => {
        expect(plan.shareAboveCell).toBeCloseTo(0.140844, 5);
        expect(plan.shareAboveMergeLimit).toBeCloseTo(0.090662, 5);
    });

    it("merges what the curve holds in cells, leaving under one boulder's worth unplaced", () => {
        let cells = 0;
        for (const c of plan.classes) { cells += c.cells * c.count; expect(c.cells).toBeGreaterThanOrEqual(2); }
        expect(cells).toBe(plan.mergedCells);
        expect(Math.abs(cells - 0.090662 * 10000)).toBeLessThan(2);
    });

    it("never exceeds the size limit, and folds rock beyond it into the top class", () => {
        expect(Math.max(...plan.classes.map((c) => c.cells))).toBeLessThanOrEqual(Math.floor(4.5 ** 3));
        const capped = boulderPlan({ x50M: 0.5, n: 1.5, cellM: 1, cells: 10000, xMaxM: 2 });
        expect(Math.max(...capped.classes.map((c) => c.cells))).toBeLessThanOrEqual(8);
        expect(Math.abs(capped.mergedCells - 906.62)).toBeLessThan(2);
    });

    it("makes no boulders when none is a whole boulder of rock", () => {
        const none = boulderPlan({ x50M: 0.2, n: 1.6, cellM: 2.2, cells: 13193, xMaxM: 4.5 });
        expect(none.classes).toEqual([]);
        expect(none.mergedCells).toBe(0);
    });

    it("makes none when a cell is already at the limit", () => {
        expect(boulderPlan({ x50M: 0.5, n: 1.5, cellM: 5, cells: 1000, xMaxM: 4.5 }).classes).toEqual([]);
    });

    it("rejects non-physical input", () => {
        expect(() => boulderPlan({ x50M: 0, n: 1.5, cellM: 1, cells: 10, xMaxM: 4 })).toThrow(/Kuz-Ram/);
        expect(() => boulderPlan({ x50M: 1, n: 0, cellM: 1, cells: 10, xMaxM: 4 })).toThrow(/Kuz-Ram/);
        expect(() => boulderPlan({ x50M: 1, n: 1, cellM: 0, cells: 10, xMaxM: 4 })).toThrow(/Kuz-Ram/);
    });
});

/** An nx x ny x nz lattice of unit cells with radii 0.42 to 0.54. */
function lattice(nx, ny, nz, seed = 3) {
    const rng = mulberry32(seed);
    const S = createParticleState(nx * ny * nz);
    S.baseR = S.radius = 0.47; S.groundZ = -0.47;
    let i = 0;
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++, i++) {
        S.px[i] = S.ox[i] = x; S.py[i] = S.oy[i] = y; S.pz[i] = S.oz[i] = z;
        S.baseRad[i] = S.rad[i] = 0.42 + 0.12 * rng();
    }
    return S;
}

const volume = (S) => { let v = 0; for (let i = 0; i < S.N; i++) v += S.baseRad[i] ** 3; return v; };

function worstBoulderOverlap(S) {
    let worst = -Infinity;
    for (let i = 0; i < S.N; i++) {
        if (S.cells[i] < 2) continue;
        for (let j = 0; j < S.N; j++) {
            if (j === i) continue;
            const d = Math.hypot(S.px[i] - S.px[j], S.py[i] - S.py[j], S.pz[i] - S.pz[j]);
            worst = Math.max(worst, S.rad[i] + S.rad[j] - d);
        }
    }
    return worst;
}

describe("merging cells into boulders", () => {
    const classes = [{ cells: 27, count: 1 }, { cells: 8, count: 3 }, { cells: 2, count: 20 }];
    const pick = (S, seed = 5) => pickBoulderClusters(S, 1, classes, mulberry32(seed));

    it("picks the asked clusters, each connected, with no cell used twice", () => {
        const S = lattice(14, 14, 10);
        const { clusters, unplacedCells } = pick(S);
        expect(unplacedCells).toBe(0);
        expect(clusters.map((c) => c.length).sort((a, b) => b - a).slice(0, 4)).toEqual([27, 8, 8, 8]);
        expect(clusters.length).toBe(24);
        const seen = new Set();
        for (const cluster of clusters) {
            for (const i of cluster) { expect(seen.has(i)).toBe(false); seen.add(i); }
            const reached = new Set([cluster[0]]);
            for (let pass = 0; pass < cluster.length; pass++) for (const a of cluster) for (const b of reached) {
                if (Math.hypot(S.px[a] - S.px[b], S.py[a] - S.py[b], S.pz[a] - S.pz[b]) <= 1.2) reached.add(a);
            }
            expect(reached.size).toBe(cluster.length);
        }
    });

    it("keeps clusters compact", () => {
        const S = lattice(14, 14, 10);
        const big = pick(S).clusters.find((c) => c.length === 27);
        const cx = big.reduce((s, i) => s + S.px[i], 0) / 27, cy = big.reduce((s, i) => s + S.py[i], 0) / 27, cz = big.reduce((s, i) => s + S.pz[i], 0) / 27;
        // A 3 x 3 x 3 cube reaches sqrt(3) = 1.73 from its centre: allow a less tidy shape, not a chain.
        for (const i of big) expect(Math.hypot(S.px[i] - cx, S.py[i] - cy, S.pz[i] - cz)).toBeLessThan(2.6);
    });

    it("reports what can't be placed rather than dropping it", () => {
        const S = lattice(3, 3, 1);
        const { clusters, unplacedCells } = pickBoulderClusters(S, 1, [{ cells: 27, count: 1 }], mulberry32(1));
        expect(clusters).toEqual([]);
        expect(unplacedCells).toBe(27);
    });

    it("conserves mass and rock, at the mass-weighted centre", () => {
        const S = lattice(14, 14, 10);
        const before = volume(S);
        const { clusters } = pick(S);
        const M = mergeBlocks(S, clusters);
        expect(M.N).toBe(S.N - clusters.reduce((s, c) => s + c.length - 1, 0));
        expect(Math.abs(volume(M) / before - 1)).toBeLessThan(1e-5);
        expect(M.cells.reduce((a, b) => a + b, 0)).toBe(S.N);
        const big = M.cells.indexOf(27), members = clusters.find((c) => c.length === 27);
        const w = members.reduce((s, i) => s + S.baseRad[i] ** 3, 0);
        expect(M.baseRad[big] ** 3).toBeCloseTo(w, 4);
        expect(M.ox[big]).toBeCloseTo(members.reduce((s, i) => s + S.ox[i] * S.baseRad[i] ** 3, 0) / w, 4);
        expect(M.pz[big]).toBeCloseTo(M.oz[big], 6);
    });

    it("starts boulders clear of every neighbour, without changing their mass", () => {
        const S = lattice(14, 14, 10);
        const M = mergeBlocks(S, pick(S).clusters);
        const base = Float32Array.from(M.baseRad);
        fitBoulders(M, null);
        expect(worstBoulderOverlap(M)).toBeLessThanOrEqual(1e-6);
        expect(M.baseRad).toEqual(base);
        expect(M.rad).toEqual(M.initRad);
    });

    it("reset returns boulders to their fitted size, and other blocks to theirs", () => {
        const S = lattice(14, 14, 10);
        const M = mergeBlocks(S, pick(S).clusters);
        fitBoulders(M, null);
        const start = Float32Array.from(M.rad);
        M.rad.fill(3);
        resetParticleState(M);
        expect(M.rad).toEqual(start);
    });

    it("leaves a state with no size data resetting to baseRad", () => {
        const S = lattice(3, 3, 3);
        S.rad.fill(3);
        resetParticleState(S);
        expect(S.rad).toEqual(S.baseRad);
    });
});

describe("contact with large radii", () => {
    const params = { g: 9.81, restitution: 0, friction: 0.5, bulking: false, contactModel: "coulomb" };
    const make = (list, groundZ = 0) => {
        const S = createParticleState(list.length);
        S.groundZ = groundZ; S.baseR = S.radius = 0.5;
        list.forEach((b, i) => {
            S.px[i] = S.ox[i] = b.x ?? 0; S.py[i] = S.oy[i] = b.y ?? 0; S.pz[i] = S.oz[i] = b.z ?? 0;
            S.vx[i] = b.vx ?? 0; S.baseRad[i] = S.rad[i] = b.r; S.state[i] = ST_ACTIVE;
        });
        return S;
    };
    const hash = (S) => new SpatialHash(S.N, 2 * Math.max(...S.baseRad) * 1.03);

    it("finds a contact across hash cells when the hash fits the largest sphere", () => {
        const S = make([{ x: 0, z: 100, r: 2.5 }, { x: 2.95, z: 100, r: 0.5 }]);
        physicsStep(S, hash(S), null, 0.005, 0.005, { ...params, g: 0 }, () => 0.5);
        expect(Math.hypot(S.px[1] - S.px[0], S.pz[1] - S.pz[0])).toBeGreaterThan(2.95);
    });

    it("conserves momentum between a boulder and a lump 125 times lighter", () => {
        const S = make([{ x: 0, z: 100, r: 2.5, vx: 5 }, { x: 3.01, z: 100, r: 0.5 }]);
        const momentum = () => 125 * S.vx[0] + S.vx[1];
        const before = momentum();
        const H = hash(S);
        for (let k = 1; k <= 20; k++) physicsStep(S, H, null, 0.005, k * 0.005, { ...params, g: 0 }, () => 0.5);
        expect(Math.abs(momentum() / before - 1)).toBeLessThan(1e-3);
        expect(S.vx[1]).toBeGreaterThan(S.vx[0] - 1e-3);
    });

    it("moves the lump, not the boulder, when removing overlap", () => {
        const S = make([{ x: 0, z: 100, r: 2.5 }, { x: 2.5, z: 100, r: 0.5 }]);
        physicsStep(S, hash(S), null, 0.005, 0.005, { ...params, g: 0 }, () => 0.5);
        expect(Math.abs(S.px[0])).toBeLessThan(0.05 * Math.abs(S.px[1] - 2.5));
    });

    it("rests a dropped boulder on a bed of lumps without passing through, then sleeps", () => {
        const list = [{ x: 0, y: 0, z: 6, r: 2 }];
        for (let x = -5; x <= 5; x++) for (let y = -5; y <= 5; y++) list.push({ x, y, z: 0.5, r: 0.5 });
        const S = make(list);
        const H = hash(S);
        let t = 0, r;
        for (let k = 0; k < 1200; k++) { t += 0.005; r = physicsStep(S, H, null, 0.005, t, params, () => 0.5); }
        // Sits on top of the lumps' upper surface or has shouldered them aside; never through the ground.
        expect(S.pz[0]).toBeGreaterThanOrEqual(2 - 1e-3);
        expect(S.state[0]).toBe(ST_REST);
        expect(r.active).toBe(0);
    });
});

// ------------------------------------------------------------ whole simulator

/** Six holes, no meshes: the simulator fills a padded box. Light charge, so rock stays coarse. */
function shot() {
    const holes = [], decks = [];
    for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) {
        const x = a * 6, y = b * 7, i = holes.length;
        holes.push({
            entityName: "T", holeID: String(i), collarX: x, collarY: y, collarZ: 12, toeX: x, toeY: y, toeZ: -1, holeDiamMm: 89,
            holeType: "Production", benchHeight: 12, subdrillLength: 1, holeTime: 25 * i, burden: 6, spacing: 7, gradeZ: 0, massPerHole: 100,
        });
        decks.push({
            deckType: "COUPLED", topX: x, topY: y, topZ: 9, baseX: x, baseY: y, baseZ: -1, mass: 100, density: 1.24, vod: 5000,
            holeIndex: i, holeDiamMm: 89, chargeDiamMm: 89, timingMs: 25 * i, primerFraction: 1,
        });
    }
    return { holes, decks, surfaces: [] };
}

describe("swellEmergent with merged cells", () => {
    it("counts the rock a merged block holds, not one voxel per block", () => {
        const S = createParticleState(2);
        S.baseR = S.radius = 0.47; // a 1 m voxel
        S.state.fill(ST_REST);
        S.px[1] = 10;
        const oneVoxelEach = swellEmergent(S);
        S.cells = Uint16Array.from([3, 1]);
        expect(swellEmergent(S)).toBeCloseTo(oneVoxelEach / 2, 10); // 4 voxels of rock, not 2
    });
});

const simOptions = { seed: 7, voxelRes: 1.5, maxVoxels: 6000, contactModel: "coulomb", friction: 0.5, maxSwell: 1.4 };

function fnv(arrays) {
    let h = 0x811c9dc5;
    for (const a of arrays) {
        const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    }
    return (h >>> 0).toString(16);
}

describe("sizeModel in the simulator", () => {
    const kap = parseKAP(readFileSync(new URL("../../examples/SWELLFACTOR.kap", import.meta.url)));

    const finalState = async (options) => {
        const sim = new BlastMovementSimulator({ seed: 1, maxVoxels: 1200, ...options }).load(await kap);
        sim.generateVoxels();
        sim.run();
        return { sim, hash: fnv([sim.S.px, sim.S.py, sim.S.pz, sim.S.rad]), D: sim.results().comShift.D };
    };

    // Both hashes were taken from the code before this feature existed.
    it("leaves the default model byte-identical", async () => {
        const run = await finalState({});
        expect(run.sim.S.N).toBe(960);
        expect(run.hash).toBe("8db41e66");
        expect(run.D).toBe(16.28558535606236);
        expect(run.sim.S.cells).toBeUndefined();
    }, 60000);

    it("leaves the coulomb model byte-identical", async () => {
        const run = await finalState({ contactModel: "coulomb", friction: 0.5 });
        expect(run.hash).toBe("ece4b7aa");
        expect(run.D).toBe(32.74532670781816);
    }, 60000);

    it("treats sizeModel none as the option not being set", async () => {
        expect((await finalState({ sizeModel: "none" })).hash).toBe("8db41e66");
    }, 60000);

    it("is identical to no size model when the curve has no boulder's worth above a cell", async () => {
        const run = await finalState({ contactModel: "coulomb", friction: 0.5, sizeModel: "kuzram" });
        expect(run.sim.fragmentation.plan.mergedCells).toBe(0);
        expect(run.hash).toBe("ece4b7aa");
        expect(run.sim.fragmentation.x50M).toBeGreaterThan(0);
    }, 60000);

    it("rejects an unknown size model and combinations it can't honour", () => {
        const go = (o) => new BlastMovementSimulator({ ...simOptions, ...o }).load(shot()).generateVoxels();
        expect(() => go({ sizeModel: "swebrec" })).toThrow(/sizeModel/);
        expect(() => go({ sizeModel: "kuzram", contactModel: undefined })).toThrow(/coulomb/);
        expect(() => go({ sizeModel: "kuzram", rockFactorA: 40 })).toThrow(/Kuz-Ram/);
        expect(() => go({ sizeModel: "kuzram", rws: -5 })).toThrow(/Kuz-Ram/);
    });

    const coarse = { ...simOptions, sizeModel: "kuzram", rockFactorA: 4 };

    it("conserves rock and solid volume through the merge, with growth unchanged", () => {
        const plain = new BlastMovementSimulator(simOptions).load(shot());
        plain.generateVoxels();
        const sized = new BlastMovementSimulator(coarse).load(shot());
        sized.generateVoxels();
        const F = sized.fragmentation;
        expect(F.plan.mergedCells).toBeGreaterThan(0);
        expect(sized.S.N).toBeLessThan(plain.S.N);
        expect(sized.S.cells.reduce((a, b) => a + b, 0)).toBe(plain.S.N);
        expect(Math.abs(volume(sized.S) / volume(plain.S) - 1)).toBeLessThan(1e-5);
        expect(sized.rockVolumeM3()).toBeCloseTo(plain.rockVolumeM3(), 6);
        expect(Math.abs(sized.coulombGrowth / plain.coulombGrowth - 1)).toBeLessThan(1e-5);
        const blocks = sized.blockSizes();
        expect(blocks.count).toBe(sized.S.N);
        expect(blocks.representedM3.reduce((a, b) => a + b, 0)).toBeCloseTo(sized.rockVolumeM3(), 0);
    });

    it("has the planned classes and starts boulders clear of neighbours, before and after fire", () => {
        const sim = new BlastMovementSimulator(coarse).load(shot());
        sim.generateVoxels();
        const counted = {};
        for (const c of sim.S.cells) if (c > 1) counted[c] = (counted[c] || 0) + 1;
        const planned = {};
        for (const c of sim.fragmentation.plan.classes) planned[c.cells] = c.count;
        expect(sim.fragmentation.unplacedCells).toBe(0);
        expect(counted).toEqual(planned);
        expect(worstBoulderOverlap(sim.S)).toBeLessThanOrEqual(1e-6);
        sim.fire();
        expect(worstBoulderOverlap(sim.S)).toBeLessThanOrEqual(1e-6);
    });

    it("sizes the hash for the largest grown block", () => {
        const sim = new BlastMovementSimulator(coarse).load(shot());
        sim.generateVoxels();
        expect(sim.H.N ?? sim.H.entries.length).toBe(sim.S.N);
        expect(sim.H.cellSize).toBeGreaterThanOrEqual(2 * Math.max(...sim.S.baseRad) * sim.coulombGrowth);
    });

    it("gives every boulder a launch time from the hole nearest its centre", () => {
        const sim = new BlastMovementSimulator(coarse).load(shot());
        sim.generateVoxels();
        for (let i = 0; i < sim.S.N; i++) {
            if (sim.S.cells[i] < 2) continue;
            expect(sim.S.nearH[i]).toBeGreaterThanOrEqual(0);
            expect(sim.S.at[i]).toBeCloseTo(sim.holes[sim.S.nearH[i]].fireT, 5);
        }
    });

    it("runs to rest with boulders at full size, without material overlap and with the bulk asked for", () => {
        const sim = new BlastMovementSimulator(coarse).load(shot());
        sim.generateVoxels();
        sim.run();
        const S = sim.S;
        const res = sim.results();
        // Not `settled`: without sizes this shot also ends with a few blocks creeping at the time cap.
        expect(res.stats.resting / S.N).toBeGreaterThanOrEqual(0.99);
        for (let i = 0; i < S.N; i++) expect(S.rad[i]).toBeCloseTo(S.baseRad[i] * sim.coulombGrowth, 2);
        let worst = 0;
        for (let i = 0; i < S.N; i++) for (let j = i + 1; j < S.N; j++) {
            const contact = S.rad[i] + S.rad[j];
            const d = Math.hypot(S.px[i] - S.px[j], S.py[i] - S.py[j], S.pz[i] - S.pz[j]);
            if (d < contact) worst = Math.max(worst, (contact - d) / contact);
        }
        expect(worst).toBeLessThan(0.1);
        expect(Math.abs(res.swellBulk / 1.4 - 1)).toBeLessThan(0.1);
        for (let i = 0; i < S.N; i++) expect(S.pz[i]).toBeGreaterThanOrEqual(S.groundZ + S.rad[i] - 1e-3);
    }, 120000);

    it("exposes the curve and per-block data for the viewer", () => {
        const sim = new BlastMovementSimulator(coarse).load(shot());
        sim.generateVoxels();
        const out = sim.results().fragmentation;
        expect(out.model).toBe("kuzram");
        expect(out.uncalibrated).toBe(true);
        expect(out.curve.length).toBeGreaterThan(10);
        expect(out.blocks).toBe(sim.S.N);
        expect(out.largestBoulderCells).toBe(Math.max(...sim.S.cells));
        expect(out.largestBlockFinalDiameterM).toBeCloseTo(2 * Math.max(...sim.S.baseRad) * sim.coulombGrowth, 5);
        // The widest block needn't be the one with the most cells.
        sim.S.baseRad[0] = 2 * Math.max(...sim.S.baseRad);
        expect(sim.results().fragmentation.largestBlockFinalDiameterM).toBeCloseTo(2 * sim.S.baseRad[0] * sim.coulombGrowth, 5);
    });

    it("reproduces a seeded sized run exactly", () => {
        const once = () => {
            const sim = new BlastMovementSimulator(coarse).load(shot());
            sim.generateVoxels();
            return fnv([sim.S.px, sim.S.baseRad, sim.S.ivx]);
        };
        expect(once()).toBe(once());
    });
});

// Textbook mechanics for contactModel: "coulomb". Nothing here is tuned to a survey:
// the limits come from Coulomb's friction law and from conservation of momentum.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseKAP } from "../../src/io/KAPReader.js";
import { BlastMovementSimulator } from "../../src/movement/BlastMovementSimulator.js";
import { createParticleState, SpatialHash, physicsStep, ST_ACTIVE, ST_REST } from "../../src/movement/SphereDEM.js";
import { buildShellBin } from "../../src/movement/ShellCollider.js";
import { sphereColumns, swellBulk } from "../../src/movement/Displacement.js";
import { rasterTop } from "../../src/movement/SurfaceMesh.js";
import { readScenario, toSimData } from "../scenario/io.js";
import { scenarioFromTerrain } from "../scenario/pattern.js";

const G = 9.81;
const params = (friction, extra = {}) => ({ g: G, restitution: 0, friction, bulking: false, contactModel: "coulomb", ...extra });

function blocks(list, groundZ = 0) {
    const S = createParticleState(list.length);
    S.groundZ = groundZ;
    list.forEach((b, i) => {
        S.px[i] = S.ox[i] = b.x ?? 0; S.py[i] = S.oy[i] = b.y ?? 0; S.pz[i] = S.oz[i] = b.z ?? 0;
        S.vx[i] = b.vx ?? 0; S.vy[i] = b.vy ?? 0; S.vz[i] = b.vz ?? 0;
        S.baseRad[i] = S.rad[i] = b.r ?? 1;
        S.state[i] = ST_ACTIVE;
    });
    S.baseR = S.radius = 1;
    return S;
}

const hashFor = (S) => new SpatialHash(S.N, 2.2 * Math.max(...S.baseRad));

function runUntil(S, SB, dt, P, seconds, stop) {
    const H = hashFor(S);
    let t = 0;
    while (t < seconds) {
        t += dt;
        physicsStep(S, H, SB, dt, t, P, () => 0.5);
        if (stop && stop(t)) break;
    }
    return t;
}

/** A flat or tilted square of two triangles; `n` splits it into an n x n x 2 mesh. */
function plane(size, z, slopeRad = 0, n = 1) {
    const h = (x) => z - Math.tan(slopeRad) * x;
    const out = [];
    const step = (2 * size) / n;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const x0 = -size + a * step, x1 = x0 + step, y0 = -size + b * step, y1 = y0 + step;
        out.push(x0, y0, h(x0), x1, y0, h(x1), x1, y1, h(x1));
        out.push(x0, y0, h(x0), x1, y1, h(x1), x0, y1, h(x0));
    }
    return Float32Array.from(out);
}

describe("sliding block on a plane stops at v^2 / (2 mu g)", () => {
    for (const mu of [0.3, 0.5, 0.7]) {
        for (const dt of [0.005, 0.0025]) {
            it(`on the ground plane, mu ${mu}, dt ${dt}`, () => {
                const S = blocks([{ z: 1, vx: 20 }]);
                runUntil(S, null, dt, params(mu), 15, () => S.state[0] === ST_REST);
                const expected = (20 * 20) / (2 * mu * G);
                expect(Math.abs(S.px[0] - expected) / expected).toBeLessThan(0.03);
            });
            it(`on a shell, mu ${mu}, dt ${dt}`, () => {
                const S = blocks([{ z: 1, vx: 20 }], -50);
                const SB = buildShellBin(plane(200, 0));
                runUntil(S, SB, dt, params(mu), 15, () => S.state[0] === ST_REST);
                const expected = (20 * 20) / (2 * mu * G);
                expect(Math.abs(S.px[0] - expected) / expected).toBeLessThan(0.03);
            });
        }
    }
});

describe("block on a slope", () => {
    const mu = 0.5; // friction angle 26.57 degrees
    const onSlope = (deg) => {
        const a = (deg * Math.PI) / 180;
        const S = blocks([{ x: 0, z: 1 / Math.cos(a) + 0.001 }], -300);
        const SB = buildShellBin(plane(400, 0, a));
        return { S, SB, a };
    };
    for (const deg of [10, 20, 24]) {
        it(`sticks at ${deg} degrees`, () => {
            const { S, SB } = onSlope(deg);
            runUntil(S, SB, 0.005, params(mu), 3);
            expect(Math.hypot(S.px[0], S.py[0])).toBeLessThan(0.02);
        });
    }
    for (const deg of [30, 35, 45]) {
        it(`slides at ${deg} degrees with a = g (sin - mu cos)`, () => {
            const { S, SB, a } = onSlope(deg);
            const T = 3;
            runUntil(S, SB, 0.005, params(mu), T);
            const travelled = Math.hypot(S.px[0], S.pz[0] - (1 / Math.cos(a) + 0.001));
            const expected = 0.5 * G * (Math.sin(a) - mu * Math.cos(a)) * T * T;
            expect(Math.abs(travelled - expected) / expected).toBeLessThan(0.03);
        });
    }
});

describe("contact impulses", () => {
    it("conserves momentum in a head-on contact between unequal blocks", () => {
        const S = blocks([{ x: -2, z: 50, vx: 6, r: 1 }, { x: 0.5, z: 50, vx: -2, r: 1.5 }], -100);
        const before = (i) => S.baseRad[i] ** 3;
        const p0 = before(0) * S.vx[0] + before(1) * S.vx[1];
        runUntil(S, null, 0.001, params(0.5, { g: 0 }), 0.5);
        const p1 = before(0) * S.vx[0] + before(1) * S.vx[1];
        expect(S.vx[1]).toBeGreaterThan(-2); // they did collide
        expect(Math.abs(p1 - p0)).toBeLessThan(1e-3 * Math.abs(p0));
    });

    it("conserves all three momentum components in an oblique contact with friction", () => {
        const S = blocks([{ x: -1.6, y: 0.3, z: 50.6, vx: 5, vy: -3, vz: 1, r: 1 }, { x: 0.8, y: 0, z: 50, vx: -1, vy: 2, vz: -1, r: 1.2 }], -100);
        const m = (i) => S.baseRad[i] ** 3;
        const mom = () => ["vx", "vy", "vz"].map((c) => m(0) * S[c][0] + m(1) * S[c][1]);
        const p0 = mom();
        runUntil(S, null, 0.001, params(0.5, { g: 0 }), 0.5);
        mom().forEach((p, c) => expect(Math.abs(p - p0[c])).toBeLessThan(1e-3 * (1 + Math.abs(p0[c]))));
    });

    it("limits the tangential impulse to mu times the normal impulse in a glancing contact", () => {
        // Equal blocks, normal along x. Vy is fast enough that the contact keeps sliding.
        const S = blocks([{ x: -1.01, z: 50, vx: 1, vy: 10 }, { x: 1.01, z: 50, vx: -1 }], -100);
        const v0 = [S.vx[0], S.vy[0]];
        runUntil(S, null, 0.001, params(0.4, { g: 0 }), 0.2);
        const normal = Math.abs(S.vx[0] - v0[0]);
        const tangential = Math.abs(S.vy[0] - v0[1]);
        expect(normal).toBeGreaterThan(0.5);
        expect(tangential).toBeCloseTo(0.4 * normal, 1);
    });

    it("friction does not depend on the block's own weight in the slide distance", () => {
        const run = (r) => {
            const S = blocks([{ z: r, vx: 10, r }]);
            runUntil(S, null, 0.005, params(0.5), 8, () => S.state[0] === ST_REST);
            return S.px[0];
        };
        expect(Math.abs(run(0.5) - run(2))).toBeLessThan(0.1);
    });
});

/** Settle a heap released from a steep loose cone, so blocks slump rather than plunge. */
function pour(mu, { count = 1500, r = 0.5, SB = null, groundZ = 0 } = {}) {
    const list = [];
    const coneRadius = Math.cbrt((3 * count * (2.15 * r) ** 3) / (Math.PI * Math.tan((70 * Math.PI) / 180)));
    const height = coneRadius * Math.tan((70 * Math.PI) / 180);
    const jitter = (i, s) => ((((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * s;
    for (let layer = 0, i = 0; list.length < count; layer++) {
        const z = 1.1 * r + layer * 2.15 * r;
        const R = Math.max(0, coneRadius * (1 - (z - r) / height)) + 0.5 * r;
        for (let x = -R; x <= R && list.length < count; x += 2.15 * r) for (let y = -R; y <= R && list.length < count; y += 2.15 * r, i++) {
            if (Math.hypot(x, y) > R) continue;
            list.push({ x: x + jitter(i, 0.1), y: y + jitter(i + 7, 0.1), z: groundZ + z, r: r * (0.85 + (((i * 40503) >>> 0) % 100) / 100 * 0.15) });
        }
    }
    const S = blocks(list, groundZ);
    let t = 0, rest = 0;
    const H = hashFor(S);
    const dt = 0.005;
    while (t < 30) {
        t += dt;
        const res = physicsStep(S, H, SB, dt, t, params(mu), () => 0.5);
        rest = res.resting;
        if (res.active === 0) break;
    }
    return { S, rest, t };
}

function reposeDeg(S) {
    // Least squares of top height against distance from the axis, on the flank only.
    let cx = 0, cy = 0;
    for (let i = 0; i < S.N; i++) { cx += S.px[i]; cy += S.py[i]; }
    cx /= S.N; cy /= S.N;
    const bins = new Map();
    for (let i = 0; i < S.N; i++) {
        const d = Math.hypot(S.px[i] - cx, S.py[i] - cy), b = Math.floor(d);
        bins.set(b, Math.max(bins.get(b) ?? 0, S.pz[i] + S.rad[i]));
    }
    const pts = [...bins.entries()].sort((a, b) => a[0] - b[0]);
    const peak = Math.max(...pts.map((p) => p[1]));
    const flank = pts.filter((p) => p[1] < 0.9 * peak && p[1] > 0.15 * peak);
    if (flank.length < 2) return 0;
    const mx = flank.reduce((s, p) => s + p[0], 0) / flank.length, my = flank.reduce((s, p) => s + p[1], 0) / flank.length;
    let num = 0, den = 0;
    for (const [x, y] of flank) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    return (Math.atan(-num / den) * 180) / Math.PI;
}

describe("angle of repose", () => {
    it("rises with friction and collapses without it", () => {
        const mus = [0.05, 0.2, 0.5, 0.9];
        const angles = mus.map((mu) => reposeDeg(pour(mu).S));
        for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
        expect(angles[0]).toBeLessThan(15);
        expect(angles[3]).toBeLessThan(70);
        // Bulk friction of a granular pile is no lower than the friction between its grains.
        mus.forEach((mu, i) => expect(angles[i]).toBeGreaterThan((Math.atan(mu) * 180) / Math.PI - 5));
    }, 90000);

    it("settles a pour with every block at rest", () => {
        const { S, rest } = pour(0.5);
        expect(rest / S.N).toBeGreaterThanOrEqual(0.99);
    }, 60000);
});

describe("shell contact is independent of mesh density", () => {
    const summary = (S) => {
        let z = 0, spread = 0;
        for (let i = 0; i < S.N; i++) { z += S.pz[i]; spread += Math.hypot(S.px[i], S.py[i]); }
        return { z: z / S.N, spread: spread / S.N };
    };
    it("one block lands the same on coarse and refined meshes", () => {
        const land = (n) => {
            const S = blocks([{ z: 8, vx: 5 }], -50);
            const SB = buildShellBin(plane(100, 0, 0, n));
            runUntil(S, SB, 0.005, params(0.5), 6);
            return [S.px[0], S.pz[0]];
        };
        const a = land(10), b = land(20), c = land(80);
        expect(Math.abs(a[0] - b[0])).toBeLessThan(0.01);
        expect(Math.abs(a[0] - c[0])).toBeLessThan(0.01);
        expect(Math.abs(a[1] - c[1])).toBeLessThan(0.01);
    });
    it("a pile rests the same when the mesh is refined 2x", () => {
        const pile = (n) => pour(0.5, { count: 500, SB: buildShellBin(plane(60, 0, 0, n)), groundZ: -5 });
        const coarse = pile(12), fine = pile(24);
        expect(coarse.rest / coarse.S.N).toBeGreaterThanOrEqual(0.99);
        expect(fine.rest / fine.S.N).toBeGreaterThanOrEqual(0.99);
    }, 60000);
    it("a pile keeps its shape on a tilted mesh when refined 2x", () => {
        const pile = (n) => pour(0.7, { count: 500, SB: buildShellBin(plane(120, 0, (10 * Math.PI) / 180, n)), groundZ: -40 }).S;
        const c = summary(pile(16)), f = summary(pile(32));
        expect(Math.abs(c.z - f.z)).toBeLessThan(0.3);
        expect(Math.abs(c.spread - f.spread)).toBeLessThan(0.5);
    }, 60000);
});

describe("swellBulk measures the volume a pile fills", () => {
    it("reads a lattice of touching spheres on a floor as its own volume", () => {
        // 10 x 10 x 4 spheres of radius 1 fill 20 x 20 x 8 m, floor at z = 0.
        const list = [];
        for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 4; c++) list.push({ x: 2 * a, y: 2 * b, z: 1 + 2 * c });
        const S = blocks(list);
        const bulk = swellBulk(S, { cell: 0.25, insituM3: 20 * 20 * 8, floorAt: () => 0 });
        // By hand: columns inside a sphere's disc (pi/4 of the area) read 7 + 2/3 m on average;
        // the gaps between four spheres reach the floor untouched, so they read nothing.
        const byHand = ((Math.PI / 4) * (7 + 2 / 3)) / 8;
        expect(Math.abs(bulk - byHand) / byHand).toBeLessThan(0.05);
    });
});

describe("sphereColumns rasters a sphere over column centres", () => {
    const grid = { gx0: 0, gy0: 0, cell: 1, nx: 4, ny: 4 };
    const columns = (x, y, r, g = grid) => {
        const seen = new Map();
        sphereColumns(x, y, r, g, (q, half) => seen.set(q, half));
        return seen;
    };
    it("gives the half-height over each centre the sphere covers", () => {
        const seen = columns(2, 2, 1);
        // Centres at 1.5 and 2.5: each 0.5 from the axis on both x and y.
        expect([...seen.keys()].sort((a, b) => a - b)).toEqual([5, 6, 9, 10]);
        for (const half of seen.values()) expect(half).toBeCloseTo(Math.sqrt(0.5), 12);
    });
    it("skips a column whose centre the sphere misses", () => {
        expect(columns(2, 2, 0.5).size).toBe(0);
    });
    it("stays inside the grid when the sphere overhangs it", () => {
        const seen = columns(0, 0, 1.2);
        expect([...seen.keys()]).toEqual([0]);
    });
});

/** Rock's bulk from the top of the spheres minus the shell: independent of the code's own measure. */
function bulkAboveShell(sim, shells) {
    const cell = 2, x0 = sim.origin.x - 250, y0 = sim.origin.y - 250;
    const floor = rasterTop(shells, { gx0: x0, gy0: y0, cell, nx: 250, ny: 250 });
    const top = floor.slice();
    for (let k = 0; k < sim.S.N; k++) {
        const r = sim.S.rad[k];
        const x = sim.S.px[k] + sim.origin.x, y = sim.S.py[k] + sim.origin.y, z = sim.S.pz[k] + sim.origin.z;
        const i0 = Math.floor((x - r - x0) / cell), i1 = Math.floor((x + r - x0) / cell);
        const j0 = Math.floor((y - r - y0) / cell), j1 = Math.floor((y + r - y0) / cell);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const h2 = r * r - (x0 + (i + 0.5) * cell - x) ** 2 - (y0 + (j + 0.5) * cell - y) ** 2;
            if (h2 > 0 && z + Math.sqrt(h2) > top[j * 250 + i]) top[j * 250 + i] = z + Math.sqrt(h2);
        }
    }
    let bulk = 0;
    for (let q = 0; q < top.length; q++) if (floor[q] > -1e8 && top[q] > floor[q]) bulk += (top[q] - floor[q]) * cell * cell;
    return bulk / sim.rockVolumeM3();
}

/**
 * A made-up bench, built through the same scenario code as Block B: a 20 m face looking east onto
 * a level floor, with a gentle cross-slope so nothing lines up with the voxel lattice.
 */
function syntheticBench() {
    const size = 240;
    const height = (x, y) => {
        const crest = 110, toe = 130;
        const ground = 100 + 0.02 * y;
        return x <= crest ? ground + 20 : x >= toe ? ground : ground + 20 * (toe - x) / (toe - crest);
    };
    const z = new Float64Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) z[j * size + i] = height(i + 0.5, j + 0.5);
    const grid = (values) => ({ cols: size, rows: size, x0: 0, y0: 0, cell: 1, z: values });
    const terrain = { dtm: grid(z), filled: grid(new Float64Array(size * size)) };
    return scenarioFromTerrain(terrain, [[80, 90], [122, 90], [122, 150], [80, 150]], {
        name: "synthetic-bench", floorZ: 102, twinVersion: "test", freeFace: "E",
        holePolygon: [[80, 90], [108, 90], [108, 150], [80, 150]],
    });
}

function lowestShell(scenario) {
    let lowest = Infinity;
    for (const s of scenario.surfaces) if (s.role === "shell" || s.role === "shelltopo") for (let i = 2; i < s.pos.length; i += 3) lowest = Math.min(lowest, s.pos[i]);
    return lowest;
}

const coulomb = (extra = {}) => ({ seed: 1, maxVoxels: 5000, contactModel: "coulomb", ...extra });

describe("full runs settle and keep their bulk", () => {
    it("SWELLFACTOR: 99% at rest; pile above the shell matches the prescribed and reported swell", async () => {
        const data = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
        const sim = new BlastMovementSimulator(coulomb()).load(data);
        const N = sim.generateVoxels();
        await sim.runAsync();
        const res = sim.results();
        expect(res.stats.resting / N).toBeGreaterThanOrEqual(0.99);

        // Independent of the code's own measure: the top of the spheres minus the shell.
        const measured = bulkAboveShell(sim, data.surfaces.filter((s) => s.role === "shell"));

        expect(res.swell).toBe(res.swellBulk);
        expect(Math.abs(measured - 1.4) / 1.4).toBeLessThan(0.1);
        expect(Math.abs(measured - res.swell) / measured).toBeLessThan(0.1);
    }, 120000);

    // sim/data is git-ignored, so a clean checkout (and CI) has no Block B. The synthetic bench below
    // runs everywhere, through the same scenario code; this one adds the real terrain when it's here.
    const BLOCK_B = "sim/data/scenarios/block-b-base";
    it.skipIf(!existsSync(BLOCK_B))("Block B: 99% at rest (skipped without the git-ignored sim/data)", async () => {
        const scenario = readScenario(BLOCK_B);
        const sim = new BlastMovementSimulator(coulomb({ groundZ: lowestShell(scenario) - 5 })).load(toSimData(scenario));
        const N = sim.generateVoxels();
        await sim.runAsync();
        expect(sim.results().stats.resting / N).toBeGreaterThanOrEqual(0.99);
    }, 120000);

    describe("a bench that isn't SWELLFACTOR", () => {
        // packingFraction came from a measurement on SWELLFACTOR, so the check above can't test it.
        it("settles with 99% at rest, and its bulk above the shell is within 10% of the set swell", async () => {
            const scenario = syntheticBench();
            const sim = new BlastMovementSimulator(coulomb({ groundZ: lowestShell(scenario) - 5 })).load(toSimData(scenario));
            const N = sim.generateVoxels();
            await sim.runAsync();
            const res = sim.results();
            expect(N).toBeGreaterThan(2000);
            expect(res.stats.resting / N).toBeGreaterThanOrEqual(0.99);
            const measured = bulkAboveShell(sim, scenario.surfaces.filter((s) => s.role === "shell"));
            expect(Math.abs(measured - 1.4) / 1.4).toBeLessThan(0.1);
        }, 120000);
    });
});

describe("swell under Coulomb counts only rock that has come to rest", () => {
    const lattice = () => {
        const list = [];
        for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 4; c++) list.push({ x: 2 * a, y: 2 * b, z: 1 + 2 * c });
        const S = blocks(list);
        S.state.fill(ST_REST);
        return S;
    };
    const opts = { cell: 0.25, insituM3: 20 * 20 * 8, floorAt: () => 0, restedOnly: true };

    it("ignores an airborne block, scaling the rock to what's counted", () => {
        const S = lattice();
        const settled = swellBulk(S, opts);
        // A corner column of four gone, flying 100 m above the middle: 396 of 400 blocks counted.
        for (const i of [0, 1, 2, 3]) { S.state[i] = ST_ACTIVE; S.px[i] = 10; S.py[i] = 10; S.pz[i] = 100 + 2 * i; }
        const flying = swellBulk(S, opts);
        expect(flying).toBeCloseTo(settled, 2);
    });
    it("is null while nothing has come to rest", () => {
        const S = lattice();
        S.state.fill(ST_ACTIVE);
        expect(swellBulk(S, opts)).toBeNull();
    });
    it("counts every fired block unless asked, as it always has", () => {
        const S = lattice();
        const settled = swellBulk(S, { ...opts, restedOnly: false });
        S.state[0] = ST_ACTIVE; S.pz[0] = 100;
        expect(swellBulk(S, { ...opts, restedOnly: false })).toBeGreaterThan(1.05 * settled);
    });
    it("doesn't read airborne rock as bulk in a run stopped at the time limit", async () => {
        // Eq 12-14 launch at its paper defaults throws hard: most rock is still flying at 8 s.
        const data = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
        const sim = new BlastMovementSimulator(coulomb({ velocityModel: "yang1990", maxVoxels: 3000 })).load(data);
        const N = sim.generateVoxels();
        sim.run({ maxTime: 8 });
        const res = sim.results();
        expect(res.stats.resting / N).toBeLessThan(0.9);
        expect(res.swell).toBeLessThan(1.4 * 1.1);
        expect(res.swell).toBe(res.swellBulk);
    }, 60000);
    it("leaves the default model's swellBulk reading every fired block", async () => {
        const data = await parseKAP(readFileSync("examples/SWELLFACTOR.kap"));
        const sim = new BlastMovementSimulator({ seed: 1, maxVoxels: 800 }).load(data);
        sim.generateVoxels();
        sim.run({ maxTime: 3 });
        const before = sim.results();
        const moving = sim.S.state.findIndex((s) => s === ST_ACTIVE);
        expect(moving).toBeGreaterThanOrEqual(0);
        sim.S.pz[moving] += 100;
        expect(sim.results().swellBulk).toBeGreaterThan(before.swellBulk);
    }, 60000);
});

describe("default stays what it was", () => {
    it("runs the old contact path unless asked", () => {
        const sim = new BlastMovementSimulator({ seed: 1 });
        expect(sim._P().contactModel).toBeUndefined();
    });
});

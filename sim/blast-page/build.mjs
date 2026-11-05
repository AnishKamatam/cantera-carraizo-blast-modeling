import { readFileSync as R, writeFileSync as W } from "node:fs";
// Builds the Block B blast page: runs each case, then writes sim/data/blast-page/site/.
// Usage: node sim/blast-page/build.mjs [--skip-capture]
// Needs sim/data (terrain and the block-b-zone scenario) and sim/data/blast-page/ortho-crop.jpg:
// a 190 m square of the twin's orthophoto around (-227.5, -31), 0.5 m per pixel. Both stay out of git.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdirSync as MK } from "node:fs";
const HERE = fileURLToPath(new URL(".", import.meta.url)),
  ROOT = fileURLToPath(new URL("../../", import.meta.url)),
  Z = ROOT + "sim/data/blast-page";
MK(Z + "/site", { recursive: true });
const run = promisify(execFile);
const COULOMB = { contactModel: "coulomb", friction: 0.5, maxSwell: 1.43 };
const CASES = [
  ["frag-mu05", "Central rock", "Rock factor 7, friction 0.5", 1, { ...COULOMB, sizeModel: "kuzram" }],
  [
    "frag-mu05-high",
    "Coarse rock",
    "Rock factor 13, friction 0.5",
    1,
    { ...COULOMB, sizeModel: "kuzram", rockFactorA: 13 },
  ],
  ["base-mu03", "Low friction", "Friction 0.3, no size model", 0, { ...COULOMB, friction: 0.3 }],
  ["base-mu07", "High friction", "Friction 0.7, no size model", 0, { ...COULOMB, friction: 0.7 }],
  [
    "yang-mu05",
    "Paper launch",
    "Yang & Kavetsky launch, Pe 30, Pd 0.002, friction 0.5, no size model",
    0,
    { ...COULOMB, velocityModel: "yang1990", PeAnfo: 30, Pd: 0.002 },
  ],
];
if (!process.argv.includes("--skip-capture"))
  await Promise.all(
    CASES.map(([k, , , , o]) =>
      run("node", [HERE + "capture.mjs", `${Z}/${k}.json`, "block-b-zone", JSON.stringify(o)], {
        maxBuffer: 1 << 26,
      }),
    ),
  );
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const out = [];
let shared;
for (const [k, title, desc, anim] of CASES) {
  const d = JSON.parse(R(`${Z}/${k}.json`));
  const { n, N, half } = d,
    F = d.times.length;
  const pb = Buffer.from(d.pos, "base64"),
    rb = Buffer.from(d.rot, "base64");
  const P = new Int16Array(pb.buffer, pb.byteOffset, pb.length / 2);
  const g = (f, i, c) => P[(f * n + i) * 3 + c] * 0.05;
  const base = new Float64Array(N * N);
  for (let q = 0; q < N * N; q++) base[q] = d.post[q] ?? d.pre[q] ?? NaN;
  const top = Float64Array.from(base);
  for (let i = 0; i < n; i++) {
    const x = g(F - 1, i, 0),
      y = g(F - 1, i, 1),
      z = g(F - 1, i, 2),
      r = d.rad[i];
    for (let b = Math.max(0, Math.floor(y - r + half)); b <= Math.min(N - 1, Math.ceil(y + r + half)); b++)
      for (
        let a = Math.max(0, Math.floor(x - r + half));
        a <= Math.min(N - 1, Math.ceil(x + r + half));
        a++
      ) {
        const dx = -half + a - x,
          dy = -half + b - y,
          s = r * r - dx * dx - dy * dy;
        if (s < 0) continue;
        const t = z + Math.sqrt(s),
          q = b * N + a;
        if (!(t <= top[q])) top[q] = t;
      }
  }
  let vol = 0,
    fp = 0,
    maxd = 0;
  const fpcells = [];
  for (let q = 0; q < N * N; q++) {
    const e = top[q] - base[q];
    if (e > 0) {
      vol += e;
      maxd = Math.max(maxd, e);
      if (e > 0.5) {
        fp++;
        fpcells.push(q);
      }
    }
  }
  const disp = [];
  let mx0 = 0,
    my0 = 0,
    mx1 = 0,
    my1 = 0;
  for (let i = 0; i < n; i++) {
    disp.push(Math.hypot(g(F - 1, i, 0) - g(0, i, 0), g(F - 1, i, 1) - g(0, i, 1)));
    mx0 += g(0, i, 0);
    my0 += g(0, i, 1);
    mx1 += g(F - 1, i, 0);
    my1 += g(F - 1, i, 1);
  }
  const bx = mx1 - mx0,
    by = my1 - my0,
    bl = Math.hypot(bx, by);
  let toe = -1e9;
  for (let i = 0; i < n; i++) toe = Math.max(toe, (g(0, i, 0) * bx + g(0, i, 1) * by) / bl);
  const a1 = [];
  for (let i = 0; i < n; i++) a1.push((g(F - 1, i, 0) * bx + g(F - 1, i, 1) * by) / bl);
  const m = {
    pileVolM3: Math.round(vol),
    footprintM2: fp,
    maxDepthM: +maxd.toFixed(1),
    dispP50: +pct(disp, 50).toFixed(1),
    dispP95: +pct(disp, 95).toFixed(1),
    dispP99: +pct(disp, 99).toFixed(1),
    dispMax: +Math.max(...disp).toFixed(1),
    frontP99: +(pct(a1, 99) - toe).toFixed(1),
    frontP95: +(pct(a1, 95) - toe).toFixed(1),
    over50: disp.filter((v) => v > 50).length,
    over100: disp.filter((v) => v > 100).length,
  };
  console.log(
    k,
    JSON.stringify({
      checks: d.checks,
      lastT: d.times.at(-1),
      rad: +(d.rad.reduce((a, b) => a + b) / n).toFixed(3),
      res: d.res,
      cx: d.cx,
      cy: d.cy,
      ...m,
    }),
  );
  if (!shared) {
    const enc = (a) => {
      const o = new Int16Array(N * N);
      a.forEach((v, q) => (o[q] = v == null ? -32768 : Math.round(v * 20)));
      return Buffer.from(o.buffer).toString("base64");
    };
    shared = {
      cx: d.cx,
      cy: d.cy,
      N,
      half,
      cell: d.cell,
      n,
      res: d.res,
      pre: enc(d.pre),
      post: enc(d.post),
      holes: d.holes,
    };
  }
  const c = { key: k, title, desc, anim, n, checks: d.checks, metrics: m, lastT: d.times.at(-1) };
  if (d.fragmentation) {
    c.frag = {
      x50: d.fragmentation.x50M,
      n: d.fragmentation.n,
      boulders: d.boulder.reduce((a, b) => a + (b ? 1 : 0), 0),
      largestCells: Math.max(...d.cells),
    };
    c.boulderIdx = [];
    d.boulder.forEach((b, i) => {
      if (b) c.boulderIdx.push(i);
    });
    console.log(k, JSON.stringify(c.frag));
  }
  const row = Math.floor(N / 2);
  c.top = Array.from({ length: N }, (_, a) => +(top[row * N + a] || 0).toFixed(2));
  if (anim) {
    c.times = d.times;
    c.rest = d.rest;
    c.fire = d.fire;
    c.rad = d.rad;
    for (const [nm, b] of [
      ["pos", pb],
      ["rot", rb],
    ])
      W(
        `${Z}/site/${k}-${nm}.js`,
        `window.BLASTDATA=window.BLASTDATA||{};window.BLASTDATA[${JSON.stringify(k + "-" + nm)}]="${b.toString("base64")}";\n`,
      );
  }
  out.push(c);
}
const crop = { cx: -227.5, cy: -31, half: 95, b64: R(Z + "/ortho-crop.jpg").toString("base64") };
// Broken-rock volume and range come from scripts/estimate-volume.mjs on the same scenario.
const zone = JSON.parse(R(ROOT + "sim/data/scenarios/block-b-zone/scenario.json")).zone;
const meta = { shared, cases: out, crop, volumeM3: { central: zone.volumeM3, low: 3530, high: 43987 } };
W(
  Z + "/site/block-b-blast.html",
  R(HERE + "template.html", "utf8").replace("@@META@@", () => JSON.stringify(meta)),
);
console.log("wrote", Z + "/site");

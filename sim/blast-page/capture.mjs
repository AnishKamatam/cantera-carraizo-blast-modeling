import { writeFileSync } from "node:fs";
// Runs one Block B scenario and records block positions over time for the blast page.
// Usage: node sim/blast-page/capture.mjs <out.json> <scenario-name> '<simulator options JSON>'
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../../", import.meta.url));
const { readScenario, toSimData } = await import(R + "sim/scenario/io.js");
const { BlastMovementSimulator: B, SUB_DT } = await import(R + "src/movement/BlastMovementSimulator.js");
const { loadTerrain, heightAt } = await import(R + "sim/scenario/terrain.js");
const { rasterTop } = await import(R + "src/movement/SurfaceMesh.js");
const [, , out, name, extraText] = process.argv;
const extra = JSON.parse(extraText || "{}");
const s = readScenario(R + "sim/data/scenarios/" + name),
  t = loadTerrain(R + "sim/data/full");
const shell = s.surfaces.filter((x) => x.role === "shell"),
  vol = s.surfaces.find((x) => x.role === "voxelblk");
let lo = 1e9;
for (let i = 2; i < shell[0].pos.length; i += 3) lo = Math.min(lo, shell[0].pos[i]);
const sim = new B({
  seed: 1,
  groundZ: lo - 5,
  voxelRes: 1,
  maxVoxels: 30000,
  rockDensity: s.assumptions.rockDensityKgM3.value,
  ...extra,
}).load(toSimData(s));
const n = sim.generateVoxels(),
  S = sim.S,
  o = sim.origin;
console.error("blocks", n, "res", sim.actualRes);
const xs = vol.pos.filter((_, i) => i % 3 == 0),
  ys = vol.pos.filter((_, i) => i % 3 == 1);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
  cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const times = [];
for (let x = 0.05; x <= 2.0001; x += 0.05) times.push(+x.toFixed(2));
for (let x = 2.25; x <= sim.lastFireT + 12; x += 0.5) times.push(+x.toFixed(2));
const pos = [],
  rot = [],
  ts = [],
  res = [];
const snap = () => {
  const p = new Int16Array(n * 3),
    r = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[i * 3] = Math.round((S.px[i] + o.x - cx) / 0.05);
    p[i * 3 + 1] = Math.round((S.py[i] + o.y - cy) / 0.05);
    p[i * 3 + 2] = Math.round((S.pz[i] + o.z) / 0.05);
    r[i * 3] = Math.round(((S.rx[i] % 6.2832) / 6.2832) * 127);
    r[i * 3 + 1] = Math.round(((S.ry[i] % 6.2832) / 6.2832) * 127);
    r[i * 3 + 2] = Math.round(((S.rz[i] % 6.2832) / 6.2832) * 127);
  }
  pos.push(p);
  rot.push(r);
  ts.push(+sim.time.toFixed(3));
  res.push(sim.stats.resting);
};
snap();
sim.fire();
let next = 0;
const lim = sim.lastFireT + 12,
  t0 = Date.now();
while (sim.time < lim && !sim.isSettled()) {
  sim.step(SUB_DT);
  if (next < times.length && sim.time >= times[next]) {
    snap();
    next++;
  }
}
if (ts.at(-1) < sim.time - 1e-6) snap();
const half = 95,
  cell = 1,
  N = (half * 2) / cell + 1,
  pre = [],
  post = [],
  G = { gx0: cx - half - 0.5, gy0: cy - half - 0.5, cell, nx: N, ny: N },
  sh = rasterTop(shell, G);
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const x = cx - half + i,
      y = cy - half + j,
      z = heightAt(t.dtm, x, y);
    pre.push(Number.isNaN(z) || z === 0 ? null : +z.toFixed(2));
    const q = sh[j * N + i];
    post.push(q > -1e8 ? +q.toFixed(2) : null);
  }
const P = Buffer.concat(pos.map((a) => Buffer.from(a.buffer))),
  Q = Buffer.concat(rot.map((a) => Buffer.from(a.buffer)));
const rad = Array.from(S.rad).map((v) => +v.toFixed(2)),
  fire = Array.from(S.at).map((v) => +v.toFixed(3));
const r = sim.results();
const F = r.fragmentation || null;
const BS = sim.blockSizes();
writeFileSync(
  out,
  JSON.stringify({
    fragmentation: F,
    cells: Array.from(BS.cells),
    boulder: Array.from(BS.boulder),
    representedM3: Array.from(BS.representedM3).map((v) => +v.toFixed(3)),
    cx,
    cy,
    x0: t.dtm.x0,
    y0: t.dtm.y0,
    rows: t.dtm.rows,
    cols: t.dtm.cols,
    cellM: t.dtm.cell,
    half,
    cell,
    N,
    pre,
    post,
    n,
    res: sim.actualRes,
    times: ts,
    rest: res,
    fire,
    rad,
    holes: s.holes.map((h) => [
      +(h.collarX - cx).toFixed(2),
      +(h.collarY - cy).toFixed(2),
      +h.collarZ.toFixed(2),
      h.holeTime,
    ]),
    pos: P.toString("base64"),
    rot: Q.toString("base64"),
    checks: {
      throw: +r.comShift.D.toFixed(2),
      bearing: +r.comShift.bearing.toFixed(1),
      blocks: n,
      restFraction: +(r.stats.resting / n).toFixed(3),
      settled: r.settled,
      chargeKg: Math.round(s.decks.reduce((a, d) => a + d.mass, 0)),
    },
  }),
);
console.error(
  "done",
  (Date.now() - t0) / 1000,
  "s frames",
  ts.length,
  JSON.stringify({ throw: r.comShift.D, bearing: r.comShift.bearing, rest: r.stats.resting / n }),
);

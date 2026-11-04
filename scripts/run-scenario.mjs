#!/usr/bin/env node
// Usage: node scripts/run-scenario.mjs <scenarioDir> [--seed N] [--max-voxels N] [--out DIR]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readScenario } from "../sim/scenario/io.js";
import { runFastModels } from "../sim/run.js";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        seed: { type: "string" },
        "max-voxels": { type: "string" },
        out: { type: "string" },
    },
});

if (positionals.length !== 1) {
    console.error("Usage: run-scenario <scenarioDir> [--seed N] [--max-voxels N] [--out DIR]");
    process.exit(2);
}

const scenario = readScenario(positionals[0]);
const results = await runFastModels(scenario, {
    seed: values.seed === undefined ? 1 : Number(values.seed),
    maxVoxels: values["max-voxels"] === undefined ? 30000 : Number(values["max-voxels"]),
});

const out = values.out || join("sim", "out", scenario.name);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
console.log(`${results.calibration}: ${scenario.name}, ${results.throw.blockCount} blocks, settled ${results.throw.settled}, wrote ${join(out, "results.json")}`);

#!/usr/bin/env node
// Write a scenario as Kirra project JSON, for examples/throw.html or parseKAP.
// Usage: node scripts/export-kap.mjs <scenarioDir> <out.kap>

import { writeFileSync } from "node:fs";
import { readScenario } from "../sim/scenario/io.js";
import { scenarioToKap } from "../sim/scenario/toKap.js";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
    console.error("Usage: export-kap <scenarioDir> <out.kap>");
    process.exit(2);
}
writeFileSync(out, JSON.stringify(scenarioToKap(readScenario(dir))));
console.log(`wrote ${out}`);

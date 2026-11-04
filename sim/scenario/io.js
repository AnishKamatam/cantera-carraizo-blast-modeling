/**
 * Scenario files: scenario.json plus surfaces/<id>.pos (Float64 xyz) and
 * surfaces/<id>.idx (Uint32 triangles), the same layout .kap sidecars use.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateScenario } from "./schema.js";

function typedFrom(buffer, Type) {
    const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Type(copy);
}

export function writeScenario(dir, s) {
    validateScenario(s);
    mkdirSync(join(dir, "surfaces"), { recursive: true });
    const surfaces = s.surfaces.map((surface) => {
        const { pos, idx, ...rest } = surface;
        writeFileSync(join(dir, "surfaces", `${surface.id}.pos`), Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
        writeFileSync(join(dir, "surfaces", `${surface.id}.idx`), Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
        return rest;
    });
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...s, surfaces }, null, 1));
}

export function readScenario(dir) {
    const s = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
    s.surfaces = s.surfaces.map((surface) => ({
        ...surface,
        pos: typedFrom(readFileSync(join(dir, "surfaces", `${surface.id}.pos`)), Float64Array),
        idx: typedFrom(readFileSync(join(dir, "surfaces", `${surface.id}.idx`)), Uint32Array),
    }));
    return validateScenario(s);
}

/** The object BlastMovementSimulator.load() takes. */
export function toSimData(s) {
    return { holes: s.holes, decks: s.decks, surfaces: s.surfaces };
}

/** Build a scenario from parseKAP output. Its design and surfaces are real records. */

import { validateScenario } from "./schema.js";

function safeId(surface, index, used) {
    const base = String(surface.id || surface.name || `surface-${index}`).replace(/[^A-Za-z0-9._-]/g, "_");
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
}

export function scenarioFromKap(parsed, { name }) {
    const used = new Set();
    return validateScenario({
        version: 1,
        name,
        origin: null,
        twin: null,
        holes: parsed.holes,
        decks: parsed.decks,
        surfaces: parsed.surfaces.map((surface, index) => ({ ...surface, id: safeId(surface, index, used) })),
        assumptions: {},
        measured: ["holes", "decks", "surfaces"],
    });
}

/**
 * Assumed blast design. The quarry keeps no blast records, so every value here is
 * a labelled assumption with a range for later sweeps, never Carraizo data.
 */

import { createHoleEntry } from "../../src/core/HoleEntry.js";
import { createDeckEntry } from "../../src/core/DeckEntry.js";
import { assumption, validateScenario } from "./schema.js";
import { cutBlock, insidePolygon } from "./block.js";
import { heightAt } from "./terrain.js";

const TYPICAL = "typical quarry value, not Carraizo data";

export const DEFAULT_DESIGN = Object.freeze({
    holeDiamMm: assumption(115, [89, 140], TYPICAL),
    burdenM: assumption(3.5, [2.5, 4.5], TYPICAL),
    spacingM: assumption(4.0, [3.0, 5.5], TYPICAL),
    subdrillM: assumption(1.0, [0.5, 1.5], TYPICAL),
    stemmingM: assumption(2.5, [2.0, 3.5], TYPICAL),
    explosiveDensityKgL: assumption(1.15, [0.85, 1.25], TYPICAL),
    vodMs: assumption(4500, [3500, 5500], TYPICAL),
    holeDelayMs: assumption(17, [9, 42], TYPICAL),
    rowDelayMs: assumption(42, [25, 100], TYPICAL),
    rockDensityKgM3: assumption(2650, [2400, 2800], TYPICAL),
    siteLawK: assumption(1140, [500, 1800], TYPICAL),
    siteLawB: assumption(1.6, [1.3, 1.8], TYPICAL),
    rockType: { value: "unconfirmed", source: "no site geology available" },
});

function resolveDesign(overrides) {
    const design = { ...DEFAULT_DESIGN };
    for (const [name, value] of Object.entries(overrides)) {
        const base = DEFAULT_DESIGN[name];
        if (!base) throw new Error(`generatePattern: unknown design value ${name}`);
        const source = `override of: ${base.source}`;
        design[name] = typeof value === "number"
            ? assumption(value, [Math.min(value, base.range[0]), Math.max(value, base.range[1])], source)
            : { value, source };
    }
    return design;
}

/** Vertical holes on a rectangular grid inside the polygon, with rows firing from the south. */
export function generatePattern(block, terrain, overrides = {}) {
    const assumptions = resolveDesign(overrides);
    const v = Object.fromEntries(Object.entries(assumptions).map(([name, record]) => [name, record.value]));
    const xs = block.polygon.map((p) => p[0]), ys = block.polygon.map((p) => p[1]);
    const areaM2 = Math.PI * (v.holeDiamMm / 2000) ** 2;

    const holes = [], decks = [];
    let row = 0;
    for (let y = Math.min(...ys) + v.burdenM / 2; y < Math.max(...ys); y += v.burdenM, row++) {
        let column = 0;
        for (let x = Math.min(...xs) + v.spacingM / 2; x < Math.max(...xs); x += v.spacingM, column++) {
            if (!insidePolygon(x, y, block.polygon)) continue;
            const collarZ = heightAt(terrain.dtm, x, y);
            if (Number.isNaN(collarZ)) continue;
            const toeZ = block.floorZ - v.subdrillM;
            const topZ = collarZ - v.stemmingM;
            if (topZ <= toeZ) continue;

            const holeTime = row * v.rowDelayMs + column * v.holeDelayMs;
            const mass = areaM2 * (topZ - toeZ) * v.explosiveDensityKgL * 1000;
            const holeIndex = holes.length;
            holes.push({
                ...createHoleEntry({
                    entityName: "assumed", holeID: String(holeIndex + 1),
                    collarX: x, collarY: y, collarZ, toeX: x, toeY: y, toeZ,
                    holeDiamMm: v.holeDiamMm, benchHeight: collarZ - block.floorZ,
                    subdrillLength: v.subdrillM, holeTime,
                }),
                burden: v.burdenM, spacing: v.spacingM, gradeZ: block.floorZ, massPerHole: mass,
            });
            decks.push(createDeckEntry({
                deckType: "COUPLED",
                topX: x, topY: y, topZ, baseX: x, baseY: y, baseZ: toeZ,
                mass, density: v.explosiveDensityKgL, vod: v.vodMs,
                productName: "assumed bulk explosive", holeDiamMm: v.holeDiamMm,
                timingMs: holeTime, holeIndex,
            }));
        }
    }
    if (holes.length === 0) throw new Error("generatePattern: no holes fit in the polygon");
    return { holes, decks, assumptions };
}

export function scenarioFromTerrain(terrain, polygon, { name, floorZ, overrides = {}, twinVersion, origin = null, block: blockOptions = {} }) {
    const block = cutBlock(terrain, polygon, { floorZ, ...blockOptions });
    const { holes, decks, assumptions } = generatePattern(block, terrain, overrides);
    return validateScenario({
        version: 1,
        name,
        origin,
        twin: { version: twinVersion, filledFraction: block.filledFraction },
        holes,
        decks,
        surfaces: [block.volume, block.topo],
        assumptions,
        measured: ["surfaces"],
    });
}

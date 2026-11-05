/**
 * Write a scenario as Kirra project JSON, which parseKAP and examples/throw.html load.
 * Surface names set their roles in KAPReader: SHELL, PREBLAST_VOLUME, PREBLAST_SURFACE.
 */

const NAMES = { voxelblk: "PREBLAST_VOLUME", shell: "SHELL", other: "PREBLAST_SURFACE" };

function surfaceJson(surface) {
    const points = [];
    for (let i = 0; i < surface.pos.length; i += 3) points.push({ x: surface.pos[i], y: surface.pos[i + 1], z: surface.pos[i + 2] });
    const triangles = [];
    for (let t = 0; t < surface.idx.length; t += 3) triangles.push({ a: surface.idx[t], b: surface.idx[t + 1], c: surface.idx[t + 2] });
    const name = NAMES[surface.role] || surface.name;
    return { id: name, name, type: "triangulated", visible: true, points, triangles };
}

export function scenarioToKap(scenario) {
    const entityName = scenario.name;
    const holes = scenario.holes.map((h) => ({
        entityName, entityType: "hole", holeID: h.holeID,
        startXLocation: h.collarX, startYLocation: h.collarY, startZLocation: h.collarZ,
        endXLocation: h.toeX, endYLocation: h.toeY, endZLocation: h.toeZ,
        gradeZLocation: h.gradeZ, subdrillAmount: h.subdrillLength, benchHeight: h.benchHeight,
        holeDiameter: h.holeDiamMm, holeType: h.holeType, holeTime: h.holeTime,
        burden: h.burden, spacing: h.spacing, visible: true,
    }));
    const charging = scenario.holes.map((h, index) => {
        const deck = scenario.decks.find((d) => d.holeIndex === index);
        const topDepth = h.collarZ - deck.topZ, baseDepth = h.collarZ - deck.baseZ;
        return [`${entityName}:::${h.holeID}`, {
            holeID: h.holeID, entityName, holeDiameterMm: h.holeDiamMm,
            decks: [{
                deckID: `deck-${h.holeID}`, holeID: h.holeID, deckType: deck.deckType, topDepth, baseDepth,
                product: { name: deck.productName, productCategory: "BulkExplosive", density: deck.density, vodMs: deck.vod },
            }],
            primers: [],
        }];
    });
    return {
        manifest: { kapVersion: "1.0.0", application: "cantera-carraizo-blast-modeling", projectName: scenario.name, calibration: "uncalibrated" },
        holes, charging, products: [],
        surfaces: scenario.surfaces.filter((s) => NAMES[s.role]).map(surfaceJson),
    };
}

/**
 * Blast scenario format. Holes, decks and surfaces use the shapes parseKAP
 * returns. Every assumed value carries its range and source, so nothing assumed
 * can pass for measured site data.
 */

const SURFACE_ROLES = ["voxelblk", "shell", "shelltopo", "reference", "other"];

/** A labelled assumed number. */
export function assumption(value, range, source) {
    if (!source) throw new Error("assumption: source is required");
    if (!Array.isArray(range) || range.length !== 2 || !(range[0] <= value && value <= range[1])) {
        throw new Error(`assumption: range must be [low, high] containing ${value}`);
    }
    return { value, range, source };
}

function checkAssumption(name, record) {
    const fail = () => {
        throw new Error(`scenario: assumption ${name} needs a value and a source, plus a range if numeric`);
    };
    if (record === null || typeof record !== "object" || !record.source) fail();
    if (typeof record.value === "number") {
        const r = record.range;
        if (!Array.isArray(r) || r.length !== 2 || !(r[0] <= record.value && record.value <= r[1])) fail();
    } else if (typeof record.value !== "string") {
        fail();
    }
}

/** Returns the scenario, or throws an Error naming the first problem. */
export function validateScenario(s) {
    if (!s || s.version !== 1) throw new Error("scenario: version must be 1");
    if (!s.name) throw new Error("scenario: name is required");
    if (!Array.isArray(s.holes) || s.holes.length === 0) throw new Error("scenario: holes must not be empty");
    if (!Array.isArray(s.decks)) throw new Error("scenario: decks must be an array");
    if (!Array.isArray(s.surfaces)) throw new Error("scenario: surfaces must be an array");
    if (!Array.isArray(s.measured)) throw new Error("scenario: measured must be an array");
    if (!s.assumptions || typeof s.assumptions !== "object") throw new Error("scenario: assumptions must be an object");
    for (const [name, record] of Object.entries(s.assumptions)) checkAssumption(name, record);
    if (s.block && !(Array.isArray(s.block.polygon) && Number.isFinite(s.block.floorZ))) {
        throw new Error("scenario: block needs a polygon and floorZ");
    }
    for (const surface of s.surfaces) {
        if (!surface.id) throw new Error("scenario: every surface needs an id");
        if (!SURFACE_ROLES.includes(surface.role)) {
            throw new Error(`scenario: surface ${surface.id} has unknown role ${surface.role}`);
        }
        if (!(surface.pos instanceof Float64Array) || !(surface.idx instanceof Uint32Array)) {
            throw new Error(`scenario: surface ${surface.id} needs Float64Array pos and Uint32Array idx`);
        }
    }
    return s;
}

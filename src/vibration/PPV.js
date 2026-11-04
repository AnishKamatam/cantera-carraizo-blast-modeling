/**
 * PPV.js — Simple site-law Peak Particle Velocity
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * Formula: PPV = K × (D / Q^e)^(-B)
 * where D = distance, Q = charge mass, e = charge exponent (0.5 for SD)
 *
 * Point source is at charge centroid (midpoint of charge column).
 * Extracted from Kirra's PPVModel.js GLSL fragment shader.
 */

import { groupByDelay } from "../core/ChargeColumns.js";

/**
 * Compute PPV for a single charge at a single observation point.
 *
 * @param {{ x:number, y:number, z:number }} point - Observation point (m)
 * @param {{ x:number, y:number, z:number }} centroid - Charge centroid (m)
 * @param {number} mass   - Charge mass (kg)
 * @param {Object} params - Site law parameters
 * @param {number} [params.K=1140]              - Site constant
 * @param {number} [params.B=1.6]               - Site exponent
 * @param {number} [params.chargeExponent=0.5]  - e (0.5 = square-root)
 * @param {number} [params.cutoffDistance=1.0]  - Minimum distance (m)
 * @returns {number} PPV (mm/s)
 */
export function computePointPPV(point, centroid, mass, params) {
    var p = Object.assign({ K: 1140, B: 1.6, chargeExponent: 0.5, cutoffDistance: 1.0 }, params || {});
    if (mass <= 0) return 0;
    var dx = point.x - centroid.x;
    var dy = point.y - centroid.y;
    var dz = point.z - centroid.z;
    var dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), p.cutoffDistance);
    var sd = dist / Math.pow(mass, p.chargeExponent);
    return p.K * Math.pow(sd, -p.B);
}

/**
 * Compute peak PPV at a point from an array of DeckEntries.
 *
 * Takes the maximum PPV across all charged decks evaluated at their midpoint.
 *
 * @param {{ x:number, y:number, z:number }} point - Observation point (m)
 * @param {Array}  deckEntries - Array of DeckEntry objects
 * @param {Object} params      - Site law parameters, plus delayWindowMs (default 8; null = per deck) (K, B, chargeExponent, cutoffDistance)
 * @returns {number} Peak PPV (mm/s)
 */
export function computePPV(point, deckEntries, params) {
    var p = Object.assign({ K: 1140, B: 1.6, chargeExponent: 0.5, cutoffDistance: 1.0, delayWindowMs: 8 }, params || {});
    var peakPPV = 0.0;
    var charged = deckEntries.filter(function (dk) { return dk.mass > 0; });
    var groups = groupByDelay(charged, function (dk) { return dk.timingMs || 0; }, p.delayWindowMs);
    for (var g = 0; g < groups.length; g++) {
        var mass = 0, nearest = null, nearestD2 = Infinity;
        for (var i = 0; i < groups[g].length; i++) {
            var dk = groups[g][i];
            mass += dk.mass;
            var cx = (dk.topX + dk.baseX) * 0.5, cy = (dk.topY + dk.baseY) * 0.5, cz = (dk.topZ + dk.baseZ) * 0.5;
            var d2 = (point.x - cx) * (point.x - cx) + (point.y - cy) * (point.y - cy) + (point.z - cz) * (point.z - cz);
            if (d2 < nearestD2) { nearestD2 = d2; nearest = { x: cx, y: cy, z: cz }; }
        }
        var ppv = computePointPPV(point, nearest, mass, p);
        if (ppv > peakPPV) peakPPV = ppv;
    }
    return peakPPV;
}

/**
 * PPVModel class — configurable site-law PPV model.
 */
export class PPVModel {
    /**
     * @param {Object} params - { K, B, chargeExponent, cutoffDistance }
     */
    constructor(params) {
        this.params = Object.assign({
            K: 1140,
            B: 1.6,
            chargeExponent: 0.5,
            cutoffDistance: 1.0
        }, params || {});
    }

    /**
     * Evaluate peak PPV at a single point.
     * @param {{ x:number, y:number, z:number }} point
     * @param {Array} deckEntries
     * @returns {number} PPV (mm/s)
     */
    evaluate(point, deckEntries) {
        return computePPV(point, deckEntries, this.params);
    }

    /**
     * Compute a 2D grid of PPV values on a horizontal plane.
     * @param {Array}  deckEntries
     * @param {Object} gridParams  - { minX, minY, rows, cols, cellX, cellY, elevation }
     * @returns {{ data: Float32Array, rows, cols, minX, minY, cellX, cellY, elevation, unit, model }}
     */
    computeGrid(deckEntries, gridParams) {
        var gp = gridParams;
        var data = new Float32Array(gp.rows * gp.cols);
        for (var r = 0; r < gp.rows; r++) {
            for (var c = 0; c < gp.cols; c++) {
                var x = gp.minX + c * gp.cellX;
                var y = gp.minY + r * gp.cellY;
                data[r * gp.cols + c] = this.evaluate({ x: x, y: y, z: gp.elevation }, deckEntries);
            }
        }
        return {
            data: data,
            rows: gp.rows,
            cols: gp.cols,
            minX: gp.minX,
            minY: gp.minY,
            cellX: gp.cellX,
            cellY: gp.cellY,
            elevation: gp.elevation,
            unit: "mm/s",
            model: "PPV"
        };
    }
}

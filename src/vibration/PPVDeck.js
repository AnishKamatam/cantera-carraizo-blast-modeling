/**
 * PPVDeck.js — Per-deck Peak Particle Velocity
 *
 * Author: Brent Buffham — blastingapps.com & kirra-design.com
 * License: MIT
 *
 * Evaluates PPV at 3 positions along each deck (top, centre, base),
 * takes max across all decks. Each deck uses its own mass.
 *
 * Formula per evaluation point: PPV = K × (D / Q^e)^(-B)
 * Extracted from Kirra's PPVDeckModel.js GLSL fragment shader.
 */

import { groupByDelay } from "../core/ChargeColumns.js";

/**
 * Compute per-deck PPV at an observation point.
 *
 * @param {{ x:number, y:number, z:number }} point - Observation point (m)
 * @param {Array}  deckEntries - Array of DeckEntry objects
 * @param {Object} params      - { K, B, chargeExponent, cutoffDistance }
 * @returns {number} Peak PPV (mm/s)
 */
export function computePPVDeck(point, deckEntries, params) {
    var p = Object.assign({
        K: 1140,
        B: 1.6,
        chargeExponent: 0.5,
        cutoffDistance: 1.0,
        delayWindowMs: 8
    }, params || {});

    var peakPPV = 0.0;
    var K = p.K, B = p.B, ce = p.chargeExponent, cutoff = p.cutoffDistance;
    var charged = deckEntries.filter(function (dk) { return dk.mass > 0; });
    var groups = groupByDelay(charged, function (dk) { return dk.timingMs || 0; }, p.delayWindowMs);

    for (var g = 0; g < groups.length; g++) {
        var mass = 0, nearest = Infinity;
        for (var d = 0; d < groups[g].length; d++) {
            var dk = groups[g][d];
            mass += dk.mass;
            // Nearest of the deck's top, middle and base.
            var ends = [
                [dk.topX, dk.topY, dk.topZ],
                [(dk.topX + dk.baseX) * 0.5, (dk.topY + dk.baseY) * 0.5, (dk.topZ + dk.baseZ) * 0.5],
                [dk.baseX, dk.baseY, dk.baseZ],
            ];
            for (var e = 0; e < 3; e++) {
                var dx = point.x - ends[e][0], dy = point.y - ends[e][1], dz = point.z - ends[e][2];
                var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist < nearest) nearest = dist;
            }
        }
        var ppv = K * Math.pow(Math.max(nearest, cutoff) / Math.pow(mass, ce), -B);
        if (ppv > peakPPV) peakPPV = ppv;
    }

    return peakPPV;
}

/**
 * PPVDeckModel class — per-deck PPV model.
 */
export class PPVDeckModel {
    constructor(params) {
        this.params = Object.assign({
            K: 1140,
            B: 1.6,
            chargeExponent: 0.5,
            cutoffDistance: 1.0
        }, params || {});
    }

    evaluate(point, deckEntries) {
        return computePPVDeck(point, deckEntries, this.params);
    }

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
            model: "PPVDeck"
        };
    }
}

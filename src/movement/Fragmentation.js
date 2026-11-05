/**
 * Fragmentation.js: uncalibrated Kuz-Ram fragment-size estimate.
 *
 *   x50 (cm) = A K^-0.8 Q^(1/6) (115 / RWS)^(19/20)              adapted Kuznetsov equation
 *   n = (2.2 - 14 B/d) sqrt((1 + S/B) / 2) (1 - W/B)
 *       (|BCL - CCL| / L + 0.1)^0.1 (L / H)                      uniformity index, B in m, d in mm
 *   R(x) = exp(-0.693 (x / x50)^n)                               share retained on a screen of size x
 *
 * NOT FOR SAFETY DECISIONS, AND NOT CALIBRATED. No fragment size has been measured at
 * Carraizo or for SWELLFACTOR, so nothing here has been checked against either site.
 *
 * Evidence: none of Cunningham 1983, 1987 or 2005 was read. All forms are SECONDARY, from papers
 * that restate them; docs/verification/README.md lists them and what could be reproduced.
 * - The 19/20 exponent is the 2005 form (Jug et al. 2017, Agyei & Asssua 2022, Adebola et al.
 *   2016 Eq 6). The 1983/87 form uses 19/30 (Adebola et al. 2016 Eq 1, Saadoun et al. 2022).
 *   At RWS 83 the choice moves x50 by about 11%. Pass `rwsExponent` for the other.
 * - The 2005 terms A_T (timing), C(A) and C(n) are left at 1: there is no data to set them.
 * - Jug et al. 2017 Eq 1 prints K^0.8, which can't be right: the worked tables and the other
 *   sources have rock getting finer as powder factor rises.
 */

export var RWS_EXPONENT_2005 = 19 / 20;
export var RWS_EXPONENT_1987 = 19 / 30;

/** Rock factor A. Not measured at Carraizo, whose rock type is unconfirmed. */
export var ROCK_FACTOR = {
    low: 4,          // Jug et al. 2017: limestone, 4.0 before and 3.8 after calibration; Agyei & Asssua 2022: 5.0
    central: 7,      // Mohamed et al. 2019: limestone, 7.14; Jug et al. 2017 Fig 3 spans 5.0 to 8.6
    high: 13,        // web calculator citing Cunningham: "hard" 11-13; 7/10/13 classes recalled, not read
    publishedMin: 0.8,
    publishedMax: 22, // range as restated by Jug et al. 2017 and Agyei & Asssua 2022
    evidence: "SECONDARY for each value; the choice among them is judgement. Sources are mostly limestone, " +
        "and no source is for this rock."
};

/** Weight strength, ANFO = 100, TNT = 115. Not known for this site's explosive. */
export var RELATIVE_WEIGHT_STRENGTH = {
    central: 83,     // Agyei & Asssua 2022: Riomex 8000, 80% emulsion, 1.2 g/cm3, "relative weight energy" 83%
    high: 120,       // top of "Emulsion: 90-120" on a web calculator: weakest source used here
    assumed: "Bulk emulsion or an emulsion-rich blend, because the assumed 1.24 g/cm3 is too dense for plain ANFO",
    evidence: "SECONDARY for 83; UNVERIFIED web figure for 120"
};

/** Standard deviation of drilling error (m). Adebola et al. 2016 Table 1: SECONDARY, another site. */
export var DRILL_ERROR_M = 0.3;

/**
 * Size cases, the Low, Central and High rows of docs/verification/README.md. Low: finest rock. High:
 * coarsest. Fixed before any simulation result was seen, but after rough sums at A of 10 and 22, so
 * not a fully blind choice.
 */
export var FRAGMENTATION_CASES = {
    low: { A: ROCK_FACTOR.low, RWS: RELATIVE_WEIGHT_STRENGTH.high },
    central: { A: ROCK_FACTOR.central, RWS: RELATIVE_WEIGHT_STRENGTH.central },
    high: { A: ROCK_FACTOR.high, RWS: RELATIVE_WEIGHT_STRENGTH.central }
};

function fail(what) { throw new RangeError("Kuz-Ram: " + what); }

function positive(name, v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(name + " must be a positive number, got " + v);
    return v;
}

/**
 * Median size (the sources call it mean size).
 * @param {{A, K, Q, RWS, rwsExponent?}} v - K kg/m3, Q kg per hole, RWS with ANFO = 100
 * @returns {number} cm
 */
export function meanSizeCm(v) {
    positive("rock factor A", v.A);
    if (v.A < ROCK_FACTOR.publishedMin || v.A > ROCK_FACTOR.publishedMax) {
        fail("rock factor A must lie in the published " + ROCK_FACTOR.publishedMin + " to " + ROCK_FACTOR.publishedMax + ", got " + v.A);
    }
    positive("powder factor K", v.K); positive("charge per hole Q", v.Q); positive("RWS", v.RWS);
    var exponent = v.rwsExponent != null ? positive("rwsExponent", v.rwsExponent) : RWS_EXPONENT_2005;
    return v.A * Math.pow(v.K, -0.8) * Math.pow(v.Q, 1 / 6) * Math.pow(115 / v.RWS, exponent);
}

/**
 * Uniformity index. Burden, spacing and lengths in m, diameter in mm: the 14 B/d term
 * needs those mixed units, so a diameter in metres comes out negative and is rejected.
 * @param {{B, S, dMm, W, BCL, CCL, L, H}} v
 * @returns {number}
 */
export function uniformityIndex(v) {
    positive("burden B", v.B); positive("spacing S", v.S); positive("hole diameter dMm", v.dMm);
    positive("charge length L", v.L); positive("bench height H", v.H);
    var checks = { "drill error W": v.W, "bottom charge BCL": v.BCL, "column charge CCL": v.CCL };
    for (var name in checks) {
        if (typeof checks[name] !== "number" || !Number.isFinite(checks[name]) || checks[name] < 0) fail(name + " must not be negative, got " + checks[name]);
    }
    if (v.W >= v.B) fail("drill error W must be below the burden, got " + v.W);
    if (Math.abs(v.BCL + v.CCL - v.L) > 1e-6 * v.L) fail("bottom and column charge must add to the charge length");
    var geometry = 2.2 - 14 * v.B / v.dMm;
    if (geometry <= 0) fail("2.2 - 14 B/d is not positive: B " + v.B + " m, d " + v.dMm + " mm (d must be in mm)");
    return geometry * Math.sqrt((1 + v.S / v.B) / 2) * (1 - v.W / v.B) *
        Math.pow(Math.abs(v.BCL - v.CCL) / v.L + 0.1, 0.1) * (v.L / v.H);
}

/** Rosin-Rammler share of rock retained on a screen of size x (same units as x50). */
export function retainedFraction(x, x50, n) {
    positive("size", x); positive("x50", x50); positive("n", n);
    return Math.exp(-0.693 * Math.pow(x / x50, n));
}

/** Rosin-Rammler share of rock passing a screen of size x (same units as x50). */
export function passingFraction(x, x50, n) {
    return 1 - retainedFraction(x, x50, n);
}

/**
 * The whole estimate.
 * @param {Object} v - inputs of meanSizeCm and uniformityIndex
 * @param {{sizesM?: number[]}} [opts] - sizes (m) to report shares at
 * @returns {{ x50M, x50Cm, n, curve: Array<{xM, passing}>, shares: Array<{xM, passing, oversize}>, inputs }}
 */
export function kuzRam(v, opts) {
    var x50Cm = meanSizeCm(v), n = uniformityIndex(v), x50M = x50Cm / 100;
    var sizes = opts && opts.sizesM ? opts.sizesM : [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
    var curve = [];
    for (var i = 0; i <= 40; i++) {
        var xM = x50M * Math.pow(10, -1.5 + 3 * i / 40);
        curve.push({ xM: xM, passing: passingFraction(xM, x50M, n) });
    }
    return {
        x50M: x50M, x50Cm: x50Cm, n: n, curve: curve,
        shares: sizes.map(function (x) {
            var retained = retainedFraction(x, x50M, n);
            return { xM: x, passing: 1 - retained, oversize: retained };
        }),
        inputs: Object.assign({}, v)
    };
}

/**
 * Design values from the simulator's hole list. Means for Q, L and H, medians for B, S and d.
 * K is charge over the rock actually simulated, because a break zone isn't burden x spacing x bench.
 *
 * Charge is taken above grade unless asked otherwise: Adebola et al. 2016 and Agyei & Asssua
 * 2022 restate Cunningham 2005 as Q and K "excluding sub drill" (SECONDARY). A single continuous
 * charge has BCL = L and CCL = 0 (judgement: the sources don't print the single-charge case).
 *
 * @param {Array} holes - simHolesFromEntries output
 * @param {number} rockM3 - rock volume simulated
 * @param {Object} opts - { chargeBasis: "aboveGrade"|"total", burdenM, spacingM, holeDiamMm }
 * @returns {{K, Q, B, S, dMm, BCL, CCL, L, H}}
 */
export function blastInputs(holes, rockM3, opts) {
    opts = opts || {};
    positive("rock volume", rockM3);
    var basis = opts.chargeBasis || "aboveGrade";
    if (basis !== "aboveGrade" && basis !== "total") fail("chargeBasis must be aboveGrade or total, got " + basis);
    var charged = (holes || []).filter(function (h) { return h.mass > 0; });
    if (!charged.length) fail("no charged holes");
    var q = 0, l = 0, h = 0, bs = [], ss = [], ds = [];
    charged.forEach(function (hole) {
        var run = Math.hypot(hole.tx - hole.cx, hole.ty - hole.cy, hole.tz - hole.cz);
        var cosine = run > 0 ? Math.abs(hole.tz - hole.cz) / run : 1;
        var column = hole.chargeBaseDepth - hole.stemLen;
        if (!(column > 0)) fail("hole " + hole.id + " has no charge column");
        if (!(hole.benchHeight > 0)) fail("hole " + hole.id + " has no bench height");
        var subdrill = cosine > 0 ? Math.max(0, hole.chargeBaseDepth - hole.benchHeight / cosine) : 0;
        var length = basis === "total" ? column : column - subdrill;
        if (!(length > 0)) fail("hole " + hole.id + " has no charge above grade");
        q += hole.mass * length / column; l += length; h += hole.benchHeight;
        bs.push(hole.burden); ss.push(hole.spacing); ds.push(hole.diameter * 1000);
    });
    var median = function (list, name, given) {
        if (given != null) return positive(name, given);
        var sorted = list.slice().sort(function (a, b) { return a - b; }), mid = sorted[Math.floor((sorted.length - 1) / 2)];
        if (!(mid > 0)) fail(name + " is missing from the holes: supply it");
        return mid;
    };
    var count = charged.length, L = l / count;
    return {
        K: q / rockM3, Q: q / count, L: L, H: h / count, BCL: L, CCL: 0,
        B: median(bs, "burden", opts.burdenM), S: median(ss, "spacing", opts.spacingM), dMm: median(ds, "hole diameter", opts.holeDiamMm)
    };
}

/**
 * How many boulders of each size the curve asks for on a grid of cells.
 *
 * A merged block of m cells has a screen size of cell x cbrt(m), taking a cube's edge as the size
 * passing a square mesh (judgement). Class m holds the rock whose volume is nearest m cells,
 * between cbrt(m - 0.5) and cbrt(m + 0.5) cells. Whatever a class can't make into a whole boulder
 * carries down to the next, so a boulder appears only when the curve holds that much rock. Below
 * cbrt(1.5) cells, rock stays in single cells.
 *
 * Rosin-Rammler has no top size. Blocks stop at xMaxM, and rock beyond falls into the top class.
 * The usual limit is the smaller of burden and spacing (Ouchterlony's KCO, restated by Mutinda et
 * al. 2021; SECONDARY).
 *
 * @param {{x50M, n, cellM, cells, xMaxM}} v
 * @returns {{ classes: Array<{cells, count}>, mergedCells, shareAboveCell, shareAboveMergeLimit, largestCells }}
 */
export function boulderPlan(v) {
    positive("x50", v.x50M); positive("n", v.n); positive("cell size", v.cellM); positive("cell count", v.cells); positive("size limit", v.xMaxM);
    var retained = function (m) { return retainedFraction(v.cellM * Math.cbrt(m), v.x50M, v.n); };
    var top = Math.min(Math.floor(Math.pow(v.xMaxM / v.cellM, 3)), Math.floor(v.cells));
    var classes = [], carry = 0, merged = 0;
    for (var m = top; m >= 2; m--) {
        var share = (m === top ? retained(m - 0.5) : retained(m - 0.5) - retained(m + 0.5));
        var cells = share * v.cells + carry;
        var count = Math.floor(cells / m);
        carry = cells - count * m;
        if (count > 0) { classes.push({ cells: m, count: count }); merged += count * m; }
    }
    var above = retained(1.5);
    return {
        classes: classes, mergedCells: merged, shareAboveCell: retainedFraction(v.cellM, v.x50M, v.n),
        shareAboveMergeLimit: above, largestCells: classes.length ? classes[0].cells : 1
    };
}

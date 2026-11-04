/**
 * ESRI ASCII grids from the twin's terrain stage. Row 0 of the file is the north
 * row. Grids are stored south to north, so index (i, j) grows east and north.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseAsc(text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    const header = {};
    let at = 0;
    while (at < tokens.length && Number.isNaN(Number(tokens[at]))) {
        header[tokens[at].toLowerCase()] = Number(tokens[at + 1]);
        at += 2;
    }
    const { ncols: cols, nrows: rows, xllcorner: x0, yllcorner: y0, cellsize: cell, nodata_value: nodata } = header;
    if (!(cols > 0 && rows > 0 && cell > 0)) throw new Error("parseAsc: bad header");
    if (tokens.length - at !== cols * rows) {
        throw new Error(`parseAsc: expected ${cols * rows} values, found ${tokens.length - at}`);
    }
    const z = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
        const j = rows - 1 - r;
        for (let i = 0; i < cols; i++) {
            const v = Number(tokens[at++]);
            z[j * cols + i] = v === nodata ? NaN : v;
        }
    }
    return { cols, rows, x0, y0, cell, z };
}

/** Value of the cell containing a point; NaN for NODATA or outside the grid. */
export function heightAt(grid, x, y) {
    const i = Math.floor((x - grid.x0) / grid.cell);
    const j = Math.floor((y - grid.y0) / grid.cell);
    if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return NaN;
    return grid.z[j * grid.cols + i];
}

export function loadTerrain(dir) {
    return {
        dtm: parseAsc(readFileSync(join(dir, "dtm.asc"), "utf8")),
        filled: parseAsc(readFileSync(join(dir, "filled.asc"), "utf8")),
    };
}

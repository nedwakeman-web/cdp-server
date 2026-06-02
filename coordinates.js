'use strict';

/**
 * CDP coordinates: server entry point.
 *
 * A thin re-export of the canonical coordinate core. The core is authored once
 * in coordinates-core.ts and compiled to coordinates-core.cjs; this shim is what
 * the rest of the server requires, so callers such as compose-depth.js keep
 * working unchanged while every value flows from the single source of truth. Do
 * not hand edit coordinates-core.cjs; regenerate it from the TypeScript source.
 */

module.exports = require('./coordinates-core.cjs');

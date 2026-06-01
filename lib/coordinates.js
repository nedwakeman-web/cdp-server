'use strict';

/**
 * CDP coordinates: server entry point.
 *
 * This file is a thin re-export of the canonical coordinate core. The core is
 * authored once in coordinates-core.ts and compiled to coordinates-core.cjs;
 * this shim is what the rest of the server requires, so existing callers such as
 * compose-depth.js keep working unchanged while every value now flows from the
 * single source of truth. Do not hand edit coordinates-core.cjs; regenerate it
 * from the TypeScript source so the client and the server can never drift.
 */

module.exports = require('./coordinates-core.cjs');

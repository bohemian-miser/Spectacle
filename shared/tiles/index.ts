/**
 * Pure tile core, vendored from the Spectre project
 * (https://github.com/bohemian-miser/Spectre, `web/src/core/`).
 *
 * Framework-free by construction — no DOM, no React — so the same code runs in
 * the game server, the browser client and the unit tests, and every party
 * agrees on where a strand goes. Kept verbatim apart from this barrel; update
 * by re-copying from Spectre rather than editing in place.
 */

export * from './geom';
export * from './families';
export * from './edges';
export * from './tiles';
export * from './outline';
export * from './matchings';
export * from './circuits';
export * from './colors';
export * from './subsets';

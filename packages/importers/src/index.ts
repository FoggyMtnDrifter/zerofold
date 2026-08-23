/**
 * Import adapters.
 *
 * Two layers over one canonical intermediate representation: `feed/` for ongoing per-account
 * transaction files, `plan/` for one-time whole-budget migration. The CIR is the same document
 * as our native export format, so export, restore and migration are one code path.
 */
export const IMPORTERS_VERSION = '0.0.0'

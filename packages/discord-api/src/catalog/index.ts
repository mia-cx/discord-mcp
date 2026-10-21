/**
 * The operation catalog as a standalone Effect library: every Discord HTTP operation, what Discord
 * requires of the caller for each, and the effective-permission resolver to check those
 * requirements. Imports no tools, dispatcher, or storage.
 */
export * from '../permissions.ts'
export * from './required-permissions.ts'
export * from './service.ts'
export * from './types.ts'

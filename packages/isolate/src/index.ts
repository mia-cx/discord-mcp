/** One-off discord.js scripts in workerd isolates, brokered through the relay's own client. */
export { EgressBlockedError, fetchPublic, isPublicAddress } from './egress.ts'
export { checkHost, checkOperation, matchOperation, type ScriptGrants } from './grants.ts'

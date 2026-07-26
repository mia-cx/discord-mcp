// Effect v4 beta's .d.ts files reference two DOM-lib types that @types/node@24 does not declare
// globally. Shimming them keeps `dom` out of a Node-only server's lib set, so browser-only globals
// cannot silently typecheck in server code.
// See docs/architecture/0001-beta-foundations.md §5. Remove once Effect ships Node-safe decls.

/** Referenced unqualified by effect/Channel, so a type alias suffices. */
type TextDecoderOptions = { fatal?: boolean; ignoreBOM?: boolean }

/**
 * Referenced by effect/unstable/rpc's RpcClient as `globalThis.Transferable`. It must be an
 * `interface`: a global type alias is not reachable through `globalThis.` qualification.
 */
interface Transferable {
  readonly byteLength: number
}

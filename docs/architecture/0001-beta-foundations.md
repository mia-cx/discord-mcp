# 0001: Beta foundation spike

Status: accepted on 2026-07-26.

The initial implementation pins one version-aligned Effect v4 cohort
(`effect@4.0.0-beta.101`) and MCP v2 beta (`2.0.0-beta.5`) with TypeScript 7.0.2 on Node 24.

The spike verified:

- `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` compose on the same schema object.
- The MCP SDK accepts that object directly as a tool input schema.
- The MCP SDK and direct Standard Schema validation accept and reject the same fixtures.
- Schema compilation is eager and rejects a non-object tool input while naming the offending tool.
- `ManagedRuntime.runPromiseExit(effect, { signal })` accepts an `AbortSignal` and interrupts the
  fiber. The production registry runs every MCP handler through this boundary.
- The same request signal is installed in `McpRequestContext` and forwarded to
  `@discordjs/rest`, so interruption also aborts in-flight Discord I/O.
- An official MCP `Client` can list and call the Effect-backed tool over linked in-memory transports.

Two small shipped-API details differ from the pseudocode in `PLAN.md`:

1. A portable declaration for the bridge needs direct `@standard-schema/spec` types; otherwise
   TypeScript emits TS2883 for a transitive, unnameable inferred type.
2. `Schema.Top` permits unknown decoding services. The MCP input helper therefore accepts
   `Schema.ConstraintDecoder<unknown, never>`, making the no-service requirement explicit.

Standard Schema validation may return synchronously when no asynchronous work is involved. Callers
must accept its specified value-or-promise result instead of assuming a Promise.

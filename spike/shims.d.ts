// effect@4.0.0-beta.101 Channel.d.ts references the DOM-lib type `TextDecoderOptions`,
// which @types/node does not declare globally. Shimming it keeps `dom` out of a
// Node-only server's lib set. Remove once Effect ships a Node-safe declaration.
type TextDecoderOptions = { fatal?: boolean; ignoreBOM?: boolean }

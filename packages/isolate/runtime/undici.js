// discord.js fetches URL attachments with undici's own client. In the isolate, that fetch goes
// through the global one instead, so the broker checks it like any other request.
export const fetch = (...args) => globalThis.fetch(...args)

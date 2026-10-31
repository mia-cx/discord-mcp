// "textile" as agent code sees it: what a workflow has beyond discord.js. CommonJS, like the
// script itself. Every call is a fetch, which reaches only the broker.

const KV_URL = 'https://kv.textile.internal/'

const kvCall = async (method, key, body) => {
  if (typeof key !== 'string' || key === '') throw new TypeError('A KV key is a non-empty string.')
  // A query parameter, since URL parsing would drop a key like "." or ".." from the path.
  const response = await fetch(`${KV_URL}?key=${encodeURIComponent(key)}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
  })
  if (response.ok || (method === 'GET' && response.status === 404)) return response
  throw new Error((await response.json()).message)
}

/** The workflow's own key-value store. Values are anything JSON can hold. */
exports.kv = {
  /** The value stored under `key`, or undefined. */
  async get(key) {
    const response = await kvCall('GET', key)
    return response.status === 404 ? undefined : response.json()
  },
  async set(key, value) {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError('A KV value must be JSON-serializable.')
    await kvCall('PUT', key, json)
  },
  async delete(key) {
    await kvCall('DELETE', key)
  },
}

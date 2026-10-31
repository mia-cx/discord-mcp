// discord.js pins its own @discordjs/collection. A dependency importing the package gets that same
// class, so collections from either pass the other's `instanceof` checks.
export { Collection } from 'discord.js'

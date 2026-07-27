import type { DiscordRestClient } from '@discord-mcp/discord-api'
import type { McpServer } from '@modelcontextprotocol/server'
import { buildToolServer } from './tool-surface.js'

export const createServer = (rest: DiscordRestClient): McpServer => buildToolServer({ rest })

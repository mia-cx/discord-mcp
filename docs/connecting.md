# Add Discord MCP to your agent

Get the relay's MCP URL from its operator, plus permission to use it.
Replace `https://YOUR_RELAY_HOST/mcp` below with that URL.
You also need your Discord bot token and Node.js 24+.

OAuth signs you in as a human. The separate bot token determines which Discord
servers and actions the agent can access. You do not need to create an OAuth
application; the relay operator configures that once.

## 1. Get the client scripts

```sh
git clone https://github.com/mia-cx/discord-mcp.git
cd discord-mcp
DISCORD_MCP_NODE="$(command -v node)"
DISCORD_MCP_CLIENT="$(pwd)/scripts/client.mjs"
```

The login helper and stdio bridge have no dependencies. No build or package
installation is needed. Keep this checkout at the same path after configuring agents.

## 2. Save your bot token privately

Create a private file outside the checkout:

```sh
mkdir -p "$HOME/.config/discord-mcp"
chmod 700 "$HOME/.config/discord-mcp"
touch "$HOME/.config/discord-mcp/bot.env"
chmod 600 "$HOME/.config/discord-mcp/bot.env"
```

Open `~/.config/discord-mcp/bot.env` in a text editor and add one line:

```dotenv
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
```

Replace the placeholder inside the editor, not in a shell command or agent chat.
Use the raw token without quotes or a `Bot ` prefix. The bot must already belong
to each Discord server you want it to access.

## 3. Sign in with Discord

Run this on the machine with your browser:

```sh
node scripts/login.mjs https://YOUR_RELAY_HOST/mcp
```

Approve the relay's consent screen, then approve Discord OAuth with the account
your operator allowed. The helper uses a local loopback callback and saves
`~/.config/discord-mcp/login.json` with owner-only permissions. It never reads
your bot token. `--no-open` prints the browser URL without opening it.

Keep both credential files private. Anyone who can read both files can act
through the relay as your bot.

Each machine needs its own sign-in. The bridge refreshes the login before it
expires, and a refresh revokes every other copy of that login file. For a
headless agent machine, sign in for it separately on your browser machine:

```sh
node scripts/login.mjs https://YOUR_RELAY_HOST/mcp --output ./remote-login.json
```

Move `remote-login.json` over SSH to `~/.config/discord-mcp/login.json` on that
machine, keeping owner-only permissions, and delete the local copy. Copy
`bot.env` there the same way; the bot token can be shared.

## 4. Register the stdio bridge

Choose your agent. These commands store paths, not credentials, in its user config.
Run them in the same shell where you set `DISCORD_MCP_NODE` and `DISCORD_MCP_CLIENT`.

### Claude Code

```sh
claude mcp add --scope user --transport stdio discord-mcp -- "$DISCORD_MCP_NODE" "$DISCORD_MCP_CLIENT"
claude mcp get discord-mcp
```

### Codex

```sh
codex mcp add discord-mcp -- "$DISCORD_MCP_NODE" "$DISCORD_MCP_CLIENT"
codex mcp get discord-mcp
```

This uses the shared user configuration described in the
[official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp).

### Devin

```sh
devin mcp add --scope user discord-mcp -- "$DISCORD_MCP_NODE" "$DISCORD_MCP_CLIENT"
devin mcp get discord-mcp
```

### Cursor and other stdio MCP clients

Print the two absolute paths:

```sh
printf '%s\n' "$DISCORD_MCP_NODE" "$DISCORD_MCP_CLIENT"
```

For Cursor, merge this entry into `~/.cursor/mcp.json`, preserving other servers.
Replace the example paths with the printed values:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/discord-mcp/scripts/client.mjs"]
    }
  }
}
```

Other stdio clients use the same command and argument. The bridge reads private
credentials on every request and forwards them to the hosted HTTPS relay.
`DISCORD_MCP_CONFIG_DIR` can select another private credential directory.

## 5. Reconnect and verify

Start a new agent session or reconnect its MCP servers. In T3 Code, use
**Restart agent session** in the command palette, then send a new message.

Ask the agent to list the Discord servers its bot can access. It should discover
eight tools, including `discord_api_search` and `discord_api_read`, and complete
the read through the relay. No second OAuth login is needed for another agent
under the same OS account; its bridges share the login and take turns refreshing it.

## Renew or troubleshoot

- Expired or revoked login: run the login command again with `--replace`.
  The bridge renews a login while you use it. A login lapses after 30 days unused,
  when you revoke the app in Discord, or when another machine refreshed a copy of it.
- `access_denied` or an allowlist error: ask the operator for access. Signing in
  repeatedly does not add your account to the allowlist.
- Bot-token rejection: fix `bot.env` or the bot's permissions. Another OAuth login does not fix the bot.
- Missing credentials: complete steps 2 and 3. Replacing either file updates running bridges on their next request.
- No tools: check both absolute paths and reconnect the agent. Client-specific tool approval may also be required.

## Native HTTP clients

An HTTP MCP client can use the operator's URL and discover OAuth automatically
instead of using the bridge. It must securely supply `X-Discord-Bot-Token` on
every MCP request, separately from the OAuth bearer credential. Use its private
secret mechanism; do not paste tokens into config files, command arguments, or URLs.
Use the bridge if the client cannot securely supply that separate header.

# Operating the relay

Configure one relay-owned Discord OAuth application as described in the README.
HTTP fails closed if its OAuth settings are missing. Each caller logs in with
Discord and supplies a separate bot credential on every MCP request.

## Source and containers

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

For containers, fill `docker/.env.example` into a private `.env`, then run
`docker compose --env-file .env up -d` from `docker/`. Use one server process
and TLS termination. There is no database, state volume, or supervisor.

Local stdio uses `MCP_TRANSPORT=stdio DISCORD_TOKEN=...` and does not require OAuth.
Never expose a local stdio process as an unauthenticated network proxy.

## Curl

Run `node scripts/login.mjs https://YOUR_HOST/mcp` on the machine with your browser.
It saves the relay credential in `~/.config/discord-mcp/login.json`.
Agents can prepare the command; the human approves the Discord login.

Set `DISCORD_BOT_TOKEN` privately in your environment. This example supplies
headers through curl's stdin, keeping credentials out of its argument list:

```sh
MCP_ACCESS_TOKEN="$(node -p 'JSON.parse(require("node:fs").readFileSync(require("node:path").join(require("node:os").homedir(), ".config/discord-mcp/login.json"), "utf8")).access_token')"
curl --silent --show-error --fail-with-body --config - <<EOF
url = "https://YOUR_HOST/mcp"
request = "POST"
header = "Authorization: Bearer $MCP_ACCESS_TOKEN"
header = "X-Discord-Bot-Token: $DISCORD_BOT_TOKEN"
header = "Content-Type: application/json"
header = "MCP-Method: tools/list"
header = "MCP-Protocol-Version: 2026-07-28"
data = "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/list\\",\\"params\\":{\\"_meta\\":{\\"io.modelcontextprotocol/protocolVersion\\":\\"2026-07-28\\",\\"io.modelcontextprotocol/clientCapabilities\\":{}}}}"
EOF
unset MCP_ACCESS_TOKEN
```

Disable shell tracing when handling credentials. Do not print the credential
file, record headers in logs, or put tokens in URLs. Signed JWT claims are readable;
the relay uses encrypted JWTs for OAuth grants and never embeds a bot token.

## Failures and recovery

- HTTP 401 means login is missing, invalid, expired, or revoked. Run the helper with `--replace`.
- HTTP 403 `invalid_bot_token` means fix `X-Discord-Bot-Token`; another login will not fix it.
- HTTP 429 means Discord rate-limited validation. Honor `Retry-After`.
- HTTP 502 means Discord validation or request processing is unavailable.

Discord permission failures appear in MCP tool results. Use
`discord_permissions_explain` to inspect the bot's effective permissions.
OAuth identity does not prove bot ownership. Bot-token possession grants authority.

No bot credential, authentication result, or Discord response is cached.
A reset bot token or revoked Discord login stops working on its next request.
Preserve the relay's OAuth client settings and encryption key outside the container.
Changing the key invalidates all issued credentials. Unfinished logins must restart
after a server restart; completed logins remain valid.

Public routing and Athena's forwarding units live in `mia-cx/yggdrasil-spec`.
Read `DIRECTION.md` before replacing the old live deployment. It has its own data
and still uses PAT/OIDC authentication. Preserve that data independently.

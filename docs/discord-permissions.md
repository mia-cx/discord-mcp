# Discord permissions and Gateway intents

The control plane checks local scopes and workflow grants before Discord checks guild permissions.
For server setup, the bot normally needs `ViewChannel`, `ManageChannels`, `ManageRoles`, and
`ManageGuild`; messaging needs `SendMessages`, `EmbedLinks`, `AttachFiles`, and—when used—
`ManageMessages`, `CreatePublicThreads`, or `ManageThreads`. Moderation tools need their matching
`KickMembers`, `BanMembers`, `ModerateMembers`, or `ManageGuild` permission.

Discord role hierarchy is independent of permission bits. The bot can manage only roles strictly
below its highest role and cannot grant permissions it does not hold. Blueprint planning and curated
role mutations diagnose these conditions locally.

Gateway intents default to `Guilds`. Configure comma-separated names in
`DISCORD_MCP_GATEWAY_INTENTS`. Privileged intents (`GuildMembers`, `GuildPresences`,
`MessageContent`) must also be enabled under Developer Portal → Bot. Close code 4014 means a
configured privileged intent is not enabled there; 4013 means an intent name or bit is invalid.

`MESSAGE_CONTENT` also affects REST message reads. When Discord returns non-empty message objects
whose content-bearing fields are all empty, `discord_message_list` adds an intent diagnosis.

On 403, do not retry argument variants. Call `discord_permissions_explain`; repeated invalid
responses are counted by RateGuard and eventually stop outbound calls.

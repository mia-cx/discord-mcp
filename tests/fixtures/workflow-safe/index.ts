import { Discord, Effect, Trigger, Workflow } from '@discord-mcp/workflow-sdk'

export default Workflow.make({
  requestedGrants: {
    discord: { operationIds: ['create_message'], channelIds: ['12345678901234567'] },
  },
  triggers: [
    Trigger.manual({
      key: 'announce',
      handler: () =>
        Effect.promise(() =>
          Discord.sendMessage({
            channelId: '12345678901234567',
            presentation: { type: 'legacy', content: 'Sandbox smoke test' },
          }),
        ),
    }),
  ],
})

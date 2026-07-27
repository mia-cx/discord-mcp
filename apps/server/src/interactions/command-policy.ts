export interface CommandPublishingGrant {
  readonly guildCommandPublishing: boolean
  readonly globalCommandPublishing: boolean
}

export const assertCommandPublishingGranted = (
  global: boolean,
  grant: CommandPublishingGrant,
  commandName: string,
): void => {
  if (global) {
    if (!grant.globalCommandPublishing) {
      throw new Error(`global command ${commandName} requires an explicit global-command grant`)
    }
    return
  }
  if (!grant.guildCommandPublishing) {
    throw new Error(`guild command ${commandName} requires an explicit guild-command grant`)
  }
}

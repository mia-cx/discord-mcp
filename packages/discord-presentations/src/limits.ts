/**
 * Components V2 limits, split by whether Discord documents them.
 *
 * The split is the point. Hard limits are documented and enforced by Discord, so rejecting locally
 * turns a 400 into an immediate fixable message. Advisory limits are *undocumented* — inferred
 * from a changelog or a JSDoc comment — so enforcing them would mean a Discord change silently
 * breaking sends that were always valid. Those warn instead.
 */

/** `IS_COMPONENTS_V2 = 1 << 15`. Set-only: it can never be removed from a message. */
export const IS_COMPONENTS_V2 = 32_768

export const HARD_LIMITS = {
  /** Counted recursively across the whole tree, not per level. */
  totalComponents: 40,
  actionRowButtons: 5,
  /** An ActionRow holds five buttons XOR one select, never a mix. */
  actionRowSelects: 1,
  stringSelectOptions: 25,
  buttonLabelChars: 80,
  textDisplayMinChars: 1,
  textDisplayMaxChars: 4000,
  mediaGalleryMinItems: 1,
  mediaGalleryMaxItems: 10,
  mediaDescriptionChars: 1024,
  customIdMinChars: 1,
  customIdMaxChars: 100,
  sectionMinTextDisplays: 1,
  sectionMaxTextDisplays: 3,
  /** Container → Section → Thumbnail. Discord permits no deeper nesting. */
  maxDepth: 3,
} as const

/**
 * Undocumented by Discord. Warn, never reject.
 *
 * - The message-wide 4000-character budget: only the per-TextDisplay 4000 is verifiable, in
 *   `@discordjs/builders`.
 * - 10 top-level components: from an April 2025 changelog that also stated a "30 total" which has
 *   since been raised.
 * - Container's 10 children: JSDoc only, and unenforced in practice.
 */
export const ADVISORY_LIMITS = {
  messageWideTextChars: 4000,
  topLevelComponents: 10,
  containerChildren: 10,
} as const

/** Discord's numeric component types. The encoder owns these; authors never write them. */
export const COMPONENT_TYPE = {
  actionRow: 1,
  button: 2,
  stringSelect: 3,
  textInput: 4,
  userSelect: 5,
  roleSelect: 6,
  mentionableSelect: 7,
  channelSelect: 8,
  section: 9,
  textDisplay: 10,
  thumbnail: 11,
  mediaGallery: 12,
  file: 13,
  separator: 14,
  container: 17,
  label: 18,
  fileUpload: 19,
  radioGroup: 21,
  checkboxGroup: 22,
  checkbox: 23,
} as const

/**
 * Type 16 is `@unstable` in `discord-api-types` and undocumented by Discord. Never emit it.
 */
export const FORBIDDEN_COMPONENT_TYPE = 16

export const BUTTON_STYLE = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
  premium: 6,
} as const

/** Styles 5 (link) and 6 (premium) never fire an interaction, so they need no handler. */
export const NON_INTERACTIVE_BUTTON_STYLES: ReadonlySet<string> = new Set(['link', 'premium'])

export const SEPARATOR_SPACING = { small: 1, large: 2 } as const

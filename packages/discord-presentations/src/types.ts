export type InteractionAction =
  | { readonly type: 'workflow'; readonly key: string }
  | { readonly type: 'event'; readonly key: string }

export interface TextComponent {
  readonly type: 'text'
  readonly id?: number
  readonly content: string
}

export type ButtonComponent =
  | {
      readonly type: 'button'
      readonly id?: number
      readonly style: 'primary' | 'secondary' | 'success' | 'danger'
      readonly label: string
      readonly emoji?: { readonly id?: string; readonly name?: string; readonly animated?: boolean }
      readonly disabled?: boolean
      readonly action: InteractionAction
    }
  | {
      readonly type: 'button'
      readonly id?: number
      readonly style: 'link'
      readonly label: string
      readonly url: string
      readonly emoji?: { readonly id?: string; readonly name?: string; readonly animated?: boolean }
      readonly disabled?: boolean
    }
  | {
      readonly type: 'button'
      readonly id?: number
      readonly style: 'premium'
      readonly skuId: string
      readonly disabled?: boolean
    }

export interface ThumbnailComponent {
  readonly type: 'thumbnail'
  readonly id?: number
  readonly media: { readonly url: string }
  readonly description?: string
  readonly spoiler?: boolean
}

export interface SectionComponent {
  readonly type: 'section'
  readonly id?: number
  readonly components: ReadonlyArray<TextComponent>
  readonly accessory: ButtonComponent | ThumbnailComponent
}

export interface MediaGalleryComponent {
  readonly type: 'mediaGallery'
  readonly id?: number
  readonly items: ReadonlyArray<{
    readonly media: { readonly url: string }
    readonly description?: string
    readonly spoiler?: boolean
  }>
}

export interface FileComponent {
  readonly type: 'file'
  readonly id?: number
  readonly file: { readonly url: string }
  readonly spoiler?: boolean
}

export interface SeparatorComponent {
  readonly type: 'separator'
  readonly id?: number
  readonly divider?: boolean
  readonly spacing?: 'small' | 'large'
}

export interface SelectOption {
  readonly label: string
  readonly value: string
  readonly description?: string
  readonly emoji?: { readonly id?: string; readonly name?: string; readonly animated?: boolean }
  readonly default?: boolean
}

export interface SelectComponent {
  readonly type: 'select'
  readonly id?: number
  readonly kind: 'string' | 'user' | 'role' | 'mentionable' | 'channel'
  readonly action: InteractionAction
  readonly placeholder?: string
  readonly minValues?: number
  readonly maxValues?: number
  readonly disabled?: boolean
  readonly options?: ReadonlyArray<SelectOption>
  readonly channelTypes?: ReadonlyArray<number>
}

export interface ActionRowComponent {
  readonly type: 'actionRow'
  readonly id?: number
  readonly components: ReadonlyArray<ButtonComponent | SelectComponent>
}

export type ContainerChild =
  | ActionRowComponent
  | FileComponent
  | MediaGalleryComponent
  | SectionComponent
  | SeparatorComponent
  | TextComponent

export interface ContainerComponent {
  readonly type: 'container'
  readonly id?: number
  readonly accentColor?: number | null
  readonly spoiler?: boolean
  readonly components: ReadonlyArray<ContainerChild>
}

export type ComponentsV2TopLevel =
  | ActionRowComponent
  | ContainerComponent
  | FileComponent
  | MediaGalleryComponent
  | SectionComponent
  | SeparatorComponent
  | TextComponent

export type AttachmentInput =
  | {
      readonly source: 'inline'
      readonly filename: string
      readonly data: string
      readonly mimeType?: string
    }
  | {
      readonly source: 'blob'
      readonly blobId: string
      readonly filename: string
    }

export interface AllowedMentions {
  readonly users?: ReadonlyArray<string>
  readonly roles?: ReadonlyArray<string>
  readonly parse?: ReadonlyArray<'everyone' | 'users' | 'roles'>
  readonly repliedUser?: boolean
}

export type MessagePresentation =
  | {
      readonly type: 'legacy'
      readonly content?: string
      readonly embeds?: ReadonlyArray<Record<string, unknown>>
      readonly components?: ReadonlyArray<Record<string, unknown>>
      readonly poll?: Record<string, unknown>
      readonly attachments?: ReadonlyArray<AttachmentInput>
      readonly allowedMentions?: AllowedMentions
    }
  | {
      readonly type: 'components_v2'
      readonly components: ReadonlyArray<ComponentsV2TopLevel>
      readonly attachments?: ReadonlyArray<AttachmentInput>
      readonly allowedMentions?: AllowedMentions
    }
  | {
      readonly type: 'template'
      readonly templateId: string
      readonly revision?: number
      readonly variables: unknown
    }

export interface ModalPresentation {
  readonly title: string
  readonly action: InteractionAction
  readonly components: ReadonlyArray<
    | TextComponent
    | {
        readonly type: 'label'
        readonly label: string
        readonly description?: string
        readonly component:
          | {
              readonly type: 'textInput'
              readonly key: string
              readonly style: 'short' | 'paragraph'
              readonly required?: boolean
              readonly minLength?: number
              readonly maxLength?: number
              readonly placeholder?: string
              readonly value?: string
            }
          | {
              readonly type: 'select'
              readonly key: string
              readonly kind: SelectComponent['kind']
              readonly placeholder?: string
              readonly minValues?: number
              readonly maxValues?: number
              readonly options?: ReadonlyArray<SelectOption>
              readonly channelTypes?: ReadonlyArray<number>
            }
          | {
              readonly type: 'fileUpload'
              readonly key: string
              readonly required?: boolean
              readonly minValues?: number
              readonly maxValues?: number
            }
          | {
              readonly type: 'radioGroup'
              readonly key: string
              readonly required?: boolean
              readonly options: ReadonlyArray<SelectOption>
            }
          | {
              readonly type: 'checkboxGroup'
              readonly key: string
              readonly required?: boolean
              readonly minValues?: number
              readonly maxValues?: number
              readonly options: ReadonlyArray<SelectOption>
            }
          | {
              readonly type: 'checkbox'
              readonly key: string
              readonly default?: boolean
            }
      }
  >
}

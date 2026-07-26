import { Schema } from 'effect'
import { COMPONENT_TYPE } from './limits.ts'

/**
 * Modals are a separate presentation, and deliberately so.
 *
 * Types 4/18/19/21/22/23 are modal-only and 9/11/12/13/14/17 are message-only. Sharing one type
 * would make the boundary a runtime check; keeping them separate makes crossing it unrepresentable.
 */

/**
 * Length bounds for any schema whose `Type` has a `length` — strings and arrays alike.
 *
 * Generic over the schema rather than the element type, because `Schema.check` rebuilds `self` and
 * a non-generic helper would erase the schema's own type on the way through.
 */
const bounded =
  <S extends Schema.Top & { readonly Type: { readonly length: number } }>(
    min: number,
    max: number,
  ) =>
  (self: S): S['Rebuild'] =>
    Schema.check<S>(Schema.isMinLength(min), Schema.isMaxLength(max))(self)

const inputBase = {
  id: Schema.optionalKey(Schema.Int),
  /** Author-facing name. The control plane maps it to an opaque handle before Discord sees it. */
  key: Schema.String.pipe(bounded(1, 64)),
  required: Schema.optionalKey(Schema.Boolean),
}

const TextInput = Schema.Struct({
  type: Schema.Literal('textInput'),
  ...inputBase,
  style: Schema.Literals(['short', 'paragraph']),
  placeholder: Schema.optionalKey(Schema.String.pipe(bounded(1, 100))),
  value: Schema.optionalKey(Schema.String.pipe(bounded(1, 4000))),
  minLength: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4000 }))),
  ),
  maxLength: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4000 }))),
  ),
})

const FileUpload = Schema.Struct({
  type: Schema.Literal('fileUpload'),
  ...inputBase,
  minValues: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  ),
  maxValues: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  ),
})

const Choice = Schema.Struct({
  label: Schema.String.pipe(bounded(1, 100)),
  value: Schema.String.pipe(bounded(1, 100)),
  description: Schema.optionalKey(Schema.String.pipe(bounded(1, 100))),
  default: Schema.optionalKey(Schema.Boolean),
})

const RadioGroup = Schema.Struct({
  type: Schema.Literal('radioGroup'),
  ...inputBase,
  options: Schema.Array(Choice).pipe(bounded(1, 25)),
})

const CheckboxGroup = Schema.Struct({
  type: Schema.Literal('checkboxGroup'),
  ...inputBase,
  options: Schema.Array(Choice).pipe(bounded(1, 25)),
})

const Checkbox = Schema.Struct({
  type: Schema.Literal('checkbox'),
  ...inputBase,
  checked: Schema.optionalKey(Schema.Boolean),
})

const StringSelectInput = Schema.Struct({
  type: Schema.Literal('stringSelect'),
  ...inputBase,
  options: Schema.Array(Choice).pipe(bounded(1, 25)),
  placeholder: Schema.optionalKey(Schema.String.pipe(bounded(1, 150))),
  minValues: Schema.optionalKey(Schema.Int),
  maxValues: Schema.optionalKey(Schema.Int),
})

export const ModalInput = Schema.Union([
  TextInput,
  FileUpload,
  RadioGroup,
  CheckboxGroup,
  Checkbox,
  StringSelectInput,
])

/** A Label wraps one input with its own text; it is the modal analogue of a Section. */
const Label = Schema.Struct({
  type: Schema.Literal('label'),
  id: Schema.optionalKey(Schema.Int),
  label: Schema.String.pipe(bounded(1, 45)),
  description: Schema.optionalKey(Schema.String.pipe(bounded(1, 100))),
  component: ModalInput,
})

const ModalText = Schema.Struct({
  type: Schema.Literal('text'),
  id: Schema.optionalKey(Schema.Int),
  content: Schema.String.pipe(bounded(1, 4000)),
})

export const ModalPresentation = Schema.Struct({
  title: Schema.String.pipe(bounded(1, 45)),
  /** Logical action name; the control plane compiles it into an opaque `custom_id`. */
  action: Schema.String.pipe(bounded(1, 64)),
  components: Schema.Array(Schema.Union([Label, ModalText])).pipe(bounded(1, 5)),
}).annotate({
  title: 'ModalPresentation',
  description:
    'A Discord modal. Message-only components (Section, Thumbnail, MediaGallery, File, Separator, Container) cannot appear here, and modal-only inputs cannot appear in a message.',
})
export type ModalPresentation = typeof ModalPresentation.Type

const MODAL_INPUT_TYPES: Record<string, number> = {
  textInput: COMPONENT_TYPE.textInput,
  fileUpload: COMPONENT_TYPE.fileUpload,
  radioGroup: COMPONENT_TYPE.radioGroup,
  checkboxGroup: COMPONENT_TYPE.checkboxGroup,
  checkbox: COMPONENT_TYPE.checkbox,
  stringSelect: COMPONENT_TYPE.stringSelect,
}

const TEXT_INPUT_STYLE = { short: 1, paragraph: 2 } as const

const encodeInput = (
  input: Record<string, unknown>,
  resolveCustomId: (key: string) => string,
): Record<string, unknown> => {
  const base = {
    type: MODAL_INPUT_TYPES[String(input.type)],
    ...(input.id === undefined ? {} : { id: input.id }),
    custom_id: resolveCustomId(String(input.key)),
    ...(input.required === undefined ? {} : { required: input.required }),
  }

  switch (input.type) {
    case 'textInput':
      return {
        ...base,
        style: TEXT_INPUT_STYLE[input.style as keyof typeof TEXT_INPUT_STYLE],
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.minLength === undefined ? {} : { min_length: input.minLength }),
        ...(input.maxLength === undefined ? {} : { max_length: input.maxLength }),
      }
    case 'checkbox':
      return { ...base, ...(input.checked === undefined ? {} : { checked: input.checked }) }
    case 'fileUpload':
      return {
        ...base,
        ...(input.minValues === undefined ? {} : { min_values: input.minValues }),
        ...(input.maxValues === undefined ? {} : { max_values: input.maxValues }),
      }
    default:
      return {
        ...base,
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
        ...(input.minValues === undefined ? {} : { min_values: input.minValues }),
        ...(input.maxValues === undefined ? {} : { max_values: input.maxValues }),
      }
  }
}

export const encodeModal = (
  modal: ModalPresentation,
  resolveCustomId: (key: string) => string,
): Record<string, unknown> => ({
  title: modal.title,
  custom_id: resolveCustomId(modal.action),
  components: modal.components.map((component) => {
    const c = component as Record<string, unknown>
    if (c.type === 'text') {
      return {
        type: COMPONENT_TYPE.textDisplay,
        ...(c.id === undefined ? {} : { id: c.id }),
        content: c.content,
      }
    }
    return {
      type: COMPONENT_TYPE.label,
      ...(c.id === undefined ? {} : { id: c.id }),
      label: c.label,
      ...(c.description === undefined ? {} : { description: c.description }),
      component: encodeInput(c.component as Record<string, unknown>, resolveCustomId),
    }
  }),
})

/** Duplicate input keys would collide once compiled into handles, so they are rejected. */
export const validateModal = (modal: ModalPresentation): ReadonlyArray<string> => {
  const keys: string[] = []
  for (const component of modal.components) {
    const c = component as Record<string, unknown>
    if (c.type === 'label') keys.push(String((c.component as { key: string }).key))
  }
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i)
  return duplicates.length === 0
    ? []
    : [
        `Duplicate input key(s): ${[...new Set(duplicates)].join(', ')}. Each input needs a unique key.`,
      ]
}

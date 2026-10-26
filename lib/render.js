/**
 * The model-visible rendering of one observation: `dsh-browser-use`'s action-space table.
 *
 * Screenshots are for people; a model reads this text instead. Every line names one element with the
 * operations it supports, and every target it may send is an index printed here — never a selector,
 * a coordinate, or code.
 *
 * @module browser-use-mcp/render
 */

/** Collapse whitespace so a page's own layout does not consume the model's context. */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * Checkbox, option and disclosure state: without it a model cannot tell whether a click is still
 * needed. A tri-state value reads as `partly checked` rather than as either answer.
 */
export function elementState(element) {
  const states = [
    ['checked', 'checked', 'not checked'],
    ['selected', 'selected', 'not selected'],
    ['expanded', 'expanded', 'collapsed'],
  ].flatMap(([key, on, off]) => {
    const state = String(element[key] ?? '')
    return state === 'true' ? [on] : state === 'false' ? [off] : state === 'mixed' ? [`partly ${on}`] : []
  })
  return states.length > 0 ? ` (${states.join(', ')})` : ''
}

/**
 * The action space of one page as text: its address, its visible text, and one line per element.
 *
 * @param {object} page - one observation's page object from the sidecar.
 * @param {number} observation - the observation number this table belongs to.
 * @returns {string} the table the model acts from.
 */
export function pageText(page, observation) {
  const lines = [
    `Page ${page.url}${page.title ? ` — ${page.title}` : ''}`,
    `Observation ${observation}. Targets below are valid only for this observation.`,
  ]
  const text = collapse(page.text)
  if (text) lines.push(`Visible text: ${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}`)
  for (const element of page.elements ?? []) {
    const value = collapse(element.value)
    const details = [element.role ?? 'element', collapse(element.label)].filter(Boolean).join(' ')
    lines.push(`[${element.index}] ${details}${value ? ` · "${value}"` : ''}${elementState(element)} — ${element.operations.join(', ')}`)
    for (const option of element.options ?? []) lines.push(`      ${option.index} → ${collapse(option.label)}`)
  }
  const withoutTarget = Object.keys(page.operations ?? {}).filter(operation => page.operations[operation].length === 0)
  if (withoutTarget.length > 0) lines.push(`Without a target: ${withoutTarget.join(', ')}`)
  if ((page.elements ?? []).length === 0) lines.push('No reachable element was found on this page.')
  return lines.join('\n')
}

/**
 * A refusal that carries the table the next choice must come from.
 *
 * The point of the freshness guard is that a refusal is not an error to retry blindly: it hands back
 * the observation the page is in now, so the agent chooses again from something that is true.
 * @param {string} message - why nothing executed.
 * @param {object} page - the fresh page.
 * @param {number} observation - the fresh observation number.
 */
export function refusalText(message, page, observation) {
  return `Nothing was executed: ${message}\n\n${pageText(page, observation)}`
}

/** A page's own title and address as one line, for results that do not need the whole table. */
export function pageLabel(page) {
  if (!page) return 'no page has been read yet'
  return `${page.title ? `${page.title} — ` : ''}${page.url}`
}

/**
 * The action-space table is the whole model-facing page, so its shape is worth pinning: element
 * state, dropdown options, the operations that take no target, and the empty-page case.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collapse, elementState, pageLabel, pageText, refusalText } from '../../lib/render.js'

const page = {
  url: 'https://example.test/search',
  title: 'Example — search',
  text: 'Find a place\nto slow down',
  fingerprint: 'abc',
  elements: [
    { index: 1, role: 'textbox', label: 'Destination', value: 'Lisbon', operations: ['TYPE_TEXT'] },
    { index: 2, role: 'checkbox', label: 'Free cancellation', checked: 'mixed', operations: ['CLICK'] },
    {
      index: 3,
      role: 'combobox',
      label: 'Category',
      operations: ['SELECT'],
      options: [{ index: '3:1', label: 'Design' }, { index: '3:2', label: 'Wellness' }],
    },
    { index: 4, role: 'button', label: 'Find stays', expanded: 'false', operations: ['CLICK'] },
  ],
  operations: { CLICK: ['2', '4'], TYPE_TEXT: ['1'], SELECT: ['3:1', '3:2'], SCROLL_UP: [], WAIT: [] },
}

describe('collapse', () => {
  it('flattens whitespace so page layout does not spend the context', () => {
    assert.equal(collapse('  a\n\tb   c '), 'a b c')
    assert.equal(collapse(null), '')
  })
})

describe('elementState', () => {
  it('reads tri-state and boolean states', () => {
    assert.equal(elementState({ checked: 'true', selected: 'false', expanded: 'mixed' }), ' (checked, not selected, partly expanded)')
    assert.equal(elementState({ checked: 'false' }), ' (not checked)')
    assert.equal(elementState({}), '')
  })
})

describe('pageText', () => {
  const text = pageText(page, 7)

  it('starts with the page and the observation number that scopes the targets', () => {
    assert.match(text, /^Page https:\/\/example\.test\/search — Example — search$/m)
    assert.match(text, /^Observation 7\. Targets below are valid only for this observation\.$/m)
  })

  it('includes the visible text', () => {
    assert.match(text, /^Visible text: Find a place to slow down$/m)
  })

  it('names one element per line with its operations and state', () => {
    assert.match(text, /^\[1\] textbox Destination · "Lisbon" — TYPE_TEXT$/m)
    assert.match(text, /^\[2\] checkbox Free cancellation \(partly checked\) — CLICK$/m)
    assert.match(text, /^\[4\] button Find stays \(collapsed\) — CLICK$/m)
  })

  it('prints the dropdown options with the targets SELECT accepts', () => {
    assert.match(text, /^ {6}3:1 → Design$/m)
    assert.match(text, /^ {6}3:2 → Wellness$/m)
  })

  it('reports the operations that take no target', () => {
    assert.match(text, /^Without a target: SCROLL_UP, WAIT$/m)
  })

  it('says so when the page offered no element', () => {
    const empty = pageText({ url: 'about:blank', title: '', text: '', elements: [], operations: { WAIT: [] } }, 1)
    assert.match(empty, /No reachable element was found on this page\./)
    assert.match(empty, /^Page about:blank$/m)
  })
})

describe('refusalText', () => {
  it('says nothing executed and hands back the table to choose from', () => {
    const text = refusalText('The page changed since that observation.', page, 8)
    assert.match(text, /^Nothing was executed: The page changed since that observation\./)
    assert.match(text, /Observation 8\./)
  })
})

describe('pageLabel', () => {
  it('names the page for results that do not need the table', () => {
    assert.equal(pageLabel(page), 'Example — search — https://example.test/search')
    assert.equal(pageLabel(undefined), 'no page has been read yet')
  })
})

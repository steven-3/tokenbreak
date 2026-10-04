import type { PluginRegisterUses } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { NAME, SESSION, worldOf } from './world'

/** Events that read or shape what the model sees. Tokenbreak hooks none of them. */
const FORBIDDEN_EVENTS = [
  'prompt.compose',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'prompt.submit',
  'session.append',
  'session.messages',
  'tool.call',
  'tool.describe',
  'turn.step',
  'agent.spawn',
  '*',
]

/** Calls that read the conversation, the code, or talk to the model. */
const FORBIDDEN_CALLS = [
  'session.messages',
  'session.append',
  'session.authorize',
  'prompt.read',
  'prompt.fill',
  'prompt.submit',
  'model.complete',
  'model.fork',
  'model.classify',
  'fs.read',
  'fs.list',
  'process.run',
  'process.spawn',
  'ui.selection',
]

test('Tokenbreak never hooks or calls anything that reads the conversation or the code', async ($, on) => {
  let uses: PluginRegisterUses | undefined

  on('plugin.register', ($, e) => {
    if (e.name === NAME) {
      uses = e.uses
    }

    return { allow: true }
  })
  worldOf(on)
  mock.clock(on)
  await $.session.start(SESSION)

  expect(uses, 'the engine admitted the module').toBeDefined()

  for (const event of FORBIDDEN_EVENTS) {
    expect(uses?.events ?? [], `hooks ${event}`).not.toContain(event)
  }

  for (const call of FORBIDDEN_CALLS) {
    expect(uses?.calls ?? [], `calls $.${call}`).not.toContain(call)
  }

  // Of the turn it hooks start and end only, and reads the turn's id alone (see register.tsx).
  expect(uses?.events).toEqual(
    expect.arrayContaining(['session.start', 'ui.render', 'turn.start', 'turn.complete']),
  )
})

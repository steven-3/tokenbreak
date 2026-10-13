import type { PluginRegisterUses } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { FLUSH_EVERY_MS } from '../hooks/core'
import { BAND, command, complete, NAME, SESSION, SIGNED_BATCH, START, worldOf } from './world'

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
  // The tool's checks and the classic hooks around them carry its input or the prompt's text:
  // the permission prompt included, which is why ads don't step aside for it.
  'tool.check',
  'classic.PreToolUse',
  'classic.PostToolUse',
  'classic.PermissionRequest',
  'classic.Notification',
  'classic.UserPromptSubmit',
  '*',
]

/** Every event Tokenbreak hooks. A new one has to be added here, and to the README, on purpose. */
const HOOKED_EVENTS = ['command.run', 'session.end', 'session.start', 'turn.complete', 'turn.start', 'ui.close', 'ui.render']

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
  expect([...new Set(uses?.events ?? [])].sort()).toEqual(HOOKED_EVENTS)
})

test('Tokenbreak sends the ad server only what the README lists, never the prompt, the answer or the code', async ($, on) => {
  const world = worldOf(on, { batch: SIGNED_BATCH })
  const clock = mock.clock(on, { now: START })

  await $.session.start({ ...SESSION, cwd: '/home/someone/secret-project' })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

  await $.turn.start({ text: 'Fix the bug in secret-project/src/billing.ts', turnId: 't1' })
  await clock.advance(5_500)
  await $.turn.complete({ ...complete('t1'), answer: 'Fixed secret-project/src/billing.ts' })
  await clock.settle()
  await $.command.run(command('report scam looks like phishing'))
  await ui.press({ key: 'hide' })
  await clock.advance(FLUSH_EVERY_MS)

  const asks = world.fetches.filter(one => one.url.includes('/api/v1/ads'))
  const turns = world.fetches.filter(one => one.url.endsWith('/api/v1/turns'))
  const reports = world.fetches.filter(one => one.url.endsWith('/api/v1/impressions'))
  const flags = world.fetches.filter(one => one.url.endsWith('/api/v1/reports'))
  const MOD_HEADER_NAMES = ['X-Tokenbreak-Device', 'X-Tokenbreak-Surface', 'X-Tokenbreak-Version']

  expect(asks.length).toBeGreaterThan(0)
  expect(turns).toHaveLength(1)
  expect(reports).toHaveLength(1)
  expect(flags).toHaveLength(2)

  // An ad request: which formats, the session token, this install's random id, the mod's version and the surface.
  for (const ask of asks) {
    expect(new URL(ask.url).search).toBe('?formats=banner,theater')
    expect(Object.keys(ask.headers ?? {}).sort()).toEqual([...MOD_HEADER_NAMES, 'accept', 'authorization'])
    expect(ask.headers?.['X-Tokenbreak-Surface']).toBe('terminal')
  }

  // A turn: the same headers, and in the body the device and the surface alone.
  expect(Object.keys(turns[0]?.headers ?? {}).sort()).toEqual([...MOD_HEADER_NAMES, 'accept', 'authorization', 'content-type'])
  expect(JSON.parse(turns[0]?.body ?? '{}')).toEqual({ deviceId: world.store.get('deviceId'), surface: 'terminal' })

  // A report of impressions: device, version, and per impression the ad, its format, when, the turn,
  // the serve and turn tokens, the surface and how long it was on screen.
  const body = JSON.parse(reports[0]?.body ?? '{}') as { impressions: object[] }

  expect(Object.keys(body)).toEqual(['deviceId', 'modVersion', 'impressions'])
  expect(body.impressions).toHaveLength(2)

  for (const one of body.impressions) {
    expect(['adId', 'serveToken', 'format', 'at', 'turnId', 'turnToken', 'surface', 'shownMs']).toEqual(
      expect.arrayContaining(Object.keys(one)),
    )
  }

  // A flag on an ad: which ad, its serve token, the reason, and the note the person typed themselves.
  for (const flag of flags) {
    expect(['adId', 'serveToken', 'reason', 'note']).toEqual(expect.arrayContaining(Object.keys(JSON.parse(flag.body ?? '{}'))))
  }

  expect(JSON.stringify(world.fetches)).not.toContain('secret')
  expect(JSON.stringify(world.fetches)).not.toContain('billing')
})

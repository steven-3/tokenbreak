import { describe, expect, mock, test } from 'claude-code/testing'

import type { Impression } from '../types'
import { BAND, command, complete, DESKTOP, HEADLESS, NAME, PANE, SESSION, START, THEATER, worldOf } from './world'

const SURFACES = ['terminal', 'desktop'] as const

const impression = (n: number): Impression => ({ adId: 'old', format: 'banner', at: n, turnId: `old-${n}` })

describe('the banner', () => {
  test('draws the served ad above the prompt on the terminal and the desktop', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface })

      expect(await ui.find({ type: 'Text', text: 'sponsored' }), surface).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }))?.text).toContain('Acme DB')
      expect(await ui.find({ type: 'Text', text: 'scales to zero' })).toBeDefined()
      expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://tokenbreak.dev/c/acme')
      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('falls back to built-in house ads when the ad server is unreachable', async ($, on) => {
    worldOf(on, { isAdServerUp: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'This space for rent' })).toBeDefined()

    const status = await $.command.run(command('status'))

    expect(status.text).toContain('built-in house ads')
  })

  test('rotates to the next banner on the rotation timer', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }))?.text).toContain('Acme DB')
    await clock.advance(40_000)
    expect((await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }))?.text).toContain('Shipfast')
  })

  test('yields to a survey', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface, props: { ...BAND.props, hasSurvey: true } })

      expect(await ui.find({ type: 'Text', text: 'sponsored' }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test('hide pauses it, /ads resume brings it back, /ads pause today pauses again', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: 'sponsored' }), 'hidden after the press').toBeUndefined()

    const resumed = await $.command.run(command('resume'))

    expect(resumed.text).toContain('resumed')
    expect(await ui.find({ type: 'Text', text: 'sponsored' }), 'back after /ads resume').toBeDefined()

    const paused = await $.command.run(command('pause today'))

    expect(paused.text).toContain('paused')
    expect(await ui.find({ type: 'Text', text: 'sponsored' })).toBeUndefined()
    expect(world.store.get('pausedUntil')).toBeGreaterThan(START)
  })

  test('a pause ends by itself', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.command.run(command('pause 30m'))
    expect(await ui.find({ type: 'Text', text: 'sponsored' })).toBeUndefined()
    await clock.advance(30 * 60_000 + 1)
    expect(await ui.find({ type: 'Text', text: 'sponsored' })).toBeDefined()
  })
})

describe('the Theater', () => {
  test('opens only in the fullscreen layout at 144+ columns, after the turn has run 3s, and closes when it ends', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    // Too narrow.
    await $.ui.render({ ...BAND, viewport: { columns: 120, rows: 48, isFullscreen: true } })
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete(complete('t1'))
    expect(world.opened, 'narrow terminal').toEqual([])

    // Wide, but the main screen.
    await $.ui.render({ ...BAND, viewport: { columns: 180, rows: 48, isFullscreen: false }, props: { ...BAND.props, maxRows: 48 } })
    await $.turn.start({ text: '', turnId: 't2' })
    await clock.advance(5_000)
    await $.turn.complete(complete('t2'))
    expect(world.opened, 'main screen').toEqual([])

    // Fullscreen and wide, but a short turn.
    await $.ui.render(BAND)
    await $.turn.start({ text: '', turnId: 't3' })
    await clock.advance(1_000)
    await $.turn.complete(complete('t3'))
    expect(world.opened, 'short turn').toEqual([])

    // Fullscreen, wide, long turn.
    await $.turn.start({ text: '', turnId: 't4' })
    await clock.advance(3_500)
    expect(world.opened).toEqual([THEATER])
    await $.turn.complete(complete('t4'))
    expect(world.closed).toContain(THEATER)
  })

  test('stays shut when the theater option is off', { options: { theater: 'off' } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.render(BAND)
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(5_000)
    expect(world.opened).toEqual([])
  })

  test('closes again at once when the engine leaves it undrawn', async ($, on) => {
    const world = worldOf(on, { unplaced: 1 })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.render(BAND)
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(3_500)
    expect(world.opened).toEqual([THEATER])
    expect(world.closed).toEqual([THEATER])
  })

  test('draws a picture on the terminal and a text card on the desktop', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const terminal = await $.ui.mount({ plugin: NAME, ...PANE, surface: 'terminal' })

    expect(await terminal.find({ type: 'Image', key: 'theater-image' })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: 'Branch your database' })).toBeDefined()

    const desktop = await $.ui.mount({ plugin: NAME, ...PANE, surface: 'desktop' })

    expect(await desktop.find({ type: 'Image' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: 'Branch your database' })).toBeDefined()
  })
})

describe('impressions', () => {
  test('one per turn for the banner on screen, the queue capped at the newest 200', async ($, on) => {
    const world = worldOf(on, { isIngestUp: false, stored: { queue: Array.from({ length: 199 }, (_, n) => impression(n)) } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal', viewport: { columns: 120, rows: 48, isFullscreen: true } })

    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: '', turnId })
      await $.turn.complete(complete(turnId))
      await clock.settle()
    }

    const queue = world.store.get('queue') as Impression[]

    expect(queue).toHaveLength(200)
    expect(queue.at(-1)).toMatchObject({ adId: 'acme-banner', format: 'banner', turnId: 't2' })
    expect(queue[0]?.turnId, 'the oldest was dropped').toBe('old-1')
  })

  test('flush at 20 queued, and a sent batch leaves the queue', async ($, on) => {
    const world = worldOf(on, { stored: { queue: Array.from({ length: 19 }, (_, n) => impression(n)) } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete(complete('t1'))
    await clock.settle()

    const posts = world.fetches.filter(one => one.method === 'POST')

    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('https://tokenbreak.dev/api/v1/impressions')
    expect(JSON.parse(posts[0]?.body ?? '{}').impressions).toHaveLength(20)
    expect(JSON.parse(posts[0]?.body ?? '{}').modVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(world.store.get('queue')).toEqual([])
  })

  test('the built-in house ads are never reported', async ($, on) => {
    const world = worldOf(on, { isAdServerUp: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete(complete('t1'))
    await clock.settle()
    expect(world.store.get('queue')).toBeUndefined()
  })
})

describe('updates', () => {
  test('a mod too old to earn shows the update notice instead of ads, and reports nothing', async ($, on) => {
    const world = worldOf(on, { release: { latest: '9.0.0', min: '9.0.0' } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'Update Tokenbreak to keep earning.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sponsored' }), 'no ad while too old').toBeUndefined()

    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete(complete('t1'))
    await clock.settle()
    expect(world.store.get('queue'), 'nothing queued').toBeUndefined()

    const steps = await $.command.run(command('update'))

    expect(steps.text).toContain('9.0.0 is out and needed to keep earning')
    expect(steps.text).toContain('/plugin update tokenbreak@tokenbreak')
    expect(steps.text).toContain('Enable auto-update')
  })

  test('an update that is merely out leaves ads running', async ($, on) => {
    worldOf(on, { release: { latest: '9.0.0', min: '0.0.1' } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'sponsored' })).toBeDefined()
    expect((await $.command.run(command('status'))).text).toContain('update out')
  })

  test('the server refusing an old version turns ads into the update notice and drops the queue', async ($, on) => {
    const world = worldOf(on, {
      ingestStatus: 426,
      stored: { queue: Array.from({ length: 19 }, (_, n) => impression(n)) },
    })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete(complete('t1'))
    await clock.settle()

    expect(world.store.get('queue')).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Update Tokenbreak to keep earning.' })).toBeDefined()
  })
  test("a refusal's minVersion that isn't a version never reaches the screen", async ($, on) => {
    const world = worldOf(on, {
      ingestStatus: 426,
      ingestMinVersion: '9.0.0\u001b]52;c;cm0gLXJmIH4=\u0007',
      stored: { queue: Array.from({ length: 19 }, (_, n) => impression(n)) },
    })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete(complete('t1'))
    await clock.settle()

    expect(world.store.get('queue')).toEqual([])
    expect(await ui.find({ type: 'Text', text: /\u001b/ })).toBeUndefined()
    expect((await $.command.run(command('update'))).text).not.toContain('\u001b')
  })
})

describe('starting up', () => {
  test('stays dormant in a -p run, where nothing draws', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(HEADLESS)
    await clock.settle()

    expect(world.commands).toEqual([])
    expect(world.fetches).toEqual([])
  })

  test('starts when the desktop app attaches to an SDK session', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(HEADLESS)
    await $.session.attach(DESKTOP)
    await $.session.attach({ ...DESKTOP, clientId: 'desktop:second' })
    await clock.settle()

    expect(world.commands).toEqual(['ads'])
    expect(world.fetches.filter(fetch => fetch.url.includes('/api/v1/ads'))).toHaveLength(1)

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'desktop' })

    expect(await ui.find({ type: 'Text', text: 'sponsored' })).toBeDefined()
    expect((await $.command.run(command('status'))).text).toContain('Ads from: https://tokenbreak.dev')
  })

  test('starts at once on a reload while the desktop is already attached', async ($, on) => {
    const world = worldOf(on, { surfaces: ['desktop'] })
    const clock = mock.clock(on, { now: START })

    await $.session.start(HEADLESS)
    await clock.settle()

    expect(world.commands).toEqual(['ads'])
  })

  test('reads an endpoint typed without a scheme as https', { options: { endpoint: 'tokenbreak.dev/' } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    expect(world.fetches[0]?.url).toMatch(/^https:\/\/tokenbreak\.dev\/api\/v1\/ads\?/)
  })
})

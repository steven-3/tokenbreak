import { describe, expect, mock, test } from 'claude-code/testing'

import type { Impression } from '../types'
import { BAND, command, complete, NAME, PANE, SESSION, START, THEATER, worldOf } from './world'

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

      expect(await ui.find({ type: 'Text', text: ' AD ' }), surface).toBeDefined()
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

      expect(await ui.find({ type: 'Text', text: ' AD ' }), surface).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: ' AD ' }), 'hidden after the press').toBeUndefined()
    expect(world.statuses.at(-1)).toContain('paused')

    const resumed = await $.command.run(command('resume'))

    expect(resumed.text).toContain('resumed')
    expect(await ui.find({ type: 'Text', text: ' AD ' }), 'back after /ads resume').toBeDefined()

    const paused = await $.command.run(command('pause today'))

    expect(paused.text).toContain('paused')
    expect(await ui.find({ type: 'Text', text: ' AD ' })).toBeUndefined()
    expect(world.store.get('pausedUntil')).toBeGreaterThan(START)
  })

  test('a pause ends by itself', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.command.run(command('pause 30m'))
    expect(await ui.find({ type: 'Text', text: ' AD ' })).toBeUndefined()
    await clock.advance(30 * 60_000 + 1)
    expect(await ui.find({ type: 'Text', text: ' AD ' })).toBeDefined()
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

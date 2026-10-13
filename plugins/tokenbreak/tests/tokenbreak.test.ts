import { describe, expect, mock, test } from 'claude-code/testing'

import { FLUSH_EVERY_MS, MOD_VERSION } from '../hooks/core'
import type { Ad, Impression } from '../types'
import { BAND, BATCH, command, complete, LOGIN, LOGO_PNG, NAME, PANE, SESSION, SIGNED_BATCH, START, THEATER, TOKEN, turn, WORKING, worldOf } from './world'

const SURFACES = ['terminal', 'desktop'] as const

/** The label every ad carries, matched whole. */
const LABEL = /^Ad$/

/** An impression queued a minute before the test starts, fresh enough to send. */
const impression = (n: number): Impression => ({ adId: 'old', format: 'banner', at: START - 60_000 + n, turnId: `old-${n}` })

/** BATCH with Acme's banner changed. */
const withAcme = (change: Partial<Ad>) => ({
  ...BATCH,
  ads: BATCH.ads.map(ad => (ad.id === 'acme-banner' ? { ...ad, ...change } : ad)),
})

const LOGO = { png: LOGO_PNG, width: 36, height: 36 }

describe('the banner', () => {
  test('draws the served ad above the prompt on the terminal and the desktop', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface })

      expect(await ui.find({ type: 'Text', text: LABEL }), surface).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }))?.text).toContain('Acme DB')
      expect(await ui.find({ type: 'Text', text: 'scales to zero' })).toBeDefined()
      expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://tokenbreak.dev/c/acme')
      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('labels the ad "Ad", never "sponsored"', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface })

      expect(await ui.find({ type: 'Text', text: LABEL }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /sponsored/i }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test("the button says the ad's call to action, and Learn more without one", async ($, on) => {
    worldOf(on, { batch: withAcme({ cta: 'Start free' }) })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /Start free/ }))?.text).toBe(' Start free ↗ ')
    await $.command.run(command('style rule'))
    expect((await ui.find({ type: 'Text', text: /Start free/ }))?.text).toBe('Start free →')

    // Shipfast names none.
    await $.command.run(command('next'))
    expect((await ui.find({ type: 'Text', text: /Learn more/ }))?.text).toBe('Learn more →')
  })

  test("draws the brand's uploaded logo in two cells on the terminal, and its glyph elsewhere", async ($, on) => {
    worldOf(on, { batch: withAcme({ logo: LOGO }) })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const terminal = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })
    const logo = await terminal.find({ type: 'Image', key: 'banner-logo' })

    expect(logo?.props).toMatchObject({ source: { png: LOGO.png }, columns: 2, rows: 1 })
    expect(await terminal.find({ type: 'Text', text: '◆' }), 'the logo replaces the glyph').toBeUndefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'desktop' })

    expect(await desktop.find({ type: 'Image' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: '◆' })).toBeDefined()
  })

  test('keeps to the glyph when pictures are off', { options: { pictures: 'off' } }, async ($, on) => {
    worldOf(on, { batch: withAcme({ logo: LOGO }) })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '◆' })).toBeDefined()
  })

  test('a logo the terminal would refuse leaves the glyph, and the banner still draws', async ($, on) => {
    worldOf(on, { batch: withAcme({ logo: { png: btoa('\xff\xd8\xff\xe0 a JPEG'), width: 36, height: 36 } }) })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '◆' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeDefined()
  })

  test('falls back to built-in house ads when the ad server is unreachable', async ($, on) => {
    worldOf(on, { isAdServerUp: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'This space for rent' })).toBeDefined()

    const status = await $.command.run(command('status'))

    expect(status.text).toContain('built-in house ads')
  })

  test('rotates to the next banner on the rotation timer', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

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
      const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface, props: { ...WORKING.props, hasSurvey: true } })

      expect(await ui.find({ type: 'Text', text: LABEL }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test('/ads pause today turns everything off, and /ads resume brings it back', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    const paused = await $.command.run(command('pause today'))

    expect(paused.text).toContain('paused')
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeUndefined()
    expect(world.store.get('pausedUntil')).toBeGreaterThan(START)

    const resumed = await $.command.run(command('resume'))

    expect(resumed.text).toContain('resumed')
    expect(await ui.find({ type: 'Text', text: LABEL }), 'back after /ads resume').toBeDefined()
  })

  test('a pause ends by itself', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    await $.command.run(command('pause 30m'))
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeUndefined()
    await clock.advance(30 * 60_000 + 1)
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeDefined()
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
    expect(await terminal.find({ type: 'Text', text: LABEL })).toBeDefined()

    const desktop = await $.ui.mount({ plugin: NAME, ...PANE, surface: 'desktop' })

    expect(await desktop.find({ type: 'Image' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: 'Branch your database' })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: LABEL })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /sponsored/i })).toBeUndefined()
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
      await turn($, clock, turnId)
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
    await turn($, clock, 't1')

    const posts = world.fetches.filter(one => one.url.endsWith('/api/v1/impressions'))

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

describe('serve tokens', () => {
  test("each impression hands back the serve token of the ad it counts, and never another ad's", async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    // A long turn: Acme's banner and its Theater, each served with a token of its own.
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(5_500)
    await $.turn.complete(complete('t1'))

    // Then Shipfast's banner, served without one.
    await clock.advance(40_000)
    await $.turn.start({ text: '', turnId: 't2' })
    expect((await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }))?.text).toContain('Shipfast')
    await clock.advance(2_000)
    await $.turn.complete(complete('t2'))
    await clock.settle()

    const queue = world.store.get('queue') as Impression[]

    expect(queue.map(one => [one.adId, one.format, one.serveToken])).toEqual([
      ['acme-banner', 'banner', 'serve.acme-banner.sig'],
      ['acme-theater', 'theater', 'serve.acme-theater.sig'],
      ['shipfast-banner', 'banner', undefined],
    ])
    expect(Object.keys(queue[2] ?? {})).not.toContain('serveToken')

    await clock.advance(FLUSH_EVERY_MS)

    const sent = JSON.parse(world.fetches.find(one => one.url.endsWith('/api/v1/impressions'))?.body ?? '{}').impressions as Impression[]

    expect(sent.map(one => one.serveToken)).toEqual(['serve.acme-banner.sig', 'serve.acme-theater.sig', undefined])
    expect(world.store.get('queue')).toEqual([])
  })

  test('a server that sends no serve tokens gets impressions without them, and nothing else changes', async ($, on) => {
    const world = worldOf(on, { stored: { queue: Array.from({ length: 19 }, (_, n) => impression(n)) } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await turn($, clock, 't1')

    const body = JSON.parse(world.fetches.find(one => one.url.endsWith('/api/v1/impressions'))?.body ?? '{}')

    expect(Object.keys(body)).toEqual(['deviceId', 'modVersion', 'impressions'])
    expect(body.impressions).toHaveLength(20)
    expect(body.impressions.at(-1)).toMatchObject({ adId: 'acme-banner', format: 'banner', turnId: 't1' })
    expect(Object.keys(body.impressions.at(-1)).join()).toBe('adId,format,at,turnId,turnToken,surface,shownMs')
    expect(world.store.get('queue')).toEqual([])
  })

  test("asks for ads with this device's id and the mod's version", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const headers = world.fetches.find(one => one.url.includes('/api/v1/ads'))?.headers

    expect(headers?.['X-Tokenbreak-Device']).toBe(world.store.get('deviceId') as string)
    expect(headers?.['X-Tokenbreak-Version']).toBe(MOD_VERSION)
    expect(headers?.authorization).toBe(`Bearer ${TOKEN}`)
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
    expect(await ui.find({ type: 'Text', text: LABEL }), 'no ad while too old').toBeUndefined()

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

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: LABEL })).toBeDefined()
    expect((await $.command.run(command('status'))).text).toContain('9.0.0 is out (/ads update)')
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

    await turn($, clock, 't1')

    expect(world.store.get('queue')).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Update Tokenbreak to keep earning.' })).toBeDefined()
  })
})

describe('accounts', () => {
  test('signed out, the band shows one sign-in hint, and nothing is fetched, shown in the Theater or counted', async ($, on) => {
    const world = worldOf(on, { isSignedIn: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'Tokenbreak is signed out' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: LABEL }), 'no ad').toBeUndefined()

    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete(complete('t1'))
    await clock.advance(10 * 60_000)

    expect(world.opened, 'no Theater').toEqual([])
    expect(world.store.get('queue'), 'nothing counted').toBeUndefined()
    expect(world.fetches.filter(one => one.url.includes('/api/v1/')), 'no ad server calls').toEqual([])
    expect((await $.command.run(command('status'))).text).toContain('Account: signed out')
  })

  test('the hint hides for the day with its ✕', async ($, on) => {
    worldOf(on, { isSignedIn: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: 'Tokenbreak is signed out' })).toBeUndefined()
  })

  test('/ads login shows a code and a link, waits for approval, then signs in and starts ads', async ($, on) => {
    const world = worldOf(on, { isSignedIn: false, approval: { after: 1 } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    const login = await $.command.run(command('login'))

    expect(login.text).toContain('WXYZ-2345')
    expect(login.text).toContain('https://tokenbreak.dev/device?user_code=WXYZ2345')
    expect(await ui.find({ type: 'Text', text: 'WXYZ-2345' }), 'the band asks for approval').toBeDefined()

    await clock.advance(5_000)
    expect(world.store.get('token'), 'still pending').toBeUndefined()

    await clock.advance(5_000)
    await clock.settle()

    expect(world.store.get('token')).toBe(TOKEN)
    expect(world.store.get('login')).toBe(LOGIN)
    expect(await ui.find({ type: 'Text', text: 'Welcome to Tokenbreak' }), 'the welcome card comes first').toBeDefined()
    expect((await $.command.run(command('status'))).text).toContain(`Account: @${LOGIN}`)

    const adsFetch = world.fetches.find(one => one.url.includes('/api/v1/ads'))

    expect(adsFetch?.headers?.authorization).toBe(`Bearer ${TOKEN}`)
  })

  test('a denied sign-in goes back to the hint', async ($, on) => {
    const world = worldOf(on, { isSignedIn: false, approval: 'denied' })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.command.run(command('login'))
    await clock.advance(5_000)
    await clock.settle()

    expect(world.store.get('token')).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Tokenbreak is signed out' })).toBeDefined()
  })

  test('a token the site refuses signs the mod out', async ($, on) => {
    const world = worldOf(on, { isTokenValid: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(world.store.get('token')).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Tokenbreak is signed out' })).toBeDefined()
  })

  test('/ads logout sends the queue with the token, ends the session on the site and forgets it', async ($, on) => {
    const world = worldOf(on, { stored: { queue: [impression(1), impression(2)] } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    const out = await $.command.run(command('logout'))

    expect(out.text).toContain(`Signed out of @${LOGIN}`)

    const posts = world.fetches.filter(one => one.method === 'POST')

    expect(posts.map(one => new URL(one.url).pathname)).toEqual(['/api/v1/impressions', '/api/auth/sign-out'])
    expect(posts.every(one => one.headers?.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(world.store.get('token')).toBeUndefined()
    expect(world.store.get('queue')).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Tokenbreak is signed out' })).toBeDefined()
  })
})

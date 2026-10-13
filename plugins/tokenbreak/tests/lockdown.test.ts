import { describe, expect, mock, test } from 'claude-code/testing'

import {
  BANNER_LINGER_MS,
  FLUSH_EVERY_MS,
  HIDE_CAMPAIGN_MS,
  IMPRESSION_MAX_AGE_MS,
  MOD_VERSION,
  WAITING_NOTICE,
} from '../hooks/core'
import type { Ad, AdBatch, Impression } from '../types'
import {
  BAND,
  BATCH,
  command,
  complete,
  NAME,
  PANE,
  SESSION,
  SIGNED_BATCH,
  START,
  TOKEN,
  turn,
  WORKING,
  worldOf,
  type World,
  type WorldOptions,
} from './world'

const LABEL = /^Ad$/
const BRAND = /Acme DB|Shipfast|Tokenbreak/

/** SIGNED_BATCH with each ad's campaign named, as the 0.6.0 server sends it. */
const CAMPAIGNS: AdBatch = {
  ...SIGNED_BATCH,
  ads: SIGNED_BATCH.ads.map(ad => ({ ...ad, campaignId: ad.brand === 'Acme DB' ? 'camp-acme' : 'camp-shipfast' })),
}

const queueOf = (store: Map<string, unknown>) => (store.get('queue') as Impression[] | undefined) ?? []
const fetchesTo = (world: World, path: string) => world.fetches.filter(one => one.url.endsWith(path))

describe('turn tokens', () => {
  test('each of the person\'s turns asks for a token, and its impressions carry it', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await turn($, clock, 't1')

    const asks = fetchesTo(world, '/api/v1/turns')

    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(queueOf(world.store)).toEqual([
      expect.objectContaining({ adId: 'acme-banner', turnId: 't1', turnToken: 'turn.1.sig', surface: 'terminal', shownMs: 2_000 }),
    ])
    expect((await $.command.run(command('status'))).text).toContain('Last turn: turn token granted')
  })

  for (const [why, turns] of [
    ['refused (429)', 429],
    ['unreachable', 'down'],
  ] as const) {
    test(`a turn whose token was ${why} still shows ads but reports nothing`, async ($, on) => {
      const world = worldOf(on, { batch: SIGNED_BATCH, turns })
      const clock = mock.clock(on, { now: START })

      await $.session.start(SESSION)
      await clock.settle()

      const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

      await $.turn.start({ text: '', turnId: 't1' })
      expect(await ui.find({ type: 'Text', text: LABEL }), 'the ad shows').toBeDefined()
      await clock.advance(5_500)
      await $.turn.complete(complete('t1'))
      await clock.settle()

      expect(world.store.get('queue')).toBeUndefined()
    })
  }

  test('a token answer later than 3s is ignored, and the turn neither waits for it nor counts', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH, turns: 'hang' })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(2_000)
    await $.turn.complete(complete('t1'))
    await clock.advance(3_000)

    expect(world.store.get('queue')).toBeUndefined()
    expect((await $.command.run(command('status'))).text).toContain('no answer within 3s')
  })

  test("a subagent's turn end is not the person's: nothing closes or counts", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(2_000)
    await $.turn.complete({ ...complete('sub-1'), agentId: 'agent-1' })
    await clock.settle()
    expect(world.store.get('queue')).toBeUndefined()

    await clock.advance(BANNER_LINGER_MS + 1)
    expect(await ui.find({ type: 'Text', text: LABEL }), 'the banner stays while the turn runs').toBeDefined()
  })

  test("turns under 10s apart don't ask: the server would refuse them", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: '', turnId })
      await clock.advance(2_000)
      await $.turn.complete(complete(turnId))
      await clock.settle()
    }

    expect(fetchesTo(world, '/api/v1/turns')).toHaveLength(1)
    expect(queueOf(world.store).map(one => one.turnId)).toEqual(['t1'])
  })
})

describe('the surface', () => {
  test('the desktop app says desktop on the ad request, the turn and the impression', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start({ ...SESSION, surface: 'desktop' })
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'desktop' })
    await turn($, clock, 't1')

    expect(fetchesTo(world, '/api/v1/ads?formats=banner,theater')[0]?.headers?.['X-Tokenbreak-Surface']).toBe('desktop')
    expect(JSON.parse(fetchesTo(world, '/api/v1/turns')[0]?.body ?? '{}').surface).toBe('desktop')
    expect(queueOf(world.store)[0]?.surface).toBe('desktop')
  })
})

describe('time on screen', () => {
  test('a banner under a second earns nothing; one second does', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await turn($, clock, 't1', 999)
    expect(world.store.get('queue'), 'under a second').toBeUndefined()

    await turn($, clock, 't2', 1_000)
    expect(queueOf(world.store)).toEqual([expect.objectContaining({ turnId: 't2', shownMs: 1_000 })])
  })

  test('of the banners a turn showed, the one on screen longest is reported, once', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    // Acme from 25s to the rotation at 40s (15s), then Shipfast to 70s (30s).
    await clock.advance(25_000)
    await $.turn.start({ text: '', turnId: 't1' })
    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Acme DB')
    await clock.advance(45_000)
    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Shipfast')
    await $.turn.complete(complete('t1'))
    await clock.settle()

    const banners = queueOf(world.store).filter(one => one.format === 'banner')

    expect(banners).toEqual([expect.objectContaining({ adId: 'shipfast-banner', shownMs: 30_000 })])
  })

  test('the Theater counts once its pane was open 2s, the banner on its own second', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    // The pane opens at 3s: a 4.5s turn holds it 1.5s, too short.
    await turn($, clock, 't1', 4_500)
    expect(queueOf(world.store).map(one => one.format)).toEqual(['banner'])

    await turn($, clock, 't2', 5_000)

    const theater = queueOf(world.store).filter(one => one.format === 'theater')

    expect(theater).toEqual([
      expect.objectContaining({ adId: 'acme-theater', turnId: 't2', serveToken: 'serve.acme-theater.sig', shownMs: 2_000 }),
    ])
  })

  test('impressions older than 24 hours are dropped, not sent', async ($, on) => {
    const stale: Impression = { adId: 'old', format: 'banner', at: START - IMPRESSION_MAX_AGE_MS - 1, turnId: 'old' }
    const fresh: Impression = { adId: 'new', format: 'banner', at: START - 60_000, turnId: 'new' }
    const world = worldOf(on, { stored: { queue: [stale, fresh] } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(FLUSH_EVERY_MS)

    const sent = JSON.parse(fetchesTo(world, '/api/v1/impressions')[0]?.body ?? '{}').impressions as Impression[]

    expect(sent.map(one => one.adId)).toEqual(['new'])
    expect(world.store.get('queue')).toEqual([])
  })
})

describe('when the banner shows', () => {
  test('during a turn and 30s after it, then not until the next', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: LABEL }), 'no turn yet').toBeUndefined()
    await $.turn.start({ text: '', turnId: 't1' })
    expect(await ui.find({ type: 'Text', text: LABEL }), 'during the turn').toBeDefined()
    await clock.advance(5_000)
    await $.turn.complete(complete('t1'))
    await clock.advance(BANNER_LINGER_MS - 1)
    expect(await ui.find({ type: 'Text', text: LABEL }), 'lingering').toBeDefined()
    await clock.advance(1)
    expect(await ui.find({ type: 'Text', text: LABEL }), 'after the linger').toBeUndefined()
    await clock.advance(60_000)
    expect(await ui.find({ type: 'Text', text: LABEL }), 'still hidden').toBeUndefined()
    await $.turn.start({ text: '', turnId: 't2' })
    expect(await ui.find({ type: 'Text', text: LABEL }), 'the next turn').toBeDefined()
  })

  test('a turn starting in the linger keeps it up, and the old linger never hides it', async ($, on) => {
    worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await turn($, clock, 't1')
    await $.turn.start({ text: '', turnId: 't2' })
    await clock.advance(BANNER_LINGER_MS + 5_000)
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeDefined()
  })

  test('the linger after a turn never counts toward its time on screen', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await turn($, clock, 't1', 500)
    await clock.advance(BANNER_LINGER_MS)

    expect(world.store.get('queue')).toBeUndefined()
  })

  for (const [columns, isShown] of [
    [79, false],
    [80, true],
  ] as const) {
    test(`a ${columns}-column terminal ${isShown ? 'shows' : 'gets no'} banner`, async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on, { now: START })

      await $.session.start(SESSION)
      await clock.settle()

      const viewport = { columns, rows: 40, isFullscreen: false }
      const ui = await $.ui.mount({ plugin: NAME, ...WORKING, viewport, surface: 'terminal' })

      expect(Boolean(await ui.find({ type: 'Text', text: LABEL }))).toBe(isShown)
      await turn($, clock, 't1')
      expect(queueOf(world.store).length, 'counted only where shown').toBe(isShown ? 1 : 0)
    })
  }
})

describe('✕', () => {
  test('hides that campaign on this machine for 30 days, moves to the next ad and tells the server', async ($, on) => {
    const world = worldOf(on, { batch: CAMPAIGNS })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Acme DB')
    await ui.press({ key: 'hide' })
    await clock.settle()

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text, 'the next ad').toContain('Shipfast')
    expect(world.store.get('hidden')).toEqual({ 'camp-acme': START + HIDE_CAMPAIGN_MS })
    expect(world.store.get('pausedUntil'), 'nothing paused').toBeUndefined()
    expect(world.toasts.at(-1)).toContain('hidden on this machine for 30 days')

    const hide = fetchesTo(world, '/api/v1/reports')

    expect(hide).toHaveLength(1)
    expect(JSON.parse(hide[0]?.body ?? '{}')).toEqual({ adId: 'acme-banner', serveToken: 'serve.acme-banner.sig', reason: 'hide' })

    // Rotation skips it: every banner from now on is Shipfast's.
    for (let at = 0; at < 3; at++) {
      await $.command.run(command('next'))
      expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Shipfast')
    }

    // The Theater skips it too.
    await $.ui.render(BAND)
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.advance(3_500)

    const pane = await $.ui.mount({ plugin: NAME, ...PANE, surface: 'desktop' })

    expect(await pane.find({ type: 'Text', text: 'Branch your database' })).toBeUndefined()
    await $.turn.complete(complete('t1'))

  })

  test('a hide ends when it expires, and the campaign is back in rotation', async ($, on) => {
    const world = worldOf(on, { batch: CAMPAIGNS, stored: { hidden: { 'camp-acme': START + 50_000 } } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Shipfast')

    // The rotation at 40s still skips it; the one at 80s finds it expired.
    await clock.advance(80_000)

    const brands = new Set<string>()

    for (let at = 0; at < 2; at++) {
      await $.command.run(command('next'))
      brands.add((await ui.find({ type: 'Text', text: BRAND }))?.text ?? '')
    }

    expect([...brands].some(text => text.includes('Acme DB'))).toBe(true)
    expect(world.store.get('hidden')).toEqual({})
  })

  test('hiding every paid banner leaves the house ads, and the hide outlives the session', async ($, on) => {
    const world = worldOf(on, { batch: CAMPAIGNS, stored: { hidden: { 'camp-acme': START + 1_000_000, 'camp-shipfast': START + 1_000_000 } } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Tokenbreak')
    expect((await $.command.run(command('status'))).text).toContain('Hidden advertisers: 2')
    await turn($, clock, 't1')
    expect(world.store.get('queue'), 'house ads never count').toBeUndefined()
  })
})

describe('/ads report', () => {
  test('sends the paid ad on screen, the reason and the note, for human review', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    const reply = await $.command.run(command('report misleading says free, but it is not'))

    expect(reply.text).toContain('Reported Acme DB (misleading)')
    expect(reply.text).toContain('human review')
    expect(reply.text).not.toContain('once accounts launch')

    const sent = fetchesTo(world, '/api/v1/reports')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.headers?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      adId: 'acme-banner',
      serveToken: 'serve.acme-banner.sig',
      reason: 'misleading',
      note: 'says free, but it is not',
    })
    expect(world.store.get('reportQueue')).toEqual([])
  })

  test('without a reason word it says other, and the words are the note', async ($, on) => {
    const world = worldOf(on, { batch: SIGNED_BATCH })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })
    await $.command.run(command('report'))
    await $.command.run(command('report weird colors'))

    expect(fetchesTo(world, '/api/v1/reports').map(one => JSON.parse(one.body ?? '{}'))).toEqual([
      { adId: 'acme-banner', serveToken: 'serve.acme-banner.sig', reason: 'other' },
      { adId: 'acme-banner', serveToken: 'serve.acme-banner.sig', reason: 'other', note: 'weird colors' },
    ])
  })

  test('offline, the report waits and goes once the server answers', async ($, on) => {
    const options: WorldOptions = { batch: SIGNED_BATCH, isReportsUp: false }
    const world = worldOf(on, options)
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()
    await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })
    await turn($, clock, 't1')

    // The banner has gone; the last paid ad on screen is still the one reported.
    await clock.advance(BANNER_LINGER_MS)

    const reply = await $.command.run(command('report scam'))

    expect(reply.text).toContain('Saved your report on Acme DB (scam)')
    expect(world.store.get('reportQueue')).toEqual([expect.objectContaining({ adId: 'acme-banner', reason: 'scam' })])
    expect((await $.command.run(command('status'))).text).toContain('Reports waiting to send: 1')

    options.isReportsUp = true
    await clock.advance(FLUSH_EVERY_MS)

    expect(world.store.get('reportQueue')).toEqual([])
    expect(fetchesTo(world, '/api/v1/reports').length).toBeGreaterThan(1)
  })

  test('with no paid ad shown yet, there is nothing to report', async ($, on) => {
    const world = worldOf(on, { isAdServerUp: false })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    expect((await $.command.run(command('report scam'))).text).toContain("nothing to report")
    expect(fetchesTo(world, '/api/v1/reports')).toEqual([])
  })
})

describe('the welcome card', () => {
  test('comes once after the first sign-in, until the next turn has ended', async ($, on) => {
    const world = worldOf(on, { isSignedIn: false, approval: { after: 0 } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...BAND, surface: 'terminal' })

    await $.command.run(command('login'))
    await clock.advance(5_000)
    await clock.settle()

    for (const words of ['hides that advertiser for 30 days', '/ads pause stops ads', 'tokenbreak.dev/dashboard/earn', 'Enable auto-update']) {
      expect(await ui.find({ type: 'Text', text: words }), words).toBeDefined()
    }

    expect((await ui.find({ type: 'Link', key: undefined }))?.props.href).toBe('https://tokenbreak.dev/dashboard/earn')

    // It holds through the next turn and its linger, and counts nothing.
    await $.turn.start({ text: '', turnId: 't1' })
    expect(await ui.find({ type: 'Text', text: 'Welcome to Tokenbreak' })).toBeDefined()
    await clock.advance(2_000)
    await $.turn.complete(complete('t1'))
    await clock.settle()
    expect(world.store.get('queue'), 'nothing counted').toBeUndefined()
    await clock.advance(BANNER_LINGER_MS)

    expect(await ui.find({ type: 'Text', text: 'Welcome to Tokenbreak' })).toBeUndefined()
    expect(world.store.get('welcomed')).toBe(true)

    await clock.advance(10_000)
    await $.turn.start({ text: '', turnId: 't2' })
    expect(await ui.find({ type: 'Text', text: LABEL }), 'then ads').toBeDefined()

    // Signing in again on this machine doesn't bring it back.
    await $.command.run(command('logout'))
    await $.command.run(command('login'))
    await clock.advance(5_000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Welcome to Tokenbreak' })).toBeUndefined()
  })

  test('its ✕ puts it away at once', async ($, on) => {
    const world = worldOf(on, { isSignedIn: false, approval: { after: 0 } })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    await $.command.run(command('login'))
    await clock.advance(5_000)
    await clock.settle()
    await ui.press({ key: 'hide' })

    expect(await ui.find({ type: 'Text', text: 'Welcome to Tokenbreak' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: LABEL })).toBeDefined()
    expect(world.store.get('welcomed')).toBe(true)
  })
})

describe('the kill switch', () => {
  test('a switched-off version shows nothing, reports nothing, and /ads says to update', async ($, on) => {
    const world = worldOf(on, {
      release: { latest: '0.7.0', min: MOD_VERSION, blocked: true },
      stored: { queue: [{ adId: 'a', format: 'banner', at: START - 1_000, turnId: 'x' }] },
    })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: LABEL }), 'no ad').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Tokenbreak/ }), 'no notice either').toBeUndefined()
    expect(world.store.get('queue'), 'the queue is dropped').toEqual([])

    await $.ui.render(BAND)
    await turn($, clock, 't1', 5_000)
    await clock.advance(FLUSH_EVERY_MS)

    expect(world.opened, 'no Theater').toEqual([])
    expect(fetchesTo(world, '/api/v1/turns'), 'no turn tokens').toEqual([])
    expect(fetchesTo(world, '/api/v1/impressions'), 'no reports').toEqual([])
    expect(world.toasts, 'no toasts').toEqual([])

    const status = (await $.command.run(command('status'))).text

    expect(status).toContain('switched off')
    expect(status).toContain('/ads update')
    expect((await $.command.run(command('next'))).text).toContain('has been switched off')
    expect((await $.command.run(command('update'))).text).toContain('/plugin update tokenbreak@tokenbreak')
  })

  test('it holds across sessions until the server says otherwise', async ($, on) => {
    worldOf(on, {
      isAdServerUp: false,
      stored: { batch: { ...BATCH, mod: { latest: '0.7.0', min: MOD_VERSION, blocked: true } } },
    })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: LABEL })).toBeUndefined()
    expect((await $.command.run(command('status'))).text).toContain('switched off')
  })
})

describe('earning seats', () => {
  const HOUSE_BANNER: Ad = {
    id: 'house-seat',
    format: 'banner',
    brand: 'Tokenbreak',
    headline: 'Seats open as advertisers join.',
    accent: '#FFE600',
    clickUrl: 'https://tokenbreak.dev/earn',
    isHouse: true,
  }

  test('waiting for a seat: house ads only, one line saying so, and nothing counted', async ($, on) => {
    const world = worldOf(on, { batch: { ...SIGNED_BATCH, ads: [...SIGNED_BATCH.ads, HOUSE_BANNER], seat: 'waiting' } as AdBatch })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: 'Seats open as advertisers join.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Acme DB|Shipfast/ }), 'no paid ad').toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /earning seat/ }))?.text).toBe(WAITING_NOTICE)

    await turn($, clock, 't1', 5_000)

    expect(world.store.get('queue')).toBeUndefined()
    expect(fetchesTo(world, '/api/v1/turns')).toEqual([])
    expect((await $.command.run(command('status'))).text).toContain('Seat: waiting')
  })

  test('a waiting batch with no house ads of its own shows the built-in ones', async ($, on) => {
    worldOf(on, { batch: { ...SIGNED_BATCH, seat: 'waiting' } as AdBatch })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Tokenbreak')
    expect(await ui.find({ type: 'Text', text: WAITING_NOTICE })).toBeDefined()
  })

  test('an earning seat shows paid ads and no notice', async ($, on) => {
    worldOf(on, { batch: { ...SIGNED_BATCH, seat: 'earning' } as AdBatch })
    const clock = mock.clock(on, { now: START })

    await $.session.start(SESSION)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: NAME, ...WORKING, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: BRAND }))?.text).toContain('Acme DB')
    expect(await ui.find({ type: 'Text', text: /earning seat/ })).toBeUndefined()
  })
})

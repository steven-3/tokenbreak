import { describe, expect, test } from 'claude-code/testing'

import {
  cacheable,
  canDockTheater,
  capQueue,
  currentBanner,
  HOUSE_ADS,
  linkable,
  parseBatch,
  pauseUntil,
  rotationMs,
  inkOn,
  tint,
  posterOf,
  compareVersions,
  updateStateOf,
  MOD_VERSION,
  theaterLayout,
  withoutFrames,
  bannerStyleOf,
  theaterArt,
  formatUserCode,
  parseDeviceCode,
  parseDevicePoll,
  AD_LABEL,
  MOD_HEADERS,
  queueOf,
  shownOf,
  isPng,
  activeHides,
  endStretch,
  freshOf,
  IMPRESSION_MAX_AGE_MS,
  longestPaid,
  noteDrawn,
  parseGrant,
  reportArgsOf,
  reportQueueOf,
  rotationOf,
  surfaceOf,
  trackerOf,
} from '../hooks/core'
import type { Ad } from '../types'
import { BATCH, LOGO_PNG, SIGNED_BATCH } from './world'

describe('core', () => {
  test('a Theater video parses, its rate held to 1-30 fps, and an empty or oversized one is dropped', () => {
    const theater = { id: 'v', format: 'theater', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const parse = (video: unknown) => parseBatch(JSON.stringify({ ads: [{ ...theater, video }] }))?.ads[0]?.video

    expect(parse({ frames: ['a', 'b'], fps: 120, width: 4, height: 3 })).toEqual({ frames: ['a', 'b'], fps: 30, width: 4, height: 3 })
    expect(parse({ frames: [], fps: 12, width: 4, height: 3 })).toBeUndefined()
    expect(parse({ frames: Array(241).fill('a'), fps: 12, width: 4, height: 3 })).toBeUndefined()
    expect(parse({ frames: ['a', 3], fps: 12, width: 4, height: 3 })).toBeUndefined()
  })

  test('session state holds video ads without their frames', () => {
    const video = { frames: ['a', 'b', 'c', 'd'], fps: 10, width: 4, height: 3 }
    const ad = { id: 'v', format: 'theater' as const, brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev', isHouse: false, video }

    expect(withoutFrames([ad])[0]?.video).toEqual({ frames: [], fps: 10, width: 4, height: 3 })
    expect(ad.video.frames).toHaveLength(4)
    expect(posterOf(40)).toBe(30)
  })

  test('the Theater picks the cut and arrangement with the biggest picture', () => {
    const shapes = [
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
    ]

    // A tall, narrow pane: the vertical cut, stacked over the card.
    expect(theaterLayout(70, 80, shapes)).toMatchObject({ mode: 'stack', shape: 0, columns: 70 })
    // A wide, short pane: the landscape cut beside the card.
    expect(theaterLayout(150, 30, shapes)).toMatchObject({ mode: 'side', shape: 1, rows: 29 })
    // One shape only: it is still fitted without distortion.
    const only = theaterLayout(70, 80, [shapes[1] as { width: number; height: number }])

    expect(Math.abs(only.columns / only.rows - (16 / 9) * 2)).toBeLessThan(0.2)
  })

  test('a server ad may carry video cuts, but never local files, and never sound', () => {
    const theater = { id: 't', format: 'theater', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const cut = { frames: ['a', 'b'], fps: 15, width: 9, height: 16, files: ['/etc/passwd'] }
    const server = 'https://tokenbreak.dev'
    const withAudio = (audio: unknown) => parseBatch(JSON.stringify({ ads: [{ ...theater, audio }] }))?.ads[0]?.audio
    const ad = parseBatch(
      JSON.stringify({ ads: [{ ...theater, videos: [cut, cut, cut, cut], audio: { url: `${server}/m/s.m4a` } }] }),
    )?.ads[0]

    expect(ad?.videos).toHaveLength(3)
    expect(ad?.videos?.[0]?.files).toBeUndefined()
    // Theater never plays sound (FMT-03): not from the ad server, not from an advertiser's host
    // (which would also see each viewer's IP), not a file of the plugin's own.
    expect(ad?.audio).toBeUndefined()
    expect(withAudio({ url: 'https://tracker.example/s.m4a' })).toBeUndefined()
    expect(withAudio({ url: 'https://192.168.1.10/s.m4a' })).toBeUndefined()
    expect(withAudio({ asset: 'hooks/register.tsx' })).toBeUndefined()
  })

  test('a banner logo is kept only within its tiny budget', () => {
    const banner = { id: 'b', format: 'banner', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    // The real logo, padded out past its end to `bytes`.
    const logo = (bytes: number) => ({ png: btoa(atob(LOGO_PNG).padEnd(bytes, '\0')), width: 36, height: 36 })
    const parse = (bytes: number) => parseBatch(JSON.stringify({ ads: [{ ...banner, logo: logo(bytes) }] }))?.ads[0]?.logo

    expect(parse(400)).toBeDefined()
    expect(parse(768)).toBeDefined()
    expect(parse(769)).toBeUndefined()
    expect(parse(3000)).toBeUndefined()
  })

  test("a banner logo the terminal wouldn't take is dropped, so the banner draws its glyph", () => {
    const png = atob(LOGO_PNG)
    const banner = { id: 'b', format: 'banner', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const parse = (logo: string) => parseBatch(JSON.stringify({ ads: [{ ...banner, logo: { png: logo, width: 36, height: 36 } }] }))?.ads[0]

    expect(isPng(LOGO_PNG)).toBe(true)
    expect(parse(LOGO_PNG)?.logo?.png).toBe(LOGO_PNG)

    for (const [why, logo] of [
      ['empty', ''],
      ['not base64', `!!!!${LOGO_PNG}`],
      ['unpadded', LOGO_PNG.replace(/=+$/, '')],
      ['a JPEG', btoa(`\xff\xd8\xff\xe0${png.slice(4)}`)],
      ['the signature alone', btoa(png.slice(0, 8))],
      ['65536 pixels a side', btoa(`${png.slice(0, 16)}\x00\x01\x00\x00\x00\x01\x00\x00${png.slice(24)}`)],
      ['0 pixels wide', btoa(`${png.slice(0, 16)}\x00\x00\x00\x00${png.slice(20)}`)],
    ] as const) {
      expect(isPng(logo), why).toBe(false)
      expect(parse(logo)?.logo, why).toBeUndefined()
      expect(parse(logo)?.brand, `${why}: the ad stays`).toBe('B')
    }
  })

  test('a serve token is kept only as a string of 1 to 512 characters; the ad shows either way', () => {
    const banner = { id: 'b', format: 'banner', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const parse = (serveToken: unknown) => parseBatch(JSON.stringify({ ads: [{ ...banner, serveToken }] }))?.ads[0]

    expect(parse('v1.abc.sig')?.serveToken).toBe('v1.abc.sig')
    expect(parse('t'.repeat(512))?.serveToken).toHaveLength(512)

    for (const bad of ['t'.repeat(513), '', 42, null, { token: 'x' }, ['x']]) {
      const ad = parse(bad)

      expect(ad, JSON.stringify(bad).slice(0, 20)).toBeDefined()
      expect(Object.keys(ad ?? {}), JSON.stringify(bad).slice(0, 20)).not.toContain('serveToken')
    }

    // A server that sends none: no token at all, as before.
    expect(parseBatch(JSON.stringify(BATCH))?.ads.every(ad => !('serveToken' in ad))).toBe(true)
  })

  test("an impression takes the shown ad's own token, and a queued one loses a malformed token", () => {
    const [acme, shipfast] = SIGNED_BATCH.ads

    expect(shownOf(acme!)).toEqual({ adId: 'acme-banner', serveToken: 'serve.acme-banner.sig' })
    expect(Object.keys(shownOf(shipfast!))).toEqual(['adId'])
    expect(
      queueOf([
        { adId: 'a', format: 'banner', at: 1, serveToken: 'tok' },
        { adId: 'b', format: 'banner', at: 2, serveToken: 7 },
        { adId: 'c', format: 'banner', at: 3, serveToken: 'x'.repeat(513) },
        { adId: 'd', format: 'banner', at: 4 },
      ]).map(one => Object.keys(one).join()),
    ).toEqual(['adId,format,at,serveToken', 'adId,format,at', 'adId,format,at', 'adId,format,at'])
  })

  test('the label and request headers are spelled as the ad server expects', () => {
    expect(AD_LABEL).toBe('Ad')
    expect(MOD_HEADERS).toEqual({
      device: 'X-Tokenbreak-Device',
      version: 'X-Tokenbreak-Version',
      surface: 'X-Tokenbreak-Surface',
    })
  })

  test('versions compare part by part, and the update state follows the server', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.2', '0.3.2')).toBe(0)
    expect(compareVersions('0.2.9', '0.3.0')).toBeLessThan(0)
    expect(updateStateOf(undefined)).toEqual({ kind: 'current' })
    expect(updateStateOf({ latest: MOD_VERSION, min: MOD_VERSION })).toEqual({ kind: 'current' })
    expect(updateStateOf({ latest: '9.0.0', min: '0.0.1' })).toEqual({ kind: 'available', latest: '9.0.0' })
    expect(updateStateOf({ latest: '9.0.0', min: '9.0.0' })).toEqual({ kind: 'required', latest: '9.0.0' })
    expect(parseBatch(JSON.stringify({ ads: [], mod: { latest: 'x', min: '1.0.0' } }))?.mod).toBeUndefined()
  })

  test('call-to-action ink reads on its color, and unknown styles fall back to pill', () => {
    expect(inkOn('#FFFFFF')).toBe('#141414')
    expect(inkOn('#95BF47')).toBe('#141414')
    expect(inkOn('#635BFF')).toBe('#FFFFFF')
    expect(tint('#FFFFFF', 0.22)).toBe('#484848')
    expect(tint('#3FCF8E', 0)).toBe('#141414')
    expect(tint('#3FCF8E', 1)).toBe('#3fcf8e')
    expect(bannerStyleOf('card')).toBe('card')
    expect(bannerStyleOf('neon')).toBe('pill')
  })

  test('rotation follows the frequency option, normal by default', () => {
    expect(rotationMs('chill')).toBe(90_000)
    expect(rotationMs('max')).toBe(20_000)
    expect(rotationMs('bogus')).toBe(40_000)
  })

  test('a batch parses, and malformed ads are dropped', () => {
    const text = JSON.stringify({ ...BATCH, ads: [...BATCH.ads, { id: 3 }, { format: 'popup' }] })

    expect(parseBatch(text)?.ads).toHaveLength(3)
    expect(parseBatch('not json')).toBeUndefined()
    expect(parseBatch('{"ads":"nope"}')).toBeUndefined()
  })

  test('a bad accent falls back to ad-slot yellow and long fields are cut', () => {
    const batch = parseBatch(
      JSON.stringify({
        ads: [{ id: 'x', format: 'banner', brand: 'B'.repeat(40), headline: 'h', accent: 'red', clickUrl: 'https://a.dev' }],
      }),
    )

    expect(batch?.ads[0]?.accent).toBe('#FFE600')
    expect(batch?.ads[0]?.brand).toHaveLength(24)
  })

  test('control characters and bidi overrides are stripped from ad text', () => {
    const batch = parseBatch(
      JSON.stringify({
        ads: [
          {
            id: 'x\u001b]8;;',
            format: 'banner',
            brand: '\u202eBrand',
            headline: 'Hi\u001b[2J\u001b]0;pwned\u0007\u009b31m',
            clickUrl: 'https://a.dev',
          },
        ],
      }),
    )

    expect(batch?.ads[0]?.headline).toBe('Hi [2J ]0;pwned  31m')
    expect(batch?.ads[0]?.brand).toBe('Brand')
    expect(batch?.ads[0]?.id).toBe('x ]8;;')
  })

  test('only https (or http on localhost) links are drawn', () => {
    expect(linkable('https://tokenbreak.dev/c/abc')).toBe('https://tokenbreak.dev/c/abc')
    expect(linkable('http://localhost:3000/c/abc')).toBe('http://localhost:3000/c/abc')
    expect(linkable('http://evil.example/c')).toBeUndefined()
    expect(linkable('javascript:alert(1)')).toBeUndefined()
    expect(linkable('https://user@host.dev/')).toBeUndefined()
  })

  test('the queue keeps the newest 200', () => {
    const queue = Array.from({ length: 250 }, (_, n) => ({ adId: 'a', format: 'banner' as const, at: n }))
    const capped = capQueue(queue)

    expect(capped).toHaveLength(200)
    expect(capped[0]?.at).toBe(50)
    expect(capped.at(-1)?.at).toBe(249)
  })

  test('the Theater docks only fullscreen at 144+ columns', () => {
    expect(canDockTheater(undefined)).toBe(false)
    expect(canDockTheater({ columns: 160, rows: 48, isFullscreen: true, maxRows: 20 })).toBe(true)
    expect(canDockTheater({ columns: 143, rows: 48, isFullscreen: true, maxRows: 20 })).toBe(false)
    expect(canDockTheater({ columns: 200, rows: 48, isFullscreen: false, maxRows: 48 })).toBe(false)
    // A build that doesn't report isFullscreen: a short band means fullscreen.
    expect(canDockTheater({ columns: 200, rows: 48, maxRows: 17 })).toBe(true)
    expect(canDockTheater({ columns: 200, rows: 48, maxRows: 48 })).toBe(false)
  })

  test('pause lengths', () => {
    expect(pauseUntil('', 0)).toBe(3_600_000)
    expect(pauseUntil('30m', 0)).toBe(1_800_000)
    expect(pauseUntil('2h', 0)).toBe(7_200_000)
    expect(pauseUntil('today', 1_000)).toBeGreaterThan(1_000)
    expect(pauseUntil('forever', 0)).toBeUndefined()
  })

  test('banners rotate through the banner ads only', () => {
    expect(currentBanner(BATCH.ads, 0)?.id).toBe('acme-banner')
    expect(currentBanner(BATCH.ads, 1)?.id).toBe('shipfast-banner')
    expect(currentBanner(BATCH.ads, 2)?.id).toBe('acme-banner')
    expect(currentBanner([], 0)).toBeUndefined()
  })

  test('house ads are all Tokenbreak promos', () => {
    expect(HOUSE_ADS.every(ad => ad.isHouse && ad.clickUrl.startsWith('https://tokenbreak.dev'))).toBe(true)
  })

  test('a big batch is cached without its images', () => {
    const big = { ...BATCH, ads: [{ ...BATCH.ads[2]!, image: { png: 'A'.repeat(1_600_000), width: 1, height: 1 } }] }

    expect(cacheable(big).ads[0]?.image).toBeUndefined()
    expect(cacheable(BATCH)).toEqual(BATCH)
  })

  test('the fallback Theater picture is 256x144 RGBA', () => {
    const art = theaterArt()

    expect(art.width).toBe(256)
    expect(art.height).toBe(144)
    expect(atob(art.rgba).length).toBe(256 * 144 * 4)
  })
})

describe('/ads login parsing', () => {
  test('reads the device code answer, with the code filled into the link', () => {
    const code = parseDeviceCode(
      JSON.stringify({
        device_code: 'd',
        user_code: 'WXYZ2345',
        verification_uri: 'https://tokenbreak.dev/device',
        verification_uri_complete: 'https://tokenbreak.dev/device?user_code=WXYZ2345',
        expires_in: 900,
        interval: 5,
      }),
    )

    expect(code).toEqual({
      deviceCode: 'd',
      userCode: 'WXYZ2345',
      url: 'https://tokenbreak.dev/device?user_code=WXYZ2345',
      intervalMs: 5_000,
      expiresInMs: 900_000,
    })
    expect(parseDeviceCode('{"device_code":"d","user_code":"u","verification_uri":"javascript:alert(1)"}'), 'not a web link').toBeUndefined()
    expect(parseDeviceCode('<html>'), 'not JSON').toBeUndefined()
  })

  test('shows an 8-letter code as two halves', () => {
    expect(formatUserCode('WXYZ2345')).toBe('WXYZ-2345')
    expect(formatUserCode('ABC')).toBe('ABC')
  })

  test('a poll signs in, waits, slows down, or gives up', () => {
    expect(parseDevicePoll(200, '{"access_token":"t","expires_in":1}')).toEqual({ kind: 'token', token: 't' })
    expect(parseDevicePoll(400, '{"error":"authorization_pending"}')).toEqual({ kind: 'wait', slower: false })
    expect(parseDevicePoll(400, '{"error":"slow_down"}')).toEqual({ kind: 'wait', slower: true })
    expect(parseDevicePoll(400, '{"error":"access_denied"}')).toEqual({ kind: 'stop', reason: 'denied' })
    expect(parseDevicePoll(400, '{"error":"expired_token"}')).toEqual({ kind: 'stop', reason: 'expired' })
    expect(parseDevicePoll(502, 'Bad gateway'), 'a hiccup keeps waiting').toEqual({ kind: 'wait', slower: false })
  })

  test('time on screen: the longest continuous stretch per ad, counted only while the turn runs', () => {
    const [acme, shipfast] = BATCH.ads as [Ad, Ad]
    const house = HOUSE_ADS[0] as Ad
    let tracker = noteDrawn(trackerOf(true), acme, 0)

    tracker = noteDrawn(tracker, acme, 500) // drawn again: the same stretch
    tracker = noteDrawn(tracker, shipfast, 1_500) // Acme 1.5s
    tracker = noteDrawn(tracker, acme, 2_000) // Shipfast 0.5s
    tracker = noteDrawn(tracker, undefined, 2_800) // Acme 0.8s: its longest stays 1.5s
    tracker = noteDrawn(tracker, house, 3_000)
    tracker = endStretch(tracker, 60_000) // the house ad: 57s, never paid

    expect(tracker.best['acme-banner']?.ms).toBe(1_500)
    expect(tracker.best['shipfast-banner']?.ms).toBe(500)
    expect(longestPaid(tracker, 1_000)).toMatchObject({ adId: 'acme-banner', ms: 1_500 })
    expect(longestPaid(tracker, 2_000), 'none long enough').toBeUndefined()

    // Outside a turn nothing is kept.
    expect(endStretch(noteDrawn(trackerOf(false), acme, 0), 9_000).best).toEqual({})
  })

  test('a refreshed serve token carries the stretch on under the newest token', () => {
    const acme = SIGNED_BATCH.ads[0] as Ad
    const tracker = endStretch(noteDrawn(noteDrawn(trackerOf(true), acme, 0), { ...acme, serveToken: 'serve.new' }, 4_000), 5_000)

    expect(tracker.best['acme-banner']).toEqual({ adId: 'acme-banner', serveToken: 'serve.new', isHouse: false, ms: 5_000 })
  })

  test('impressions older than 24h are dropped', () => {
    const now = 10 * IMPRESSION_MAX_AGE_MS
    const at = (age: number) => ({ adId: 'a', format: 'banner' as const, at: now - age })

    expect(freshOf([at(IMPRESSION_MAX_AGE_MS + 1), at(IMPRESSION_MAX_AGE_MS), at(0)], now)).toEqual([at(IMPRESSION_MAX_AGE_MS), at(0)])
  })

  test('hides: expired and malformed ones drop; rotation skips hidden campaigns and waits on house ads', () => {
    expect(activeHides({ a: 5, b: 20, c: 'x' }, 10)).toEqual({ b: 20 })
    expect(activeHides(null, 10)).toEqual({})

    const ads = BATCH.ads.map(ad => ({ ...ad, campaignId: `camp-${ad.brand}` }))
    const ids = (list: Ad[]) => list.map(ad => ad.id)

    expect(ids(rotationOf(ads, { 'camp-Acme DB': 99 }, 10))).toEqual(['shipfast-banner'])
    expect(ids(rotationOf(ads, { 'camp-Acme DB': 5 }, 10)), 'expired').toEqual(ids(ads))
    // Every paid banner hidden, or waiting for a seat: the built-in house banners stand in.
    expect(rotationOf(ads, { 'camp-Acme DB': 99, 'camp-Shipfast': 99 }, 10).every(ad => ad.isHouse)).toBe(true)
    expect(rotationOf(ads, {}, 10, 'waiting').every(ad => ad.isHouse)).toBe(true)
    // An ad with no campaign hides by its own id.
    expect(ids(rotationOf(BATCH.ads, { 'acme-banner': 99 }, 10))).toEqual(['shipfast-banner', 'acme-theater'])
  })

  test('a turn grant parses, and anything else is none', () => {
    expect(parseGrant('{"turnId":"t","turnToken":"x.y","issuedAt":5}')).toEqual({ turnId: 't', turnToken: 'x.y', issuedAt: 5 })
    expect(parseGrant('{"turnId":"t","turnToken":"","issuedAt":5}')).toBeUndefined()
    expect(parseGrant(`{"turnId":"t","turnToken":"${'x'.repeat(513)}","issuedAt":5}`)).toBeUndefined()
    expect(parseGrant('{"error":"Too many turns"}')).toBeUndefined()
    expect(parseGrant('<html>')).toBeUndefined()
  })

  test('/ads report words: a known reason first, the rest the note', () => {
    expect(reportArgsOf([])).toEqual({ reason: 'other' })
    expect(reportArgsOf(['SCAM', 'fake', 'wallet'])).toEqual({ reason: 'scam', note: 'fake wallet' })
    expect(reportArgsOf(['hide'])).toEqual({ reason: 'other', note: 'hide' })
    expect(reportArgsOf(['looks', 'off'])).toEqual({ reason: 'other', note: 'looks off' })
    expect(reportArgsOf(['broken', 'x'.repeat(400)]).note).toHaveLength(280)
  })

  test('the report queue keeps well-formed reports only', () => {
    expect(
      reportQueueOf([
        { adId: 'a', reason: 'scam', at: 1, note: 'n', serveToken: 's' },
        { adId: 'b', reason: 'hide', at: 2 },
        { adId: 'c', reason: 'nope', at: 3 },
        { adId: 'd', at: 4 },
        'x',
      ]),
    ).toEqual([
      { adId: 'a', serveToken: 's', reason: 'scam', note: 'n', at: 1 },
      { adId: 'b', reason: 'hide', at: 2 },
    ])
  })

  test('0.6.0 batches: campaigns, seats and the kill switch parse; the surface is terminal or desktop', () => {
    const batch = parseBatch(
      JSON.stringify({
        ...BATCH,
        ads: [{ ...BATCH.ads[0], campaignId: 'camp-1' }],
        seat: 'waiting',
        mod: { latest: '0.7.0', min: '0.6.0', blocked: true },
      }),
    )

    expect(batch?.ads[0]?.campaignId).toBe('camp-1')
    expect(batch?.seat).toBe('waiting')
    expect(batch?.mod).toEqual({ latest: '0.7.0', min: '0.6.0', blocked: true })
    expect(parseBatch(JSON.stringify({ ...BATCH, seat: 'vip' }))?.seat).toBeUndefined()
    expect(updateStateOf({ latest: '0.7.0', min: '0.6.0', blocked: true })).toEqual({ kind: 'blocked', latest: '0.7.0' })
    expect(updateStateOf({ latest: MOD_VERSION, min: MOD_VERSION, blocked: true }).kind, 'even when current').toBe('blocked')
    expect([surfaceOf('terminal'), surfaceOf('desktop'), surfaceOf('vscode')]).toEqual(['terminal', 'desktop', 'desktop'])
  })

  test('queued impressions keep their turn token, surface and time on screen when well formed', () => {
    expect(
      queueOf([
        { adId: 'a', format: 'banner', at: 1, turnToken: 'tt', surface: 'desktop', shownMs: 1200 },
        { adId: 'b', format: 'banner', at: 2, turnToken: '', surface: 'tv', shownMs: -1 },
      ]),
    ).toEqual([
      { adId: 'a', format: 'banner', at: 1, turnToken: 'tt', surface: 'desktop', shownMs: 1200 },
      { adId: 'b', format: 'banner', at: 2 },
    ])
  })
})

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
} from '../hooks/core'
import { BATCH } from './world'

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

  test('a server ad may carry video cuts and sound from the ad server, but never local files or other hosts', () => {
    const theater = { id: 't', format: 'theater', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const cut = { frames: ['a', 'b'], fps: 15, width: 9, height: 16, files: ['/etc/passwd'] }
    const server = 'https://tokenbreak.dev'
    const withAudio = (audio: unknown) => parseBatch(JSON.stringify({ ads: [{ ...theater, audio }] }), server)?.ads[0]?.audio
    const ad = parseBatch(
      JSON.stringify({ ads: [{ ...theater, videos: [cut, cut, cut, cut], audio: { url: `${server}/m/s.m4a` } }] }),
      server,
    )?.ads[0]

    expect(ad?.videos).toHaveLength(3)
    expect(ad?.videos?.[0]?.files).toBeUndefined()
    expect(ad?.audio).toEqual({ url: `${server}/m/s.m4a` })
    // An advertiser's own host would see each viewer's IP: a tracking pixel by another name.
    expect(withAudio({ url: 'https://tracker.example/s.m4a' })).toBeUndefined()
    expect(withAudio({ url: 'https://192.168.1.10/s.m4a' })).toBeUndefined()
    expect(withAudio({ asset: 'hooks/register.tsx' })).toBeUndefined()
    // Without a known ad server, no sound at all.
    expect(parseBatch(JSON.stringify({ ads: [{ ...theater, audio: { url: `${server}/m/s.m4a` } }] }))?.ads[0]?.audio).toBeUndefined()
  })

  test('a banner logo is kept only within its tiny budget', () => {
    const banner = { id: 'b', format: 'banner', brand: 'B', headline: 'h', accent: '#FFE600', clickUrl: 'https://a.dev' }
    const logo = (bytes: number) => ({ png: 'A'.repeat(Math.ceil(bytes / 3) * 4), width: 36, height: 36 })
    const parse = (bytes: number) => parseBatch(JSON.stringify({ ads: [{ ...banner, logo: logo(bytes) }] }))?.ads[0]?.logo

    expect(parse(400)).toBeDefined()
    expect(parse(768)).toBeDefined()
    expect(parse(3000)).toBeUndefined()
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

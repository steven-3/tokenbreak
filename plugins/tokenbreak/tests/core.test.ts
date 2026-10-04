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
  STATUS_TEXT,
  statusAdOf,
  statusLine,
  theaterArt,
} from '../hooks/core'
import { BATCH } from './world'

describe('core', () => {
  test('the status line shows a Status Sponsor when the batch has one', () => {
    const sponsor = {
      id: 'status-1',
      format: 'status' as const,
      brand: 'Acme DB',
      headline: 'Postgres that never pages you',
      accent: '#FFE600',
      clickUrl: 'https://example.com',
      isHouse: false,
    }

    expect(statusAdOf([...BATCH.ads, sponsor])?.id).toBe('status-1')
    expect(statusLine(sponsor)).toBe('Ad · Acme DB: Postgres that never pages you')
    expect(statusLine(undefined)).toBe(STATUS_TEXT)
    expect(statusLine({ ...sponsor, headline: 'x'.repeat(120) }).length).toBe(72)
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

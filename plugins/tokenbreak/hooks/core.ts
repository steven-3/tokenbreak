import type { Ad, AdAudio, AdBatch, AdFormat, AdVideo, BannerStyle, Impression } from '../types'

export const THEATER_PANE = 'tokenbreak-theater'
export const QUEUE_CAP = 200
export const FLUSH_AT = 20
export const FLUSH_EVERY_MS = 5 * 60_000
/** Short turns never get a Theater: it opens once a turn has run this long. */
export const THEATER_DELAY_MS = 3_000
/** Below this the engine leaves an unasked pane undrawn, so Tokenbreak never asks. */
export const THEATER_MIN_COLUMNS = 144
/** Closing the Theater by hand keeps it away this long. */
export const THEATER_SNOOZE_MS = 30 * 60_000
export const FORMATS: readonly AdFormat[] = ['banner', 'theater']

export const ROTATION_MS = { chill: 90_000, normal: 40_000, max: 20_000 } as const

export function rotationMs(frequency: unknown): number {
  return ROTATION_MS[frequency as keyof typeof ROTATION_MS] ?? ROTATION_MS.normal
}

/** Shown when the ad server can't be reached: Tokenbreak's own promos, never a third party's. */
export const HOUSE_ADS: readonly Ad[] = [
  {
    id: 'house-rent',
    format: 'banner',
    brand: 'Tokenbreak',
    glyph: '▚',
    headline: 'This space for rent. Buy a break for your brand.',
    accent: '#FFE600',
    clickUrl: 'https://tokenbreak.dev/advertise',
    isHouse: true,
  },
  {
    id: 'house-earn',
    format: 'banner',
    brand: 'Tokenbreak',
    glyph: '◆',
    headline: 'Earn toward your subscription while you wait. Opening soon.',
    accent: '#8C91FF',
    clickUrl: 'https://tokenbreak.dev/earn',
    isHouse: true,
  },
  {
    id: 'house-ui',
    format: 'banner',
    brand: 'Tokenbreak UI',
    glyph: '▣',
    headline: 'Free terminal-style shadcn components. One npx away.',
    accent: '#F1EFE8',
    clickUrl: 'https://tokenbreak.dev/ui',
    isHouse: true,
  },
  {
    id: 'house-theater',
    format: 'theater',
    brand: 'Tokenbreak',
    glyph: '▚',
    headline: 'Your brand here, while Claude works. Founding slots open.',
    accent: '#FFE600',
    clickUrl: 'https://tokenbreak.dev/formats',
    isHouse: true,
  },
]

const HEX = /^#[0-9a-fA-F]{6}$/

/** The most a banner logo's PNG may weigh; a bigger one draws the glyph instead. */
export const LOGO_MAX_BYTES = 768

export const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

/**
 * The href a `Link` may carry, or undefined: https, or http on localhost,
 * printable ASCII with no `@` or space, spelled as `new URL(href).href`.
 */
export function linkable(href: string): string | undefined {
  try {
    const url = new URL(href)
    const isLocal = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')

    if (url.protocol !== 'https:' && !isLocal) {
      return undefined
    }

    const spelled = url.href

    return spelled.length <= 2048 && /^[\x21-\x7e]+$/.test(spelled) && !spelled.includes('@') ? spelled : undefined
  } catch {
    return undefined
  }
}

/**
 * Server text made safe to draw: control characters (which could carry
 * terminal escape sequences) become spaces and bidi overrides are dropped,
 * then the result is cut to `max` characters.
 */
export const plain = (value: string, max: number): string =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, max)

/** A `{ png, width, height }` whose PNG decodes to at most `maxBytes`. */
const isImage = (value: Record<string, unknown> | undefined, maxBytes: number): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof value.png === 'string' &&
  value.png.length <= Math.ceil(maxBytes / 3) * 4 &&
  typeof value.width === 'number' &&
  typeof value.height === 'number'

/** A loop of at most 240 frames and 8 MiB of PNG, its rate held to 1-30 fps; undefined when it isn't one. */
function videoOf(raw: unknown): AdVideo | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }

  const video = raw as Record<string, unknown>
  const frames = video.frames

  if (
    !Array.isArray(frames) ||
    frames.length === 0 ||
    frames.length > 240 ||
    !frames.every(frame => typeof frame === 'string') ||
    frames.reduce((sum: number, frame: string) => sum + frame.length, 0) > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
    typeof video.fps !== 'number' ||
    typeof video.width !== 'number' ||
    typeof video.height !== 'number'
  ) {
    return undefined
  }

  return { frames: frames as string[], fps: Math.min(30, Math.max(1, video.fps)), width: video.width, height: video.height }
}

/**
 * A server ad's sound: a URL on the ad server itself (`mediaOrigin`), never a
 * third party's. The engine fetches it from the person's machine, so any other
 * host would see their IP each time an ad played (a tracking pixel) or could be
 * a host on their local network. A server may not name the plugin's files either.
 */
function audioOf(raw: unknown, mediaOrigin: string | undefined): AdAudio | undefined {
  const url = (raw as { url?: unknown } | undefined)?.url

  if (mediaOrigin === undefined || typeof url !== 'string' || url.length > 2048) {
    return undefined
  }

  try {
    return new URL(url).origin === mediaOrigin ? { url } : undefined
  } catch {
    return undefined
  }
}

const isFormat = (value: unknown): value is AdFormat => value === 'banner' || value === 'theater'

function adOf(raw: unknown, mediaOrigin: string | undefined): Ad | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }

  const ad = raw as Record<string, unknown>
  const image = ad.image as Record<string, unknown> | undefined
  const hasImage = isImage(image, 2 * 1024 * 1024)
  const video = videoOf(ad.video)
  const videos = Array.isArray(ad.videos)
    ? ad.videos.slice(0, 3).flatMap(one => {
        const cut = videoOf(one)

        return cut === undefined ? [] : [cut]
      })
    : []
  const audio = audioOf(ad.audio, mediaOrigin)
  const logo = ad.logo as Record<string, unknown> | undefined
  const hasLogo = isImage(logo, LOGO_MAX_BYTES)

  if (
    typeof ad.id !== 'string' ||
    !isFormat(ad.format) ||
    typeof ad.brand !== 'string' ||
    typeof ad.headline !== 'string' ||
    typeof ad.clickUrl !== 'string'
  ) {
    return undefined
  }

  return {
    id: plain(ad.id, 64),
    format: ad.format,
    brand: plain(ad.brand, 24),
    ...(typeof ad.glyph === 'string' && ad.glyph.length > 0 && { glyph: plain(ad.glyph, 2) }),
    headline: plain(ad.headline, 80),
    ...(typeof ad.cta === 'string' && ad.cta.trim().length > 0 && { cta: plain(ad.cta.trim(), 24) }),
    accent: isHex(ad.accent) ? ad.accent : '#FFE600',
    clickUrl: ad.clickUrl,
    ...(hasImage && {
      image: { png: image.png as string, width: image.width as number, height: image.height as number },
    }),
    ...(video !== undefined && { video }),
    ...(videos.length > 0 && { videos }),
    ...(audio !== undefined && { audio }),
    ...(hasLogo && { logo: { png: logo.png as string, width: logo.width as number, height: logo.height as number } }),
    isHouse: ad.isHouse === true,
  }
}

/**
 * An `AdBatch` from the API's JSON, its malformed ads dropped; undefined when it
 * isn't one. Ad sound is kept only when it's served from `mediaOrigin`, the ad
 * server's own origin; without one, no sound is kept.
 */
export function parseBatch(text: string, mediaOrigin?: string): AdBatch | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>

    if (!Array.isArray(raw.ads)) {
      return undefined
    }

    const ads = raw.ads.map(one => adOf(one, mediaOrigin)).filter((ad): ad is Ad => ad !== undefined)
    const ttl = typeof raw.ttlSeconds === 'number' && raw.ttlSeconds > 0 ? raw.ttlSeconds : 600

    return { ads, ttlSeconds: Math.min(ttl, 24 * 3600), servedAt: typeof raw.servedAt === 'string' ? raw.servedAt : '' }
  } catch {
    return undefined
  }
}

/** The batch as it may sit in `$.store` (4 MiB in all): images dropped once it gets big. */
export function cacheable(batch: AdBatch): AdBatch {
  return JSON.stringify(batch).length <= 1_500_000
    ? batch
    : { ...batch, ads: batch.ads.map(({ image: _image, video: _video, ...ad }) => ad) }
}

export const bannersOf = (ads: readonly Ad[]) => ads.filter(ad => ad.format === 'banner')

/**
 * The ads as `$.state` holds them: each video's frames left out, its size and
 * rate kept. A session's state takes 4 MiB of JSON; one video's frames can fill that.
 */
export const withoutFrames = (ads: readonly Ad[]): Ad[] =>
  ads.map(ad => ({
    ...ad,
    ...(ad.video !== undefined && { video: { ...ad.video, frames: [] } }),
    ...(ad.videos !== undefined && { videos: ad.videos.map(cut => ({ ...cut, frames: [] })) }),
  }))

/** Every cut of an ad's video: `videos` first, then `video`. */
export const cutsOf = (ad: Ad): AdVideo[] => [...(ad.videos ?? []), ...(ad.video === undefined ? [] : [ad.video])]

/** A terminal cell is about twice as tall as it is wide. */
export const CELL_ASPECT = 2

/** Rows the Theater card takes under a picture, and columns beside one. */
export const CARD_ROWS = 9
export const CARD_COLUMNS = 36

export type TheaterLayout = {
  /** `stack`: picture above the card; `side`: picture left of it. */
  mode: 'stack' | 'side'
  /** Which of the shapes it shows. */
  shape: number
  columns: number
  rows: number
}

/**
 * The layout that shows the biggest picture in a `columns` × `rows` pane: every
 * shape, stacked over the card or beside it, fitted without distortion.
 */
export function theaterLayout(
  columns: number,
  rows: number,
  shapes: readonly { width: number; height: number }[],
): TheaterLayout {
  const fit = (mode: TheaterLayout['mode'], shape: number, roomColumns: number, roomRows: number): TheaterLayout => {
    const { width, height } = shapes[shape] ?? { width: 16, height: 9 }
    // Cells across per cell down that keep the picture's own proportions.
    const ratio = (width / height) * CELL_ASPECT
    const across = Math.max(1, Math.min(255, roomColumns, Math.floor(Math.max(1, roomRows) * ratio)))

    return { mode, shape, columns: across, rows: Math.max(1, Math.min(255, Math.round(across / ratio))) }
  }
  const options = (shapes.length === 0 ? [0] : shapes.map((_, at) => at)).flatMap(shape => [
    fit('stack', shape, columns, rows - CARD_ROWS),
    ...(columns - CARD_COLUMNS >= 20 ? [fit('side', shape, columns - CARD_COLUMNS - 2, rows - 1)] : []),
  ])

  return options.reduce((best, one) => (one.columns * one.rows > best.columns * best.rows ? one : best))
}

/** The frame a video shows before it plays: three quarters in, past any fade-in. */
export const posterOf = (frameCount: number) => Math.floor(frameCount * 0.75)

export const BANNER_STYLES = ['pill', 'rule', 'card'] as const

export const bannerStyleOf = (value: unknown): BannerStyle =>
  BANNER_STYLES.includes(value as BannerStyle) ? (value as BannerStyle) : 'pill'

/** `hex` mixed into `base` by `amount` (0 to 1): a dark tint of a brand color for a button's ground. */
export function tint(hex: string, amount: number, base = '#141414'): string {
  const channel = (color: string, at: number) => parseInt(color.slice(at, at + 2), 16)

  return `#${[1, 3, 5]
    .map(at => Math.round(channel(base, at) + (channel(hex, at) - channel(base, at)) * amount))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`
}

/** Ink that reads on `hex`: near-black on light colors, white on dark ones. */
export function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * linear(r ?? 0) + 0.7152 * linear(g ?? 0) + 0.0722 * linear(b ?? 0)

  return luminance > 0.4 ? '#141414' : '#FFFFFF'
}

/** The Theater ad: the banner brand's own when it has one, so one brand holds both slots; else the batch's first. */
export const theaterOf = (ads: readonly Ad[], banner?: Ad): Ad =>
  ads.find(ad => ad.format === 'theater' && ad.brand === banner?.brand) ??
  ads.find(ad => ad.format === 'theater') ??
  (HOUSE_ADS.find(ad => ad.format === 'theater') as Ad)

export function currentBanner(ads: readonly Ad[], index: number): Ad | undefined {
  const banners = bannersOf(ads)

  return banners.length === 0 ? undefined : banners[((index % banners.length) + banners.length) % banners.length]
}

/** The newest `cap` impressions. */
export const capQueue = (queue: readonly Impression[], cap = QUEUE_CAP): Impression[] =>
  queue.length <= cap ? [...queue] : queue.slice(queue.length - cap)

export const impressionKey = (impression: Impression) =>
  `${impression.adId}|${impression.format}|${impression.at}|${impression.turnId ?? ''}`

export function queueOf(raw: unknown): Impression[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.filter(
    (item): item is Impression =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Impression).adId === 'string' &&
      isFormat((item as Impression).format) &&
      typeof (item as Impression).at === 'number',
  )
}

/** What the band saw of the surface the last time it drew. */
export type Seen = {
  columns: number
  rows: number
  isFullscreen?: boolean
  maxRows: number
}

/**
 * Whether a pane opened unasked would dock beside the transcript: the
 * fullscreen layout at 144 columns or more. A build that doesn't say
 * `isFullscreen` docks when the band's slot is shorter than the screen.
 */
export function canDockTheater(seen: Seen | undefined): boolean {
  if (seen === undefined || seen.columns < THEATER_MIN_COLUMNS) {
    return false
  }

  return seen.isFullscreen === true || (seen.isFullscreen === undefined && seen.maxRows < seen.rows)
}

/** When a pause asked for with `arg` ends: `1h` (the default), `30m`, `2h`, or `today` (local midnight). */
export function pauseUntil(arg: string, now: number): number | undefined {
  const spoken = arg.trim().toLowerCase()

  if (spoken === '' || spoken === '1h') {
    return now + 3_600_000
  }

  if (spoken === 'today') {
    const midnight = new Date(now)

    midnight.setHours(24, 0, 0, 0)

    return midnight.getTime()
  }

  const match = /^(\d{1,3})\s*(m|min|h|hr)$/.exec(spoken)

  if (match === null) {
    return undefined
  }

  const amount = Number(match[1])
  const ms = match[2]?.startsWith('h') ? amount * 3_600_000 : amount * 60_000

  return amount > 0 ? now + Math.min(ms, 7 * 24 * 3_600_000) : undefined
}

export function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`
}

// The Theater's built-in picture: a yellow "THIS SPACE FOR RENT" slot on
// Klein blue with crop marks, drawn as pixel art and scaled up 4x so the
// terminal's scaling keeps it crisp.

const GLYPHS: Record<string, readonly string[]> = {
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  K: ['101', '101', '110', '101', '101'],
  N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  ' ': ['000', '000', '000', '000', '000'],
}

type Rgb = readonly [number, number, number]

const COBALT: Rgb = [26, 31, 208]
const YELLOW: Rgb = [255, 230, 0]
const CHARCOAL: Rgb = [20, 20, 20]
const CREAM: Rgb = [241, 239, 232]

const ART_W = 64
const ART_H = 36
const SCALE = 4

let art: { rgba: string; width: number; height: number } | undefined

function toBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/** The fallback Theater picture as RGBA bytes (base64), built once. */
export function theaterArt(): { rgba: string; width: number; height: number } {
  if (art !== undefined) {
    return art
  }

  const grid: Rgb[] = Array.from({ length: ART_W * ART_H }, () => COBALT)
  const put = (x: number, y: number, color: Rgb) => {
    if (x >= 0 && x < ART_W && y >= 0 && y < ART_H) {
      grid[y * ART_W + x] = color
    }
  }
  const text = (word: string, y: number, color: Rgb) => {
    const x0 = Math.floor((ART_W - (word.length * 4 - 1)) / 2)

    ;[...word].forEach((char, i) => {
      ;(GLYPHS[char] ?? GLYPHS[' '])?.forEach((row, dy) => {
        ;[...row].forEach((bit, dx) => bit === '1' && put(x0 + i * 4 + dx, y + dy, color))
      })
    })
  }

  // The slot, with a dashed charcoal edge.
  for (let y = 4; y <= 23; y += 1) {
    for (let x = 6; x <= 57; x += 1) {
      const isEdge = x === 6 || x === 57 || y === 4 || y === 23

      put(x, y, isEdge && (x + y) % 3 !== 0 ? CHARCOAL : YELLOW)
    }
  }

  // Crop marks at the slot's corners.
  for (const [cx, cy, sx, sy] of [
    [6, 4, -1, -1],
    [57, 4, 1, -1],
    [6, 23, -1, 1],
    [57, 23, 1, 1],
  ] as const) {
    for (let d = 2; d <= 4; d += 1) {
      put(cx + sx * d, cy, CREAM)
      put(cx, cy + sy * d, CREAM)
    }
  }

  text('THIS SPACE', 8, CHARCOAL)
  text('FOR RENT', 15, CHARCOAL)
  text('TOKENBREAK', 28, CREAM)

  const width = ART_W * SCALE
  const height = ART_H * SCALE
  const bytes = new Uint8Array(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = grid[Math.floor(y / SCALE) * ART_W + Math.floor(x / SCALE)] ?? COBALT
      const at = (y * width + x) * 4

      bytes[at] = r
      bytes[at + 1] = g
      bytes[at + 2] = b
      bytes[at + 3] = 255
    }
  }

  art = { rgba: toBase64(bytes), width, height }

  return art
}

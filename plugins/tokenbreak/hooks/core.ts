import type {
  Ad,
  AdBatch,
  AdFormat,
  AdReport,
  AdReportReason,
  AdSurface,
  AdVideo,
  BannerStyle,
  Impression,
  ModRelease,
  Seat,
  TurnGrant,
  UpdateState,
} from '../types'

/**
 * This build's version. A hooks module can't read its own plugin.json without
 * reading a file, so it's written here too; tools/sync-public-mod.sh refuses to
 * publish unless it equals plugin.json's and the server's MOD_LATEST_VERSION.
 */
export const MOD_VERSION = '0.6.0'

/** What every ad says it is, in the banner and the Theater. Short on purpose: terminal columns go to the headline. */
export const AD_LABEL = 'Ad'

/**
 * The headers `GET /api/v1/ads` and `POST /api/v1/turns` carry besides the
 * session token: this install's random device id, the mod's version, and where
 * ads are drawn (`terminal` or `desktop`), so the server can sign each serve for
 * this device. Nothing else about the person.
 */
export const MOD_HEADERS = {
  device: 'X-Tokenbreak-Device',
  version: 'X-Tokenbreak-Version',
  surface: 'X-Tokenbreak-Surface',
} as const

/**
 * How long an ad must stay on screen, continuously, for the turn's end to report
 * it: the MRC display standard's one second for the banner, two for the Theater.
 */
export const MIN_SHOWN_MS = { banner: 1_000, theater: 2_000 } as const satisfies Record<AdFormat, number>

/** Impressions older than this earn nothing, so the mod drops them rather than send them. */
export const IMPRESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The banner shows while a turn runs and this long after it ends, then hides until the next turn. */
export const BANNER_LINGER_MS = 30_000

/** Narrower terminals than this get no banner at all. */
export const BANNER_MIN_COLUMNS = 80

/** `✕` hides that campaign on this machine for this many days. */
export const HIDE_CAMPAIGN_DAYS = 30
export const HIDE_CAMPAIGN_MS = HIDE_CAMPAIGN_DAYS * 24 * 60 * 60 * 1000

/** `POST /api/v1/turns` never holds a turn up: an answer later than this is ignored. */
export const TURN_TIMEOUT_MS = 3_000

/** The server grants no token to turns closer together than this on one device, so the mod doesn't ask. */
export const TURN_MIN_GAP_MS = 10_000

/** Reasons `/ads report` takes; `hide` is the `✕` button's own. */
export const REPORT_REASONS = ['scam', 'misleading', 'offensive', 'broken', 'other'] as const satisfies readonly AdReportReason[]
export const REPORT_NOTE_MAX = 280
/** Reports wait here while the server can't be reached; the oldest give way past this. */
export const REPORT_QUEUE_CAP = 50

/** `terminal`, or `desktop` for every surface that isn't one (the desktop app's Code tab). */
export const surfaceOf = (surface: unknown): AdSurface => (surface === 'terminal' ? 'terminal' : 'desktop')

/** The longest serve token the mod keeps; a longer or empty one is dropped and the ad shows without it. */
export const SERVE_TOKEN_MAX = 512

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
    headline: 'Earn USDC while Claude thinks. Half of every paid ad.',
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

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n'

/**
 * Whether `base64` is a PNG the terminal takes: standard padded base64 that
 * opens with the PNG signature and an IHDR of 1 to 4096 pixels a side. The
 * engine refuses a whole drawing over one picture that isn't.
 */
export function isPng(base64: string): boolean {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return false
  }

  // The signature, the IHDR chunk's length and name, then its width and height: 24 bytes.
  const head = atob(base64.slice(0, 32))
  const side = (at: number) =>
    ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0

  return (
    head.length === 24 &&
    head.startsWith(PNG_SIGNATURE) &&
    head.slice(12, 16) === 'IHDR' &&
    [side(16), side(20)].every(px => px >= 1 && px <= 4096)
  )
}

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

const VERSION = /^\d+\.\d+\.\d+$/

/** `a` compared with `b`, part by part: negative when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map(version => version.split('.').map(part => Number.parseInt(part, 10) || 0))

  for (let at = 0; at < 3; at++) {
    const diff = (x?.[at] ?? 0) - (y?.[at] ?? 0)

    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

/** The server's release info, when it sent a well-formed one. */
function releaseOf(raw: unknown): ModRelease | undefined {
  const mod = raw as { latest?: unknown; min?: unknown; blocked?: unknown } | undefined

  return typeof mod?.latest === 'string' && typeof mod.min === 'string' && VERSION.test(mod.latest) && VERSION.test(mod.min)
    ? { latest: mod.latest, min: mod.min, ...(mod.blocked === true && { blocked: true }) }
    : undefined
}

/**
 * Where `version` stands against the server's releases; current when the server
 * didn't say. A build the server switched off is `blocked` whatever its number.
 */
export function updateStateOf(release: ModRelease | undefined, version = MOD_VERSION): UpdateState {
  if (release?.blocked === true) {
    return { kind: 'blocked', latest: release.latest }
  }

  if (release === undefined || compareVersions(version, release.latest) >= 0) {
    return { kind: 'current' }
  }

  return compareVersions(version, release.min) < 0
    ? { kind: 'required', latest: release.latest }
    : { kind: 'available', latest: release.latest }
}

/**
 * How to turn on auto-update for the tokenbreak marketplace, as Claude Code's
 * docs give it (code.claude.com/docs/en/plugins/host-marketplace, "Turn on
 * auto-update"): it's off for every marketplace outside Anthropic's own.
 */
export const AUTO_UPDATE_STEPS = 'Get updates automatically: /plugin → Marketplaces → tokenbreak → Enable auto-update.'

/** What `/ads update` prints: how to update now, and how never to fall behind again. */
export const UPDATE_STEPS = [
  'Update Tokenbreak:',
  '  /plugin marketplace update tokenbreak',
  '  /plugin update tokenbreak@tokenbreak',
  '  /reload-plugins',
  AUTO_UPDATE_STEPS,
].join('\n')

const isFormat = (value: unknown): value is AdFormat => value === 'banner' || value === 'theater'

export const isServeToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= SERVE_TOKEN_MAX

function adOf(raw: unknown): Ad | undefined {
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
  const logo = ad.logo as Record<string, unknown> | undefined
  // A logo the terminal wouldn't take is dropped for the glyph: the engine would refuse
  // the whole band over it, and the turn would still count the banner it never showed.
  const hasLogo = isImage(logo, LOGO_MAX_BYTES) && isPng(logo.png as string)

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
    ...(hasLogo && { logo: { png: logo.png as string, width: logo.width as number, height: logo.height as number } }),
    isHouse: ad.isHouse === true,
    ...(typeof ad.campaignId === 'string' && ad.campaignId.length > 0 && { campaignId: plain(ad.campaignId, 64) }),
    ...(isServeToken(ad.serveToken) && { serveToken: ad.serveToken }),
  }
}

/**
 * An `AdBatch` from the API's JSON, its malformed ads dropped; undefined when it
 * isn't one. Ads never carry sound: the Theater is silent (FMT-03).
 */
export function parseBatch(text: string): AdBatch | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>

    if (!Array.isArray(raw.ads)) {
      return undefined
    }

    const ads = raw.ads.map(one => adOf(one)).filter((ad): ad is Ad => ad !== undefined)
    const ttl = typeof raw.ttlSeconds === 'number' && raw.ttlSeconds > 0 ? raw.ttlSeconds : 600

    const mod = releaseOf(raw.mod)
    const seat = raw.seat === 'earning' || raw.seat === 'waiting' ? (raw.seat as Seat) : undefined

    return {
      ads,
      ttlSeconds: Math.min(ttl, 24 * 3600),
      servedAt: typeof raw.servedAt === 'string' ? raw.servedAt : '',
      ...(mod !== undefined && { mod }),
      ...(seat !== undefined && { seat }),
    }
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

/** What `✕` hides: the ad's campaign, or the ad itself when the server names none. */
export const hideKeyOf = (ad: Ad): string => ad.campaignId ?? ad.id

/** The hides still in force at `now`, expired ones dropped; malformed ones too. */
export function activeHides(raw: unknown, now: number): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > now,
    ),
  )
}

const isHiddenAt = (ad: Ad, hidden: Readonly<Record<string, number>>, now: number) => (hidden[hideKeyOf(ad)] ?? 0) > now

/**
 * The ads rotation draws from: hidden campaigns skipped, and only house ads while
 * the account waits for an earning seat. When that leaves no banner, the built-in
 * house banners that aren't hidden stand in.
 */
export function rotationOf(
  ads: readonly Ad[],
  hidden: Readonly<Record<string, number>>,
  now: number,
  seat: Seat | null = null,
): Ad[] {
  const shown = ads.filter(ad => !isHiddenAt(ad, hidden, now) && (seat !== 'waiting' || ad.isHouse))

  return bannersOf(shown).length > 0
    ? shown
    : [...shown, ...HOUSE_ADS.filter(ad => ad.format === 'banner' && !isHiddenAt(ad, hidden, now))]
}

/** The server's turn grant from its JSON; undefined when it isn't one. */
export function parseGrant(text: string): TurnGrant | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>

    return typeof raw.turnId === 'string' &&
      raw.turnId.length <= 64 &&
      typeof raw.turnToken === 'string' &&
      raw.turnToken.length > 0 &&
      raw.turnToken.length <= 512 &&
      typeof raw.issuedAt === 'number' &&
      Number.isFinite(raw.issuedAt)
      ? { turnId: raw.turnId, turnToken: raw.turnToken, issuedAt: raw.issuedAt }
      : undefined
  } catch {
    return undefined
  }
}

/** One ad's stretch on screen that hasn't ended yet. */
export type Stretch = Pick<Impression, 'adId' | 'serveToken'> & { isHouse: boolean; since: number }

/** The longest stretch an ad was on screen this turn. */
export type Shown = Pick<Impression, 'adId' | 'serveToken'> & { isHouse: boolean; ms: number }

/**
 * What the mod knows of a format's time on screen this turn: the stretch running
 * now, and each ad's longest finished one. It only counts between the turn's
 * start and its end (`isCounting`); the banner's linger after the turn is never counted.
 */
export type ShownTracker = { isCounting: boolean; current?: Stretch; best: Record<string, Shown> }

export const trackerOf = (isCounting = false): ShownTracker => ({ isCounting, best: {} })

/** Ends the running stretch at `now`, keeping it if it's that ad's longest. */
export function endStretch(tracker: ShownTracker, now: number): ShownTracker {
  const { current } = tracker

  if (current === undefined) {
    return tracker
  }

  const ms = Math.max(0, now - current.since)
  const kept = tracker.best[current.adId]
  const best =
    tracker.isCounting && (kept === undefined || ms > kept.ms)
      ? {
          ...tracker.best,
          [current.adId]: {
            adId: current.adId,
            ...(current.serveToken !== undefined && { serveToken: current.serveToken }),
            isHouse: current.isHouse,
            ms,
          },
        }
      : tracker.best

  return { isCounting: tracker.isCounting, best }
}

/**
 * The tracker after the mod drew `ad` (or nothing) at `now`: the same ad drawn
 * again continues its stretch; any other change ends it and starts the next.
 * Drawn means the mod handed the engine that tree: it can't see past that (a
 * collapsed band, a window behind another), so a stretch runs from one draw to
 * the next one that changes what shows.
 */
export function noteDrawn(tracker: ShownTracker, ad: Ad | undefined, now: number): ShownTracker {
  const { current } = tracker

  // A refreshed batch can hand the same ad a new serve token: the stretch goes on, under the newest one.
  if (ad !== undefined && current?.adId === ad.id) {
    const { serveToken: _old, ...rest } = current

    return { ...tracker, current: { ...rest, ...(ad.serveToken !== undefined && { serveToken: ad.serveToken }) } }
  }

  const ended = endStretch(tracker, now)

  return ad === undefined
    ? ended
    : { ...ended, current: { ...shownOf(ad), isHouse: ad.isHouse, since: now } }
}

/** The paid ad shown longest this turn, if it stayed at least `minMs`; house ads never count. */
export function longestPaid(tracker: ShownTracker, minMs: number): Shown | undefined {
  return Object.values(tracker.best)
    .filter(one => !one.isHouse && one.ms >= minMs)
    .reduce<Shown | undefined>((best, one) => (best === undefined || one.ms > best.ms ? one : best), undefined)
}

/** The queue without impressions too old to earn: the server would credit nothing from them. */
export const freshOf = (queue: readonly Impression[], now: number): Impression[] =>
  queue.filter(impression => now - impression.at <= IMPRESSION_MAX_AGE_MS)

/** A report waiting to be sent, with when it was made. */
export type QueuedReport = AdReport & { at: number }

const isReason = (value: unknown): value is AdReportReason =>
  value === 'hide' || (REPORT_REASONS as readonly unknown[]).includes(value)

/** The report queue as the store holds it, malformed entries dropped. */
export function reportQueueOf(raw: unknown): QueuedReport[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((item: unknown) => {
    const one = item as Partial<QueuedReport> | null

    return typeof one === 'object' &&
      one !== null &&
      typeof one.adId === 'string' &&
      one.adId.length > 0 &&
      isReason(one.reason) &&
      typeof one.at === 'number'
      ? [
          {
            adId: one.adId,
            ...(isServeToken(one.serveToken) && { serveToken: one.serveToken }),
            reason: one.reason,
            ...(typeof one.note === 'string' && one.note.length > 0 && { note: plain(one.note, REPORT_NOTE_MAX) }),
            at: one.at,
          },
        ]
      : []
  })
}

/** `/ads report [reason] [note]`: the reason word (`other` when absent or unknown) and the rest as the note. */
export function reportArgsOf(words: readonly string[]): { reason: Exclude<AdReportReason, 'hide'>; note?: string } {
  const [first = '', ...rest] = words
  const spoken = first.toLowerCase()
  const isNamed = (REPORT_REASONS as readonly string[]).includes(spoken)
  const note = plain((isNamed ? rest : words).join(' ').trim(), REPORT_NOTE_MAX).trim()

  return {
    reason: isNamed ? (spoken as Exclude<AdReportReason, 'hide'>) : 'other',
    ...(note.length > 0 && { note }),
  }
}

/** The welcome card the first sign-in shows once: Tokenbreak's own, never counted. */
export const WELCOME_LINES = [
  '✕ on an ad hides that advertiser for 30 days.',
  '/ads pause stops ads (1h, 30m, 2h or today); /ads resume brings them back.',
  'Your earnings: tokenbreak.dev/dashboard/earn',
  'Turn on updates: /plugin → Marketplaces → tokenbreak → Enable auto-update.',
] as const

export const EARNINGS_URL = 'https://tokenbreak.dev/dashboard/earn'

/** The line under the banner while the account waits for an earning seat. */
export const WAITING_NOTICE = "You're on the list for an earning seat. Ads you see now don't pay yet."

/** The newest `cap` impressions. */
export const capQueue = (queue: readonly Impression[], cap = QUEUE_CAP): Impression[] =>
  queue.length <= cap ? [...queue] : queue.slice(queue.length - cap)

/**
 * What an impression takes from the ad on screen: its id, and its own serve
 * token when it has one, so a token only ever travels with the ad it was served for.
 */
export const shownOf = (ad: Ad): Pick<Impression, 'adId' | 'serveToken'> => ({
  adId: ad.id,
  ...(ad.serveToken !== undefined && { serveToken: ad.serveToken }),
})

export const impressionKey = (impression: Impression) =>
  `${impression.adId}|${impression.format}|${impression.at}|${impression.turnId ?? ''}`

/**
 * The queue as the store holds it, malformed impressions dropped. A malformed
 * serve token is left off rather than sent: the server would refuse the batch.
 */
export function queueOf(raw: unknown): Impression[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .filter(
      (item): item is Impression =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Impression).adId === 'string' &&
        isFormat((item as Impression).format) &&
        typeof (item as Impression).at === 'number',
    )
    .map(({ serveToken, turnToken, surface, shownMs, ...impression }) => ({
      ...impression,
      ...(isServeToken(serveToken) && { serveToken }),
      ...(isServeToken(turnToken) && { turnToken }),
      ...((surface === 'terminal' || surface === 'desktop') && { surface }),
      ...(typeof shownMs === 'number' && Number.isInteger(shownMs) && shownMs >= 0 && { shownMs }),
    }))
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

/** The client id `/ads login` sends; the site's device flow accepts no other. */
export const MOD_CLIENT_ID = 'tokenbreak-mod'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** `ABCDEFGH` as `ABCD-EFGH`, easier to compare by eye; the site ignores the dash. */
export const formatUserCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

/** What the site answered `/ads login` with (RFC 8628's device authorization response). */
export type DeviceCode = {
  deviceCode: string
  userCode: string
  /** Where to approve, with the code filled in when the site gives one. */
  url: string
  intervalMs: number
  expiresInMs: number
}

export function parseDeviceCode(text: string): DeviceCode | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const url = typeof raw.verification_uri_complete === 'string' ? raw.verification_uri_complete : raw.verification_uri

    if (typeof raw.device_code !== 'string' || typeof raw.user_code !== 'string' || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return undefined
    }

    return {
      deviceCode: raw.device_code,
      userCode: raw.user_code,
      url,
      intervalMs: Math.max(1, Number(raw.interval) || 5) * 1000,
      expiresInMs: Math.max(60, Number(raw.expires_in) || 900) * 1000,
    }
  } catch {
    return undefined
  }
}

/** One poll of the token endpoint: signed in, keep waiting (slower when asked), or give up. */
export type DevicePoll =
  | { kind: 'token'; token: string }
  | { kind: 'wait'; slower: boolean }
  | { kind: 'stop'; reason: 'denied' | 'expired' | 'failed' }

export function parseDevicePoll(status: number, text: string): DevicePoll {
  let raw: Record<string, unknown> = {}

  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    // A proxy's error page: keep waiting below.
  }

  if (status === 200 && typeof raw.access_token === 'string' && raw.access_token.length > 0) {
    return { kind: 'token', token: raw.access_token }
  }

  switch (raw.error) {
    case 'authorization_pending':
      return { kind: 'wait', slower: false }
    case 'slow_down':
      return { kind: 'wait', slower: true }
    case 'access_denied':
      return { kind: 'stop', reason: 'denied' }
    case 'expired_token':
      return { kind: 'stop', reason: 'expired' }
    case 'invalid_grant':
    case 'invalid_request':
      return { kind: 'stop', reason: 'failed' }
    default:
      // A 5xx or a dropped connection: try again on the next tick until the code expires.
      return { kind: 'wait', slower: false }
  }
}

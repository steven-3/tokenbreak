import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, PluginOptions, Register, Timer } from 'claude-code'

import type { Ad, AdSource, AdVideo, BannerStyle, Impression, TheaterShowing } from '../types'
import {
  BANNER_STYLES,
  bannerStyleOf,
  cacheable,
  canDockTheater,
  capQueue,
  currentBanner,
  cutsOf,
  describeWait,
  FLUSH_AT,
  FLUSH_EVERY_MS,
  FORMATS,
  HOUSE_ADS,
  impressionKey,
  isHex,
  tint,
  linkable,
  posterOf,
  parseBatch,
  pauseUntil,
  queueOf,
  rotationMs,
  THEATER_DELAY_MS,
  THEATER_MIN_COLUMNS,
  THEATER_PANE,
  THEATER_SNOOZE_MS,
  theaterArt,
  theaterLayout,
  theaterOf,
  withoutFrames,
  type Seen,
} from './core'

// Privacy rule: Tokenbreak never hooks prompt.compose, session.append,
// tool.call or anything else that reads or shapes the conversation. Of
// turn.start and turn.complete it reads the turn's id and nothing else.
// tests/privacy.test.ts holds it to that.

const ads = atom({ plugin: 'tokenbreak', key: 'ads' } as const, [] as Ad[])
const source = atom({ plugin: 'tokenbreak', key: 'source' } as const, 'built-in' as AdSource)
const bannerIndex = atom({ plugin: 'tokenbreak', key: 'bannerIndex' } as const, 0)
const pausedUntil = atom({ plugin: 'tokenbreak', key: 'pausedUntil' } as const, null as number | null)
const theater = atom({ plugin: 'tokenbreak', key: 'theater' } as const, null as TheaterShowing | null)
const bannerStyle = atom({ plugin: 'tokenbreak', key: 'bannerStyle' } as const, 'pill' as BannerStyle)
const theaterSound = atom({ plugin: 'tokenbreak', key: 'theaterSound' } as const, false)

const FALLBACK_ACCENT = '#FFE600'

/** The module's own bookkeeping, set afresh by `register`: a reload starts it over. */
type Run = {
  endpoint: string
  isTheaterOn: boolean
  /** Whether ads draw pictures (banner logos, Theater images and video): the `pictures` option. */
  arePicturesOn: boolean
  /** Whether a video ad's sound plays when the Theater opens: the `sound` option. */
  isSoundOnByDefault: boolean
  rotationMs: number
  deviceId: string
  fetchedAt: number
  ttlMs: number
  isRefreshing: boolean
  isFlushing: boolean
  runningTurn?: string
  theaterTimer?: Timer
  resumeTimer?: Timer
  theaterSnoozedUntil: number
  /** What the band saw of the surface when it last drew. */
  seen?: Seen
  /** The banner the band last drew, undefined while it shows nothing. */
  drawnBanner?: string
  /** Why the Theater last opened or stayed shut, for `/ads status`. */
  theaterNote: string
  /** Each video cut's frames by `frameKey`; `$.state` holds the ads without them. */
  frames: Map<string, readonly string[]>
  /** The cut the Theater drew last, which playback steps through. */
  drawnCut?: { adId: string; index: number }
  /** The frame on screen; -1 restarts the loop on the next tick. */
  frame?: number
  /** Stops the Theater's sound; set while it plays. */
  sound?: AbortController
  /** Plays the Theater's video while the pane is open. */
  videoTimer?: Timer
  /** The last video's frame swaps, for `/ads status`. */
  video: { swapped: number; refused: number; reason?: string }
  timers: Timer[]
}

function runOf(options: PluginOptions): Run {
  return {
    endpoint: String(options.endpoint ?? 'https://tokenbreak.dev').replace(/\/+$/, ''),
    isTheaterOn: options.theater !== 'off',
    arePicturesOn: options.pictures !== 'off',
    isSoundOnByDefault: options.sound !== 'off',
    rotationMs: rotationMs(options.frequency),
    deviceId: '',
    fetchedAt: 0,
    ttlMs: 600_000,
    isRefreshing: false,
    isFlushing: false,
    theaterSnoozedUntil: 0,
    theaterNote: 'no turn has run long enough yet',
    video: { swapped: 0, refused: 0 },
    frames: new Map(),
    timers: [],
  }
}

let run: Run = runOf({})

/** The status line stays empty; an older build may have left a line there. */
/** Puts `list` on screen: frames into module memory, the rest into `$.state`. */
async function showAds($: EngineInterface, list: readonly Ad[]) {
  run.frames = new Map(
    list.flatMap(ad =>
      cutsOf(ad).flatMap((cut, at) => (cut.frames.length === 0 ? [] : [[frameKey(ad.id, at), cut.frames] as const])),
    ),
  )
  await update($, ads, () => withoutFrames(list))
}

/** The ad server's origin, the only host ad sound may come from. */
function originOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).origin
  } catch {
    return undefined
  }
}

const frameKey = (adId: string, cut: number) => `${adId}#${cut}`

/** How many frames a cut has: files the terminal reads, or PNGs held in memory. */
const lengthOf = (ad: Ad, cut: number) =>
  cutsOf(ad)[cut]?.files?.length ?? run.frames.get(frameKey(ad.id, cut))?.length ?? 0

/** One frame of a cut as an Image source, undefined when the cut has none. */
function frameSource(ad: Ad, cut: number, frame: number): ImageSource | undefined {
  const file = cutsOf(ad)[cut]?.files?.[frame]

  if (file !== undefined) {
    return { file, format: 'png' }
  }

  const png = run.frames.get(frameKey(ad.id, cut))?.[frame]

  return png === undefined ? undefined : { png }
}

const hasVideo = (ad: Ad) => cutsOf(ad).some((_, at) => lengthOf(ad, at) > 0)

async function showStatus($: EngineInterface) {
  $.ui.status(undefined)
}

async function setPause($: EngineInterface, until: number | null) {
  run.resumeTimer?.cancel()
  run.resumeTimer = undefined
  await update($, pausedUntil, () => until)

  if (until === null) {
    await $.store.delete('pausedUntil')
  } else {
    await $.store.set('pausedUntil', until)
    run.resumeTimer = $.clock.after(Math.max(0, until - (await $.clock.now())), () => void setPause($, null))
  }

  await showStatus($)
}

async function hideFor($: EngineInterface, ms: number) {
  await setPause($, (await $.clock.now()) + ms)
}

async function refresh($: EngineInterface) {
  if (run.isRefreshing) {
    return
  }

  run.isRefreshing = true

  try {
    const response = await $.http.fetch(`${run.endpoint}/api/v1/ads?formats=${FORMATS.join(',')}`, {
      headers: { accept: 'application/json' },
    })
    const batch = response.ok ? parseBatch(response.text, originOf(run.endpoint)) : undefined

    if (batch !== undefined && batch.ads.length > 0) {
      run.fetchedAt = await $.clock.now()
      run.ttlMs = batch.ttlSeconds * 1000
      await showAds($, batch.ads)
      await update($, source, () => 'server' as AdSource)
      await $.store.set('batch', cacheable(batch))
      await showStatus($)
    }
  } catch {
    // Unreachable or refused: keep what is showing, house ads at worst.
  } finally {
    run.isRefreshing = false
  }
}

async function flush($: EngineInterface) {
  if (run.isFlushing) {
    return
  }

  run.isFlushing = true

  try {
    const queued = queueOf(await $.store.get('queue'))

    if (queued.length === 0) {
      return
    }

    const sent = queued.slice(0, 200)
    const response = await $.http.fetch(`${run.endpoint}/api/v1/impressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: run.deviceId, impressions: sent }),
    })

    if (!response.ok) {
      return
    }

    const keys = new Set(sent.map(impressionKey))
    const left = queueOf(await $.store.get('queue')).filter(impression => !keys.has(impressionKey(impression)))

    await $.store.set('queue', left)
  } catch {
    // The queue stays for the next try.
  } finally {
    run.isFlushing = false
  }
}

async function enqueue($: EngineInterface, impressions: readonly Impression[]) {
  if (impressions.length === 0) {
    return
  }

  const queue = capQueue([...queueOf(await $.store.get('queue')), ...impressions])

  await $.store.set('queue', queue)

  if (queue.length >= FLUSH_AT) {
    $.clock.after(0, () => void flush($))
  }
}

async function tick($: EngineInterface) {
  if ((await $.clock.now()) - run.fetchedAt > run.ttlMs) {
    void refresh($)
  }

  await update($, bannerIndex, index => index + 1)
}

async function openTheater($: EngineInterface, turnId: string) {
  const now = await $.clock.now()

  const shut =
    run.runningTurn !== turnId
      ? 'the turn ended within 3s'
      : !canDockTheater(run.seen)
        ? run.seen === undefined
          ? "the band hasn't reported the terminal's size"
          : run.seen.columns < THEATER_MIN_COLUMNS
            ? `the terminal is ${run.seen.columns} columns, under ${THEATER_MIN_COLUMNS}`
            : 'not the fullscreen layout'
        : now < run.theaterSnoozedUntil
          ? `snoozed for ${describeWait(run.theaterSnoozedUntil - now)} after you closed it`
          : (await read($, pausedUntil)) !== null
            ? 'ads are paused'
            : undefined

  if (shut !== undefined) {
    run.theaterNote = `stayed shut: ${shut}`

    return
  }

  const list = await read($, ads)
  const ad = theaterOf(list, currentBanner(list, await read($, bannerIndex)))

  await update($, theater, () => ({ adId: ad.id, turnId, isPlaced: false }))

  const opened = await $.ui.open({ id: THEATER_PANE, title: 'Tokenbreak' }).catch((error: unknown) => {
    run.theaterNote = `stayed shut: opening the pane failed (${String(error).slice(0, 120)})`

    return undefined
  })

  if (opened === undefined) {
    await update($, theater, () => null)

    return
  }

  if (!opened.isPlaced || run.runningTurn !== turnId) {
    run.theaterNote = opened.isPlaced ? 'stayed shut: the turn ended while it opened' : "stayed shut: Claude Code didn't place the pane"
    // Never leave a pane waiting undrawn for a wider terminal.
    await $.ui.close({ id: THEATER_PANE })
    await update($, theater, () => null)

    return
  }

  await update($, theater, () => ({ adId: ad.id, turnId, isPlaced: true }))
  run.theaterNote = `opened ${ad.brand}${
    !hasVideo(ad)
      ? ''
      : arePicturesOn()
        ? ` (video, ${cutsOf(ad).length} cut${cutsOf(ad).length === 1 ? '' : 's'}, ${lengthOf(ad, 0)} frames)`
        : ' (text only: pictures are off in /config)'
  }`
  playVideo($, ad)

  // Sound starts with the picture unless the person muted it once (`muted` in the store,
  // kept across sessions) or set `sound` to off.
  if (ad.audio !== undefined && run.isSoundOnByDefault && arePicturesOn() && (await $.store.get('muted')) !== true) {
    await startSound($, ad)
  }
}

/** Steps the Theater's Image through the cut it drew, until `stopVideo`. */
function playVideo($: EngineInterface, ad: Ad) {
  stopVideo()

  const fps = Math.max(0, ...cutsOf(ad).map((cut: AdVideo) => cut.fps))

  if (!hasVideo(ad) || fps === 0 || !arePicturesOn()) {
    return
  }

  run.video = { swapped: 0, refused: 0 }
  run.frame = undefined
  run.videoTimer = $.clock.every(Math.round(1000 / fps), () => {
    const drawn = run.drawnCut
    const length = drawn?.adId === ad.id ? lengthOf(ad, drawn.index) : 0

    if (drawn === undefined || length < 2) {
      return
    }

    run.frame = ((run.frame ?? posterOf(length)) + 1) % length

    const source = frameSource(ad, drawn.index, run.frame)

    if (source === undefined) {
      return
    }

    void $.ui
      .blit({ requestId: THEATER_PANE, key: 'theater-image', source })
      .then(result => {
        if (result.deny === undefined) {
          run.video.swapped += 1
        } else {
          run.video.refused += 1
          run.video.reason = result.deny
        }
      })
      .catch((error: unknown) => {
        run.video.refused += 1
        run.video.reason = String(error).slice(0, 160)
      })
  })
}

const arePicturesOn = () => run.arePicturesOn

function stopVideo() {
  run.videoTimer?.cancel()
  run.videoTimer = undefined
}

/** The sound button: mutes (and remembers it), or unmutes and plays from the top of the loop. */
async function toggleSound($: EngineInterface, ad: Ad) {
  if (run.sound !== undefined) {
    await stopSound($)
    await $.store.set('muted', true)

    return
  }

  await $.store.delete('muted')
  await startSound($, ad)
}

/** Plays the ad's sound, looping with the picture, until `stopSound`. */
async function startSound($: EngineInterface, ad: Ad) {
  const audio = ad.audio

  if (audio === undefined) {
    return
  }

  const controller = new AbortController()

  run.sound = controller
  run.frame = -1
  await update($, theaterSound, () => true)
  void $.audio
    .play('url' in audio ? { url: audio.url } : { asset: audio.asset }, { shouldLoop: true, signal: controller.signal })
    .catch((error: unknown) => {
      run.theaterNote = `${run.theaterNote}; sound failed: ${String(error).slice(0, 120)}`
    })
    .finally(() => {
      if (run.sound === controller) {
        run.sound = undefined
        void update($, theaterSound, () => false)
      }
    })
}

async function stopSound($: EngineInterface) {
  run.sound?.abort()
  run.sound = undefined
  await update($, theaterSound, () => false)
}

async function startSession($: EngineInterface) {
  for (const timer of run.timers.splice(0)) {
    timer.cancel()
  }

  stopVideo()
  await stopSound($)

  await $.command
    .register({
      name: 'ads',
      description: 'Tokenbreak ads: status, next, style, pause [1h|30m|today], resume, report',
      argumentHint: '[status|next|style pill|pause 1h|resume|report]',
      immediate: true,
    })
    .catch(() => undefined)

  const storedId = await $.store.get('deviceId')

  run.deviceId = typeof storedId === 'string' && storedId.length >= 8 ? storedId : crypto.randomUUID()

  if (storedId !== run.deviceId) {
    await $.store.set('deviceId', run.deviceId)
  }

  const cached = parseBatch(JSON.stringify((await $.store.get('batch')) ?? null), originOf(run.endpoint))
  const storedStyle = await $.store.get('bannerStyle')

  if (cached !== undefined && cached.ads.length > 0) {
    await showAds($, cached.ads)
    await update($, source, () => 'cache' as AdSource)
  } else {
    await showAds($, HOUSE_ADS)
    await update($, source, () => 'built-in' as AdSource)
  }

  await update($, bannerStyle, () => bannerStyleOf(storedStyle))

  const storedPause = await $.store.get('pausedUntil')
  const now = await $.clock.now()

  await setPause($, typeof storedPause === 'number' && storedPause > now ? storedPause : null)

  run.timers.push(
    $.clock.every(run.rotationMs, () => void tick($)),
    $.clock.every(FLUSH_EVERY_MS, () => void flush($)),
    $.clock.after(0, () => void refresh($)),
  )
}

async function adsCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const now = await $.clock.now()

  if (verb === 'pause') {
    const until = pauseUntil(rest.join(' '), now)

    if (until === undefined) {
      return 'Usage: /ads pause [1h|30m|2h|today]'
    }

    await setPause($, until)

    return `Tokenbreak paused for ${describeWait(until - now)}. /ads resume brings it back.`
  }

  if (verb === 'next') {
    await update($, bannerIndex, index => index + 1)

    const ad = currentBanner(await read($, ads), await read($, bannerIndex))

    return ad === undefined ? 'No banners to show.' : `Showing ad ${ad.id}.`
  }

  if (verb === 'style') {
    const wanted = rest[0]

    if (!BANNER_STYLES.includes(wanted as BannerStyle)) {
      return `Usage: /ads style [${BANNER_STYLES.join('|')}] (now ${await read($, bannerStyle)})`
    }

    await update($, bannerStyle, () => wanted as BannerStyle)
    await $.store.set('bannerStyle', wanted)

    return `Banner style: ${wanted}.`
  }

  if (verb === 'resume') {
    await setPause($, null)

    return 'Tokenbreak resumed.'
  }

  if (verb === 'report') {
    const ad = currentBanner(await read($, ads), await read($, bannerIndex))

    if (ad === undefined) {
      return 'No ad is showing right now.'
    }

    const reports = await $.store.get('reports')
    const kept = Array.isArray(reports) ? reports.slice(-49) : []

    await $.store.set('reports', [...kept, { adId: ad.id, at: now }])

    return `Reported ad ${ad.id}. Thanks: reports get a human review once accounts launch.`
  }

  if (verb !== 'status') {
    return 'Usage: /ads [status|next|style pill|pause 1h|pause today|resume|report]'
  }

  const until = await read($, pausedUntil)
  const from = await read($, source)
  const queued = queueOf(await $.store.get('queue')).length
  const ad = currentBanner(await read($, ads), await read($, bannerIndex))
  const origin =
    from === 'server'
      ? run.endpoint
      : from === 'cache'
        ? `${run.endpoint} (cached)`
        : 'built-in house ads (ad server unreachable)'

  return [
    `Tokenbreak · ${until === null ? 'on' : `paused, ${describeWait(until - now)} left`}`,
    `Showing: ${ad === undefined ? 'nothing' : `ad ${ad.id}`}`,
    `Ads from: ${origin}`,
    `Theater: ${run.isTheaterOn ? `on (fullscreen layout, 144+ columns, turns over 3s); last turn ${run.theaterNote}` : 'off'}`,
    ...(run.video.swapped + run.video.refused > 0
      ? [`Video: ${run.video.swapped} frames swapped, ${run.video.refused} refused${run.video.reason === undefined ? '' : ` (${run.video.reason})`}`]
      : []),
    `Impressions queued: ${queued}`,
    `Device: ${run.deviceId.slice(0, 8)}… (anonymous; accounts and earnings arrive later)`,
  ].join('\n')
}

async function closeTurn($: EngineInterface, turnId: string) {
  stopVideo()
  await stopSound($)
  run.runningTurn = undefined
  run.theaterTimer?.cancel()
  run.theaterTimer = undefined

  const showing = await read($, theater)

  if (showing !== null) {
    await $.ui.close({ id: THEATER_PANE }).catch(() => undefined)
    await update($, theater, () => null)
  }

  // Only ads the ad server served count; built-in house ads are never reported.
  if ((await read($, source)) === 'built-in' || (await read($, pausedUntil)) !== null) {
    return
  }

  const at = await $.clock.now()
  const impressions: Impression[] = []

  if (run.drawnBanner !== undefined) {
    impressions.push({ adId: run.drawnBanner, format: 'banner', at, turnId })
  }

  if (showing?.isPlaced === true && showing.turnId === turnId) {
    impressions.push({ adId: showing.adId, format: 'theater', at, turnId })
  }

  await enqueue($, impressions)
}

async function snoozeTheater($: EngineInterface) {
  run.theaterSnoozedUntil = (await $.clock.now()) + THEATER_SNOOZE_MS
  await update($, theater, () => null)
}

export const register: Register = (on, options) => {
  run = runOf(options)

  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await startSession($)
    }

    return next(e)
  })

  on('command.run', { command: 'ads' }, async ($, e) => ({ text: await adsCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport !== undefined) {
      run.seen = {
        columns: e.viewport.columns,
        rows: e.viewport.rows,
        isFullscreen: e.viewport.isFullscreen,
        maxRows: e.props.maxRows,
      }
    }

    const until = await read($, pausedUntil)
    const ad = currentBanner(await read($, ads), await read($, bannerIndex))

    if (e.props.hasSurvey || until !== null || ad === undefined) {
      run.drawnBanner = undefined

      return next(e)
    }

    run.drawnBanner = ad.id

    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const Image = e.surface === 'terminal' && arePicturesOn() ? $.ui.resolve(e).Image : undefined
    const style = await read($, bannerStyle)
    const href = linkable(ad.clickUrl)
    const accent = isHex(ad.accent) ? ad.accent : FALLBACK_ACCENT
    const cta = ad.cta ?? 'Learn more'
    // A logo only within LOGO_MAX_BYTES (parseBatch drops bigger ones): the band redraws
    // constantly, and a small picture goes in one short piece that a redraw can't cut.
    const mark =
      Image !== undefined && ad.logo !== undefined ? (
        <Image key="banner-logo" source={{ png: ad.logo.png }} columns={2} rows={1} alt={ad.glyph ?? ' '} />
      ) : (
        <Text color={accent}>{ad.glyph ?? '●'}</Text>
      )
    // Brand and headline are one link, so the whole line opens the ad.
    const words = (
      <Text wrap="truncate-end">
        <Text color={accent} bold>
          {ad.brand}
        </Text>
        {'  '}
        {ad.headline}
      </Text>
    )
    const action =
      href === undefined ? undefined : style === 'pill' ? (
        // The brand color on a dark tint of itself: reads as a button without a solid block of color.
        <Link href={href}>
          <Text backgroundColor={tint(accent, 0.22)} color={accent} bold>
            {` ${cta} ↗ `}
          </Text>
        </Link>
      ) : (
        <Link href={href}>
          <Text color={accent} bold underline>
            {`${cta} →`}
          </Text>
        </Link>
      )
    const row = (
      <Box flexDirection="row" gap={1} flexGrow={1}>
        {style === 'rule' && <Text color={accent}>▎</Text>}
        {mark}
        <Box flexGrow={1} flexShrink={1}>
          {href === undefined ? words : <Link href={href}>{words}</Link>}
        </Box>
        {action}
        <Box flexDirection="row" gap={1} marginLeft={1}>
          <Text dimColor>sponsored</Text>
          <Text dimColor>·</Text>
          <Button key="hide" label="✕" plain dimColor onPress={() => void hideFor($, 3_600_000)} />
        </Box>
      </Box>
    )

    // marginTop keeps a blank row between the banner and the spinner or transcript above it.
    return style === 'card' ? (
      <Box width={e.props.bodyColumns} borderStyle="round" borderColor={accent} paddingX={1}>
        {row}
      </Box>
    ) : (
      <Box width={e.props.bodyColumns} marginTop={1}>
        {row}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'tokenbreak-theater' }, async ($, e) => {
    const showing = await read($, theater)
    const list = await read($, ads)
    const isSoundOn = await read($, theaterSound)
    const ad = list.find(one => one.id === showing?.adId) ?? theaterOf(list)
    const href = linkable(ad.clickUrl)
    const accent = isHex(ad.accent) ? ad.accent : FALLBACK_ACCENT
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const isTextOnly = e.surface !== 'terminal' || !arePicturesOn()
    // The same parts as the banner: brand in its color, a dim label, a button in the brand's color.
    const card = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={accent} bold>
            {isTextOnly ? `${ad.glyph ?? '●'} ${ad.brand}` : ad.brand}
          </Text>
          <Text dimColor>sponsored</Text>
        </Box>
        <Text>{ad.headline}</Text>
        <Box flexDirection="row" gap={2}>
          {href !== undefined && (
            <Link href={href}>
              <Text backgroundColor={tint(accent, 0.22)} color={accent} bold>
                {` ${ad.cta ?? 'Learn more'} ↗ `}
              </Text>
            </Link>
          )}
          {ad.audio !== undefined && (
            // Mutes or unmutes; a mute is remembered. Sound always stops when the pane closes.
            <Button
              key="sound"
              label={isSoundOn ? '🔊 mute' : '🔇 sound'}
              plain
              dimColor={!isSoundOn}
              onPress={() => void toggleSound($, ad)}
            />
          )}
        </Box>
        <Text dimColor>Closes when Claude finishes · /ads pause hides ads</Text>
      </Box>
    )

    if (isTextOnly || e.surface !== 'terminal') {
      run.drawnCut = undefined

      return card
    }

    const { Image } = $.ui.resolve(e)
    const cuts = hasVideo(ad) ? cutsOf(ad) : []
    const art = cuts.length === 0 && ad.image === undefined ? theaterArt() : undefined
    const shapes =
      cuts.length > 0
        ? cuts.map(cut => ({ width: cut.width, height: cut.height }))
        : [{ width: ad.image?.width ?? art?.width ?? 16, height: ad.image?.height ?? art?.height ?? 9 }]
    // The cut and arrangement that show the biggest picture in this pane, tall or wide.
    const layout = theaterLayout(e.props.bodyColumns, e.props.scroll.bodyRows, shapes)
    const length = cuts.length > 0 ? lengthOf(ad, layout.shape) : 0

    run.drawnCut = cuts.length > 0 ? { adId: ad.id, index: layout.shape } : undefined

    // A video starts on its poster frame, or where playback is; playVideo swaps the rest in.
    const source: ImageSource =
      (length > 0 ? frameSource(ad, layout.shape, Math.max(0, run.frame ?? posterOf(length)) % length) : undefined) ??
      (ad.image !== undefined ? { png: ad.image.png } : { rgba: art?.rgba ?? '', width: shapes[0]?.width ?? 16, height: shapes[0]?.height ?? 9 })
    const picture = (
      <Image key="theater-image" source={source} columns={layout.columns} rows={layout.rows} alt={`${ad.brand}: ${ad.headline}`} />
    )

    return layout.mode === 'side' ? (
      <Box flexDirection="row" gap={2}>
        {picture}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {card}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="center">
          {picture}
        </Box>
        {card}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    // Only the turn's id is read, never its text.
    const turnId = e.turnId

    run.runningTurn = turnId
    run.theaterTimer?.cancel()
    run.theaterTimer = run.isTheaterOn ? $.clock.after(THEATER_DELAY_MS, () => void openTheater($, turnId)) : undefined

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn is not the person's. Only the turn's id is read.
    if (e.agentId === undefined) {
      await closeTurn($, e.turnId)
    }

    return next(e)
  })

  on('ui.close', { id: 'tokenbreak-theater' }, async ($, e, next) => {
    stopVideo()
    await stopSound($)

    if (e.origin.kind === 'person') {
      await snoozeTheater($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    void flush($)

    return next(e)
  })
}

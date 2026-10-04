import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Ad, AdSource, BannerStyle, Impression, TheaterShowing } from '../types'
import {
  BANNER_STYLES,
  bannerStyleOf,
  cacheable,
  canDockTheater,
  capQueue,
  currentBanner,
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

const FALLBACK_ACCENT = '#FFE600'

/** The module's own bookkeeping, set afresh by `register`: a reload starts it over. */
type Run = {
  endpoint: string
  isTheaterOn: boolean
  /** Whether ads draw pictures (logos, Theater images, video): the `pictures` option. */
  arePicturesOn: boolean
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
  /** Each video ad's frames by ad id; `$.state` holds the ads without them. */
  frames: Map<string, readonly string[]>
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
  run.frames = new Map(list.flatMap(ad => (ad.video === undefined ? [] : [[ad.id, ad.video.frames] as const])))
  await update($, ads, () => withoutFrames(list))
}

const framesOf = (ad: Ad) => run.frames.get(ad.id) ?? []

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
    const batch = response.ok ? parseBatch(response.text) : undefined

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
    framesOf(ad).length === 0
      ? ''
      : arePicturesOn()
        ? ` (video, ${framesOf(ad).length} frames)`
        : ' (text only: pictures are off in /config)'
  }`
  playVideo($, ad)
}

/** Steps the Theater's Image through the ad's frames until `stopVideo`. */
function playVideo($: EngineInterface, ad: Ad) {
  stopVideo()

  const video = ad.video
  const frames = framesOf(ad)

  if (video === undefined || frames.length < 2 || !arePicturesOn()) {
    return
  }

  let frame = posterOf(frames.length)

  run.video = { swapped: 0, refused: 0 }
  run.videoTimer = $.clock.every(Math.round(1000 / video.fps), () => {
    frame = (frame + 1) % frames.length
    void $.ui
      .blit({ requestId: THEATER_PANE, key: 'theater-image', source: { png: frames[frame] ?? '' } })
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

async function startSession($: EngineInterface) {
  for (const timer of run.timers.splice(0)) {
    timer.cancel()
  }

  stopVideo()

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

  const cached = parseBatch(JSON.stringify((await $.store.get('batch')) ?? null))
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
    // Only the terminal draws pictures; elsewhere the glyph stands in for the logo.
    const Image = e.surface === 'terminal' && arePicturesOn() ? $.ui.resolve(e).Image : undefined
    const style = await read($, bannerStyle)
    const href = linkable(ad.clickUrl)
    const accent = isHex(ad.accent) ? ad.accent : FALLBACK_ACCENT
    const logo = Image === undefined ? undefined : ad.logo
    const cta = ad.cta ?? 'Learn more'
    const mark =
      logo !== undefined && Image !== undefined ? (
        <Image key="banner-logo" source={{ png: logo.png }} columns={2} rows={1} alt={ad.glyph ?? ' '} />
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
    const ad = list.find(one => one.id === showing?.adId) ?? theaterOf(list)
    const href = linkable(ad.clickUrl)
    const accent = isHex(ad.accent) ? ad.accent : FALLBACK_ACCENT
    const width = Math.max(10, Math.min(e.props.bodyColumns - 2, 72))
    const { Box, Text, Link } = $.ui.resolve(e)
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
        {href !== undefined && (
          <Link href={href}>
            <Text backgroundColor={tint(accent, 0.22)} color={accent} bold>
              {` ${ad.cta ?? 'Learn more'} ↗ `}
            </Text>
          </Link>
        )}
        <Text dimColor>Closes when Claude finishes · /ads pause hides ads</Text>
      </Box>
    )

    if (isTextOnly || e.surface !== 'terminal') {
      return card
    }

    const { Image } = $.ui.resolve(e)
    const frames = framesOf(ad)
    // A video starts on its poster frame; playVideo swaps the rest in.
    const picture =
      ad.video !== undefined && frames.length > 0
        ? { png: frames[posterOf(frames.length)] ?? '', width: ad.video.width, height: ad.video.height }
        : ad.image
    const art = picture === undefined ? theaterArt() : undefined
    const pixelsWide = picture?.width ?? art?.width ?? 16
    const pixelsHigh = picture?.height ?? art?.height ?? 9
    // A cell is about twice as tall as it is wide.
    const rows = Math.max(3, Math.min(255, Math.round((width * pixelsHigh) / pixelsWide / 2)))

    return (
      <Box flexDirection="column" gap={1}>
        <Image
          key="theater-image"
          source={picture !== undefined ? { png: picture.png } : { rgba: art?.rgba ?? '', width: pixelsWide, height: pixelsHigh }}
          columns={Math.min(255, width)}
          rows={rows}
          alt={`${ad.brand}: ${ad.headline}`}
        />
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

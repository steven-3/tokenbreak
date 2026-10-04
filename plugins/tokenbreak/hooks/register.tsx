import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Ad, AdSource, Impression, TheaterShowing } from '../types'
import {
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
  linkable,
  parseBatch,
  pauseUntil,
  queueOf,
  rotationMs,
  statusAdOf,
  statusLine,
  THEATER_DELAY_MS,
  THEATER_PANE,
  THEATER_SNOOZE_MS,
  theaterArt,
  theaterOf,
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

const AD_TAG = '#FFE600'
const INK = '#141414'

/** The module's own bookkeeping, set afresh by `register`: a reload starts it over. */
type Run = {
  endpoint: string
  isTheaterOn: boolean
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
  timers: Timer[]
}

function runOf(options: PluginOptions): Run {
  return {
    endpoint: String(options.endpoint ?? 'https://tokenbreak.dev').replace(/\/+$/, ''),
    isTheaterOn: options.theater !== 'off',
    rotationMs: rotationMs(options.frequency),
    deviceId: '',
    fetchedAt: 0,
    ttlMs: 600_000,
    isRefreshing: false,
    isFlushing: false,
    theaterSnoozedUntil: 0,
    timers: [],
  }
}

let run: Run = runOf({})

async function showStatus($: EngineInterface) {
  const until = await read($, pausedUntil)

  $.ui.status(until === null ? statusLine(statusAdOf(await read($, ads))) : 'tokenbreak · paused (/ads resume)')
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
      await update($, ads, () => batch.ads)
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

  if (
    run.runningTurn !== turnId ||
    !canDockTheater(run.seen) ||
    now < run.theaterSnoozedUntil ||
    (await read($, pausedUntil)) !== null
  ) {
    return
  }

  const ad = theaterOf(await read($, ads))

  await update($, theater, () => ({ adId: ad.id, turnId, isPlaced: false }))

  const opened = await $.ui.open({ id: THEATER_PANE, title: 'Tokenbreak' })

  if (!opened.isPlaced || run.runningTurn !== turnId) {
    // Never leave a pane waiting undrawn for a wider terminal.
    await $.ui.close({ id: THEATER_PANE })
    await update($, theater, () => null)

    return
  }

  await update($, theater, () => ({ adId: ad.id, turnId, isPlaced: true }))
}

async function startSession($: EngineInterface) {
  for (const timer of run.timers.splice(0)) {
    timer.cancel()
  }

  await $.command
    .register({
      name: 'ads',
      description: 'Tokenbreak ads: status, pause [1h|30m|today], resume, report',
      argumentHint: '[status|pause 1h|pause today|resume|report]',
      immediate: true,
    })
    .catch(() => undefined)

  const storedId = await $.store.get('deviceId')

  run.deviceId = typeof storedId === 'string' && storedId.length >= 8 ? storedId : crypto.randomUUID()

  if (storedId !== run.deviceId) {
    await $.store.set('deviceId', run.deviceId)
  }

  const cached = parseBatch(JSON.stringify((await $.store.get('batch')) ?? null))

  if (cached !== undefined && cached.ads.length > 0) {
    await update($, ads, () => cached.ads)
    await update($, source, () => 'cache' as AdSource)
  } else {
    await update($, ads, () => [...HOUSE_ADS])
    await update($, source, () => 'built-in' as AdSource)
  }

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
    return 'Usage: /ads [status|pause 1h|pause today|resume|report]'
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
    `Theater: ${run.isTheaterOn ? 'on (fullscreen layout, 144+ columns, turns over 3s)' : 'off'}`,
    `Impressions queued: ${queued}`,
    `Device: ${run.deviceId.slice(0, 8)}… (anonymous; accounts and earnings arrive later)`,
  ].join('\n')
}

async function closeTurn($: EngineInterface, turnId: string) {
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

  const sponsor = statusAdOf(await read($, ads))

  if (sponsor !== undefined) {
    impressions.push({ adId: sponsor.id, format: 'status', at, turnId })
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
    const href = linkable(ad.clickUrl)

    return (
      <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
        <Text backgroundColor={AD_TAG} color={INK} bold>
          {' AD '}
        </Text>
        <Text color={isHex(ad.accent) ? ad.accent : undefined} bold>
          {ad.glyph === undefined ? ad.brand : `${ad.glyph} ${ad.brand}`}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {ad.headline}
          </Text>
        </Box>
        {href !== undefined && <Link href={href} label="open ↗" />}
        <Button key="hide" label="hide 1h" plain onPress={() => void hideFor($, 3_600_000)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'tokenbreak-theater' }, async ($, e) => {
    const showing = await read($, theater)
    const list = await read($, ads)
    const ad = list.find(one => one.id === showing?.adId) ?? theaterOf(list)
    const href = linkable(ad.clickUrl)
    const width = Math.max(10, Math.min(e.props.bodyColumns - 2, 72))

    if (e.surface === 'terminal') {
      const { Box, Text, Link, Image } = $.ui.resolve(e)
      const picture = ad.image
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
          <Box flexDirection="row" gap={1}>
            <Text backgroundColor={AD_TAG} color={INK} bold>
              {' AD '}
            </Text>
            <Text color={isHex(ad.accent) ? ad.accent : undefined} bold>
              {ad.brand}
            </Text>
          </Box>
          <Text>{ad.headline}</Text>
          {href !== undefined && <Link href={href} label="learn more ↗" />}
          <Text dimColor>Closes when Claude finishes. /ads pause hides ads.</Text>
        </Box>
      )
    }

    const { Box, Text, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text backgroundColor={AD_TAG} color={INK} bold>
            {' AD '}
          </Text>
          <Text color={isHex(ad.accent) ? ad.accent : undefined} bold>
            {ad.glyph === undefined ? ad.brand : `${ad.glyph} ${ad.brand}`}
          </Text>
        </Box>
        <Text>{ad.headline}</Text>
        {href !== undefined && <Link href={href} label="learn more ↗" />}
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

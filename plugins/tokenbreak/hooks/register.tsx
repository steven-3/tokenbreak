import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, PluginOptions, Register, RenderInput, Timer } from 'claude-code'

import type {
  Account,
  Ad,
  AdReport,
  AdSource,
  AdSurface,
  AdVideo,
  BannerStyle,
  Impression,
  ModRelease,
  Seat,
  TheaterShowing,
  TurnGrant,
  UpdateState,
} from '../types'
import {
  activeHides,
  AD_LABEL,
  AUTO_UPDATE_STEPS,
  BANNER_LINGER_MS,
  BANNER_MIN_COLUMNS,
  BANNER_STYLES,
  bannerStyleOf,
  cacheable,
  canDockTheater,
  capQueue,
  currentBanner,
  cutsOf,
  describeWait,
  DEVICE_GRANT,
  EARNINGS_URL,
  endStretch,
  FLUSH_AT,
  FLUSH_EVERY_MS,
  formatUserCode,
  FORMATS,
  freshOf,
  HIDE_CAMPAIGN_DAYS,
  HIDE_CAMPAIGN_MS,
  hideKeyOf,
  HOUSE_ADS,
  impressionKey,
  isHex,
  tint,
  UPDATE_STEPS,
  updateStateOf,
  linkable,
  longestPaid,
  MIN_SHOWN_MS,
  MOD_CLIENT_ID,
  MOD_HEADERS,
  MOD_VERSION,
  noteDrawn,
  posterOf,
  parseBatch,
  parseDeviceCode,
  parseDevicePoll,
  parseGrant,
  pauseUntil,
  queueOf,
  REPORT_QUEUE_CAP,
  reportArgsOf,
  reportQueueOf,
  rotationMs,
  rotationOf,
  shownOf,
  surfaceOf,
  THEATER_DELAY_MS,
  THEATER_MIN_COLUMNS,
  THEATER_PANE,
  THEATER_SNOOZE_MS,
  theaterArt,
  theaterLayout,
  theaterOf,
  trackerOf,
  TURN_MIN_GAP_MS,
  TURN_TIMEOUT_MS,
  WAITING_NOTICE,
  WELCOME_LINES,
  withoutFrames,
  type QueuedReport,
  type Seen,
  type Shown,
  type ShownTracker,
} from './core'

// Privacy rule: Tokenbreak never hooks prompt.compose, session.append,
// tool.call, turn.step or anything else that reads or shapes the conversation.
// Of turn.start and turn.complete it reads the turn's id (and, at the end,
// whether it was a subagent's) and nothing else. tests/privacy.test.ts holds it
// to that. Nor does it hook the permission prompt: the only events that say one
// is open (classic PermissionRequest and Notification) carry the tool's input
// or the prompt's text, so ads can't step aside for it without reading them.

const ads = atom({ plugin: 'tokenbreak', key: 'ads' } as const, [] as Ad[])
const source = atom({ plugin: 'tokenbreak', key: 'source' } as const, 'built-in' as AdSource)
const bannerIndex = atom({ plugin: 'tokenbreak', key: 'bannerIndex' } as const, 0)
const pausedUntil = atom({ plugin: 'tokenbreak', key: 'pausedUntil' } as const, null as number | null)
const theater = atom({ plugin: 'tokenbreak', key: 'theater' } as const, null as TheaterShowing | null)
const bannerStyle = atom({ plugin: 'tokenbreak', key: 'bannerStyle' } as const, 'pill' as BannerStyle)
const theaterSound = atom({ plugin: 'tokenbreak', key: 'theaterSound' } as const, false)
const updateState = atom({ plugin: 'tokenbreak', key: 'update' } as const, { kind: 'current' } as UpdateState)
const account = atom({ plugin: 'tokenbreak', key: 'account' } as const, { kind: 'out' } as Account)
const bannerUp = atom({ plugin: 'tokenbreak', key: 'bannerUp' } as const, false)
const hidden = atom({ plugin: 'tokenbreak', key: 'hidden' } as const, {} as Record<string, number>)
const seat = atom({ plugin: 'tokenbreak', key: 'seat' } as const, null as Seat | null)
const welcome = atom({ plugin: 'tokenbreak', key: 'welcome' } as const, false)

const FALLBACK_ACCENT = '#FFE600'
const AD_YELLOW = '#FFE600'

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
  /** The session token `/ads login` got, sent as a bearer token; undefined while signed out. */
  token?: string
  /** Polls the site while `/ads login` waits for approval. */
  loginTimer?: Timer
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
  /** Where ads are drawn, as the last session start or band draw said. */
  surface: AdSurface
  /** The banner the band last drew; undefined while it shows none. */
  drawnBanner?: Ad
  /** The banner's time on screen this turn. */
  banner: ShownTracker
  /** The Theater ad while its pane is open and placed, since when. */
  theaterOpen?: Omit<Shown, 'ms'> & { turnId: string; since: number }
  /** How long the Theater stayed open in the turn it opened for. */
  theaterShown?: Shown & { turnId: string }
  /** The person's turn running or last run, and the server's grant for it once it came. */
  turn?: { turnId: string; grant?: TurnGrant; pending?: Promise<TurnGrant | undefined>; note: string }
  /** When the mod last asked for a turn token. */
  turnAskedAt: number
  /** Hides the banner once the linger after a turn runs out. */
  lingerTimer?: Timer
  /** Whether the welcome card has been on screen. */
  isWelcomeDrawn: boolean
  isSendingReports: boolean
  /** The last paid ad on screen, which `/ads report` reports. */
  lastPaid?: LastPaid
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

/** The paid ad `/ads report` names: its id, its serve token, and its brand to say back. */
type LastPaid = Pick<AdReport, 'adId' | 'serveToken'> & { brand: string }

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
    surface: 'terminal',
    banner: trackerOf(),
    turnAskedAt: Number.NEGATIVE_INFINITY,
    isWelcomeDrawn: false,
    isSendingReports: false,
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

/**
 * Takes in the server's release info: a mod too old to earn shows an update notice
 * in place of ads and reports nothing; an update that's merely out gets one toast
 * per version.
 */
async function applyRelease($: EngineInterface, release: ModRelease | undefined) {
  const state = updateStateOf(release)

  await update($, updateState, () => state)

  // A build switched off shows nothing at all, toasts included: /ads says why.
  if ((state.kind === 'available' || state.kind === 'required') && (await $.store.get('toldVersion')) !== state.latest) {
    await $.store.set('toldVersion', state.latest)
    $.ui.toast(
      state.kind === 'required'
        ? `Tokenbreak ${state.latest} is required to keep earning. /ads update shows how.`
        : `Tokenbreak ${state.latest} is out. /ads update shows how to get it.`,
      { timeoutMs: 8000 },
    )
  }
}

/** Too old to earn, or switched off: either way nothing is counted. */
const isUpdateRequired = async ($: EngineInterface) => {
  const kind = (await read($, updateState)).kind

  return kind === 'required' || kind === 'blocked'
}

const isBlocked = async ($: EngineInterface) => (await read($, updateState)).kind === 'blocked'

/** `promise`, or undefined once `ms` pass first: nothing the mod sends may hold a turn or a command up. */
function within<T>($: EngineInterface, promise: Promise<T>, ms = TURN_TIMEOUT_MS): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(undefined))

    promise.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(undefined)
      },
    )
  })
}

const isSignedIn = async ($: EngineInterface) => run.token !== undefined && (await read($, account)).kind === 'in'

/** The bearer header for the ad server, empty while signed out. */
const authHeaders = (): Record<string, string> => (run.token === undefined ? {} : { authorization: `Bearer ${run.token}` })

/** Which install asks, which version, and where it draws: sent with `GET /api/v1/ads` and `POST /api/v1/turns`. */
const modHeaders = (): Record<string, string> => ({
  ...(run.deviceId !== '' && { [MOD_HEADERS.device]: run.deviceId }),
  [MOD_HEADERS.version]: MOD_VERSION,
  [MOD_HEADERS.surface]: run.surface,
})

/** Forgets the account on this machine: the token is gone or no longer good. */
async function forgetAccount($: EngineInterface) {
  stopLogin()
  run.token = undefined
  await $.store.delete('token')
  await $.store.delete('login')
  await update($, account, () => ({ kind: 'out' }) as Account)
}

function stopLogin() {
  run.loginTimer?.cancel()
  run.loginTimer = undefined
}

/** `/ads login`: asks the site for a code, then polls until the person approves it at /device. */
async function startLogin($: EngineInterface): Promise<string> {
  const current = await read($, account)

  if (current.kind === 'in') {
    return `Signed in as @${current.login}. /ads logout to switch accounts.`
  }

  stopLogin()

  const response = await $.http
    .fetch(`${run.endpoint}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: MOD_CLIENT_ID }),
    })
    .catch(() => undefined)
  const code = response?.ok === true ? parseDeviceCode(response.text) : undefined

  if (code === undefined) {
    await update($, account, () => ({ kind: 'out' }) as Account)

    return `Couldn't start sign-in at ${run.endpoint}${response === undefined ? ' (unreachable)' : ` (HTTP ${response.status})`}. Try again in a minute.`
  }

  const userCode = formatUserCode(code.userCode)
  const expiresAt = (await $.clock.now()) + code.expiresInMs
  let intervalMs = code.intervalMs
  let isPolling = false

  await update($, account, () => ({ kind: 'pending', userCode, url: code.url }) as Account)

  const poll = async () => {
    if (isPolling) {
      return
    }

    isPolling = true

    try {
      if ((await $.clock.now()) > expiresAt) {
        await endLogin($, 'The sign-in code expired. Run /ads login for a new one.')

        return
      }

      const answer = await $.http
        .fetch(`${run.endpoint}/api/auth/device/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: code.deviceCode, client_id: MOD_CLIENT_ID }),
        })
        .catch(() => undefined)
      const outcome = answer === undefined ? { kind: 'wait' as const, slower: false } : parseDevicePoll(answer.status, answer.text)

      if (outcome.kind === 'token') {
        await finishLogin($, outcome.token)
      } else if (outcome.kind === 'stop') {
        await endLogin(
          $,
          outcome.reason === 'denied'
            ? 'Sign-in was denied on the site. Run /ads login to try again.'
            : outcome.reason === 'expired'
              ? 'The sign-in code expired. Run /ads login for a new one.'
              : 'Sign-in failed. Run /ads login to try again.',
        )
      } else if (outcome.slower) {
        intervalMs += 5_000
        run.loginTimer?.cancel()
        run.loginTimer = $.clock.every(intervalMs, () => void poll())
      }
    } finally {
      isPolling = false
    }
  }

  run.loginTimer = $.clock.every(intervalMs, () => void poll())

  return [
    `To link Claude Code to your Tokenbreak account, open:`,
    `  ${code.url}`,
    `and approve code ${userCode} (signed in with GitHub). It lasts ${describeWait(code.expiresInMs)}.`,
    `Tokenbreak waits here and starts once you approve.`,
  ].join('\n')
}

async function endLogin($: EngineInterface, message: string) {
  stopLogin()
  await update($, account, () => ({ kind: 'out' }) as Account)
  $.ui.toast(message, { timeoutMs: 8000 })
}

/** Keeps the token, learns the GitHub handle it belongs to, and starts ads. */
async function finishLogin($: EngineInterface, token: string) {
  stopLogin()
  run.token = token

  const session = await $.http
    .fetch(`${run.endpoint}/api/auth/get-session`, { headers: { accept: 'application/json', ...authHeaders() } })
    .catch(() => undefined)
  let login = 'you'

  try {
    const user = (JSON.parse(session?.text ?? 'null') as { user?: { githubLogin?: unknown; name?: unknown } } | null)?.user
    login = typeof user?.githubLogin === 'string' ? user.githubLogin : typeof user?.name === 'string' ? user.name : login
  } catch {
    // The handle is only for /ads status; the token is what matters.
  }

  await $.store.set('token', token)
  await $.store.set('login', login)

  // The first sign-in on this machine opens with the welcome card, once.
  if ((await $.store.get('welcomed')) !== true) {
    await $.store.set('welcome', true)
    await update($, welcome, () => true)
  }

  await update($, account, () => ({ kind: 'in', login }) as Account)
  $.ui.toast(`Tokenbreak: signed in as @${login}. Ads start on your next turn.`, { timeoutMs: 8000 })
  run.fetchedAt = 0
  void refresh($)
}

/** `/ads logout`: sends what's queued, ends the session on the site, and forgets it here. */
async function logout($: EngineInterface): Promise<string> {
  const current = await read($, account)

  if (current.kind !== 'in' || run.token === undefined) {
    stopLogin()
    await update($, account, () => ({ kind: 'out' }) as Account)

    return 'Not signed in. /ads login links your GitHub account.'
  }

  await flush($)
  await $.http
    .fetch(`${run.endpoint}/api/auth/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: '{}',
    })
    .catch(() => undefined)
  await $.store.set('queue', [])
  await forgetAccount($)

  return `Signed out of @${current.login}. Tokenbreak shows no ads until /ads login.`
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

async function hideForToday($: EngineInterface) {
  await setPause($, pauseUntil('today', await $.clock.now()) ?? null)
}

/**
 * `✕` on an ad: hides its campaign on this machine for HIDE_CAMPAIGN_DAYS (the
 * rotation moves on to the next ad), and tells the server with a `hide` report,
 * without waiting for it.
 */
async function hideCampaign($: EngineInterface, ad: Ad) {
  const now = await $.clock.now()
  const hides = { ...activeHides(await read($, hidden), now), [hideKeyOf(ad)]: now + HIDE_CAMPAIGN_MS }

  await update($, hidden, () => hides)
  await $.store.set('hidden', hides)
  $.ui.toast(`Tokenbreak: ${ad.brand} is hidden on this machine for ${HIDE_CAMPAIGN_DAYS} days. /ads pause stops all ads.`, {
    timeoutMs: 6000,
  })

  if (!ad.isHouse) {
    await queueReport($, { ...shownOf(ad), reason: 'hide', at: now })
    void sendReports($)
  }
}

/** The welcome card has done its job: it never shows again on this machine. */
async function endWelcome($: EngineInterface) {
  run.isWelcomeDrawn = false
  await $.store.set('welcomed', true)
  await $.store.delete('welcome')
  await update($, welcome, () => false)
}

/** Keeps a report until the server has it; the oldest give way past REPORT_QUEUE_CAP. */
async function queueReport($: EngineInterface, report: QueuedReport) {
  const queue = [...reportQueueOf(await $.store.get('reportQueue')), report]

  await $.store.set('reportQueue', queue.slice(-REPORT_QUEUE_CAP))
}

const sameReport = (a: QueuedReport, b: QueuedReport) => a.adId === b.adId && a.reason === b.reason && a.at === b.at

/**
 * Sends the queued reports in order, one `POST /api/v1/reports` each, each held to
 * TURN_TIMEOUT_MS. One the server took, or refused as malformed, leaves the queue;
 * unreachable, a 5xx, 401 or 429 stops the run and keeps the rest for later.
 */
async function sendReports($: EngineInterface) {
  if (run.isSendingReports || !(await isSignedIn($))) {
    return
  }

  run.isSendingReports = true

  try {
    for (const report of reportQueueOf(await $.store.get('reportQueue'))) {
      const { at: _at, ...body } = report
      const response = await within(
        $,
        $.http.fetch(`${run.endpoint}/api/v1/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(), ...modHeaders() },
          body: JSON.stringify(body satisfies AdReport),
        }),
      )

      if (response === undefined || response.status >= 500 || response.status === 401 || response.status === 429) {
        return
      }

      await $.store.set(
        'reportQueue',
        reportQueueOf(await $.store.get('reportQueue')).filter(one => !sameReport(one, report)),
      )
    }
  } finally {
    run.isSendingReports = false
  }
}

/**
 * Asks the server for this turn's token, without holding the turn up: the answer
 * counts only if it comes within TURN_TIMEOUT_MS. No token (offline, an error, a
 * 429) means the turn's ads still show and nothing paid is reported.
 */
async function askTurn($: EngineInterface, turnId: string) {
  const now = await $.clock.now()
  const skip = !(await isSignedIn($))
    ? 'signed out'
    : (await read($, pausedUntil)) !== null
      ? 'ads are paused'
      : (await isUpdateRequired($))
        ? 'this version earns nothing'
        : (await read($, seat)) === 'waiting'
          ? 'waiting for an earning seat'
          : now - run.turnAskedAt < TURN_MIN_GAP_MS
            ? `under ${TURN_MIN_GAP_MS / 1000}s since the last turn`
            : undefined

  if (skip !== undefined) {
    run.turn = { turnId, note: `no turn token: ${skip}` }

    return
  }

  run.turnAskedAt = now

  const pending = within(
    $,
    $.http.fetch(`${run.endpoint}/api/v1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(), ...modHeaders() },
      body: JSON.stringify({ deviceId: run.deviceId, surface: run.surface }),
    }),
  ).then(response => {
    const grant = response?.ok === true ? parseGrant(response.text) : undefined

    if (run.turn?.turnId === turnId) {
      run.turn = {
        turnId,
        ...(grant !== undefined && { grant }),
        note:
          grant !== undefined
            ? 'turn token granted'
            : `no turn token: ${response === undefined ? 'no answer within 3s' : `HTTP ${response.status}`}`,
      }
    }

    return grant
  })

  run.turn = { turnId, pending, note: 'asking for a turn token' }
}

/** What the banner draws now: the mod's own record of what is on screen, for its time-on-screen count. */
async function noteBanner($: EngineInterface, ad: Ad | undefined) {
  if (ad === run.drawnBanner || (ad !== undefined && ad.id === run.drawnBanner?.id && ad.serveToken === run.drawnBanner.serveToken)) {
    return
  }

  run.banner = noteDrawn(run.banner, ad, await $.clock.now())
  run.drawnBanner = ad

  if (ad !== undefined && !ad.isHouse) {
    await rememberPaid($, ad)
  }
}

async function rememberPaid($: EngineInterface, ad: Ad) {
  if (run.lastPaid?.adId === ad.id && run.lastPaid.serveToken === ad.serveToken) {
    return
  }

  run.lastPaid = { ...shownOf(ad), brand: ad.brand }
  await $.store.set('lastPaid', run.lastPaid)
}

function lastPaidOf(raw: unknown): LastPaid | undefined {
  const one = raw as Partial<LastPaid> | null | undefined

  return typeof one?.adId === 'string' && typeof one.brand === 'string'
    ? { adId: one.adId, brand: one.brand, ...(typeof one.serveToken === 'string' && { serveToken: one.serveToken }) }
    : undefined
}

/** Ends the Theater's stretch on screen: when it closes, by the person or at the turn's end. */
async function endTheater($: EngineInterface) {
  const open = run.theaterOpen

  if (open === undefined) {
    return
  }

  const { since, ...shown } = open

  run.theaterOpen = undefined
  run.theaterShown = { ...shown, ms: Math.max(0, (await $.clock.now()) - since) }
}

/** The linger after a turn ran out: the banner hides until the next turn, and a welcome card that showed is done. */
async function endLinger($: EngineInterface) {
  run.lingerTimer = undefined
  await update($, bannerUp, () => false)

  if (run.isWelcomeDrawn) {
    await endWelcome($)
  }
}

async function refresh($: EngineInterface) {
  // Signed out, the server has nothing to give: it serves ads only to an account.
  if (run.isRefreshing || !(await isSignedIn($))) {
    return
  }

  run.isRefreshing = true

  try {
    const response = await $.http.fetch(`${run.endpoint}/api/v1/ads?formats=${FORMATS.join(',')}`, {
      headers: { accept: 'application/json', ...authHeaders(), ...modHeaders() },
    })

    if (response.status === 401) {
      // Signed out on the site, or the session ran out: back to the sign-in hint.
      await forgetAccount($)
      $.ui.toast('Tokenbreak was signed out. /ads login to start again.', { timeoutMs: 8000 })

      return
    }

    const batch = response.ok ? parseBatch(response.text) : undefined

    if (batch?.mod?.blocked === true) {
      // Switched off: show nothing, report nothing; the cached batch keeps it so across sessions.
      run.fetchedAt = await $.clock.now()
      run.ttlMs = batch.ttlSeconds * 1000
      await applyRelease($, batch.mod)
      await $.store.set('queue', [])
      await $.store.set('batch', cacheable(batch))

      return
    }

    if (batch !== undefined && batch.ads.length > 0) {
      run.fetchedAt = await $.clock.now()
      run.ttlMs = batch.ttlSeconds * 1000
      await showAds($, batch.ads)
      await applyRelease($, batch.mod)
      await update($, seat, () => batch.seat ?? null)
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
  if (run.isFlushing || !(await isSignedIn($))) {
    return
  }

  run.isFlushing = true

  try {
    if (await isBlocked($)) {
      await $.store.set('queue', [])

      return
    }

    const stored = queueOf(await $.store.get('queue'))
    // Impressions too old to earn are dropped, not sent.
    const queued = freshOf(stored, await $.clock.now())

    if (queued.length < stored.length) {
      await $.store.set('queue', queued)
    }

    if (queued.length === 0) {
      return
    }

    const sent = queued.slice(0, 200)
    const response = await $.http.fetch(`${run.endpoint}/api/v1/impressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId: run.deviceId, modVersion: MOD_VERSION, impressions: sent }),
    })

    if (response.status === 401) {
      // The queue waits for the next sign-in rather than going to another account's ledger.
      await forgetAccount($)

      return
    }

    if (response.status === 426) {
      // Too old to earn: nothing queued will be credited, so drop it and say so.
      const min = (JSON.parse(response.text) as { minVersion?: unknown }).minVersion

      await $.store.set('queue', [])
      await applyRelease($, { latest: typeof min === 'string' ? min : MOD_VERSION, min: typeof min === 'string' ? min : MOD_VERSION })

      return
    }

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
  const now = await $.clock.now()

  if (now - run.fetchedAt > run.ttlMs) {
    void refresh($)
  }

  const hides = await read($, hidden)
  const active = activeHides(hides, now)

  if (Object.keys(active).length < Object.keys(hides).length) {
    await update($, hidden, () => active)
    await $.store.set('hidden', active)
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
            : !(await isSignedIn($))
              ? 'signed out; /ads login'
              : (await isBlocked($))
                ? 'this version has been switched off; /ads update'
                : (await isUpdateRequired($))
                  ? 'this version is too old to earn; /ads update'
                  : undefined

  if (shut !== undefined) {
    run.theaterNote = `stayed shut: ${shut}`

    return
  }

  const list = rotationOf(await read($, ads), await read($, hidden), now, await read($, seat))
  const ad = theaterOf(list, currentBanner(list, await read($, bannerIndex)))

  await update($, theater, () => ({ ...shownOf(ad), turnId, isPlaced: false }))

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

  await update($, theater, () => ({ ...shownOf(ad), turnId, isPlaced: true }))
  run.theaterOpen = { ...shownOf(ad), isHouse: ad.isHouse, turnId, since: await $.clock.now() }

  if (!ad.isHouse) {
    await rememberPaid($, ad)
  }

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

async function startSession($: EngineInterface, surface: unknown) {
  for (const timer of run.timers.splice(0)) {
    timer.cancel()
  }

  run.surface = surfaceOf(surface)
  run.lingerTimer?.cancel()
  run.lingerTimer = undefined

  stopVideo()
  await stopSound($)

  stopLogin()

  await $.command
    .register({
      name: 'ads',
      description: 'Tokenbreak ads: login, logout, status, update, next, style, pause [1h|30m|today], resume, report [reason] [note]',
      argumentHint: '[login|logout|status|update|next|style pill|pause 1h|resume|report scam]',
      immediate: true,
    })
    .catch(() => undefined)

  // Ads need an account: a session token from /ads login, kept across sessions.
  const storedToken = await $.store.get('token')
  const storedLogin = await $.store.get('login')

  run.token = typeof storedToken === 'string' && storedToken.length > 0 ? storedToken : undefined
  await update($, account, () =>
    (run.token === undefined ? { kind: 'out' } : { kind: 'in', login: typeof storedLogin === 'string' ? storedLogin : 'you' }) as Account,
  )

  const storedId = await $.store.get('deviceId')

  run.deviceId = typeof storedId === 'string' && storedId.length >= 8 ? storedId : crypto.randomUUID()

  if (storedId !== run.deviceId) {
    await $.store.set('deviceId', run.deviceId)
  }

  const cached = parseBatch(JSON.stringify((await $.store.get('batch')) ?? null))
  const storedStyle = await $.store.get('bannerStyle')

  if (cached !== undefined && cached.ads.length > 0) {
    await showAds($, cached.ads)
    await applyRelease($, cached.mod)
    await update($, seat, () => cached.seat ?? null)
    await update($, source, () => 'cache' as AdSource)
  } else {
    await showAds($, HOUSE_ADS)
    await applyRelease($, cached?.mod)
    await update($, source, () => 'built-in' as AdSource)
  }

  await update($, bannerStyle, () => bannerStyleOf(storedStyle))

  const storedPause = await $.store.get('pausedUntil')
  const now = await $.clock.now()
  const hides = activeHides(await $.store.get('hidden'), now)

  await update($, hidden, () => hides)
  await update($, bannerUp, () => false)
  const isWelcomeDue = (await $.store.get('welcome')) === true && (await $.store.get('welcomed')) !== true

  await update($, welcome, () => isWelcomeDue)
  run.lastPaid = lastPaidOf(await $.store.get('lastPaid'))

  await setPause($, typeof storedPause === 'number' && storedPause > now ? storedPause : null)

  run.timers.push(
    $.clock.every(run.rotationMs, () => void tick($)),
    $.clock.every(FLUSH_EVERY_MS, () => {
      void flush($)
      void sendReports($)
    }),
    $.clock.after(0, () => void refresh($).then(() => sendReports($))),
  )
}

/** What `/ads` says of this build: current, an update out, too old to earn, or switched off. */
function versionLine(state: UpdateState): string {
  switch (state.kind) {
    case 'current':
      return `Version: ${MOD_VERSION}, the latest`
    case 'available':
      return `Version: ${MOD_VERSION}; ${state.latest} is out (/ads update)`
    case 'required':
      return `Version: ${MOD_VERSION}, too old to earn; ${state.latest} is out (/ads update)`
    case 'blocked':
      return `Version: ${MOD_VERSION} has been switched off; update to ${state.latest} (/ads update)`
  }
}

const SWITCHED_OFF = `This version of Tokenbreak (${MOD_VERSION}) has been switched off: it shows and counts no ads. Update it: /ads update`

/** `/ads report [reason] [note]`: the last paid ad on screen goes to the server for a person to review. */
async function reportAd($: EngineInterface, words: readonly string[]): Promise<string> {
  // The paid banner on screen, else the last paid ad that was.
  const drawn = run.drawnBanner
  const ad = drawn !== undefined && !drawn.isHouse ? { ...shownOf(drawn), brand: drawn.brand } : run.lastPaid

  if (ad === undefined) {
    return "No paid ad has shown on this machine yet, so there's nothing to report."
  }

  const { reason, note } = reportArgsOf(words)
  const report: QueuedReport = {
    adId: ad.adId,
    ...(ad.serveToken !== undefined && { serveToken: ad.serveToken }),
    reason,
    ...(note !== undefined && { note }),
    at: await $.clock.now(),
  }

  await queueReport($, report)
  await sendReports($)

  const isSent = !reportQueueOf(await $.store.get('reportQueue')).some(one => sameReport(one, report))

  return isSent
    ? `Reported ${ad.brand} (${reason}). It was sent to Tokenbreak for human review. Thanks.`
    : `Saved your report on ${ad.brand} (${reason}). It goes to Tokenbreak for human review as soon as ${
        (await isSignedIn($)) ? 'the server can be reached' : "you're signed in (/ads login)"
      }.`
}

async function adsCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = 'status'] = args.trim().split(/\s+/).filter(Boolean)
  const answer = await answerAds($, args)

  // Switched off, every answer but the update steps and the status says so first.
  return (await isBlocked($)) && verb !== 'update' && verb !== 'status' ? `${SWITCHED_OFF}\n${answer}` : answer
}

async function answerAds($: EngineInterface, args: string): Promise<string> {
  const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const now = await $.clock.now()

  if (verb === 'login') {
    return startLogin($)
  }

  if (verb === 'logout') {
    return logout($)
  }

  if (verb === 'pause') {
    const until = pauseUntil(rest.join(' '), now)

    if (until === undefined) {
      return 'Usage: /ads pause [1h|30m|2h|today]'
    }

    await setPause($, until)

    return `Tokenbreak paused for ${describeWait(until - now)}. /ads resume brings it back.`
  }

  if (verb === 'update') {
    const state = await read($, updateState)
    const where =
      state.kind === 'current'
        ? `You're on ${MOD_VERSION}, the latest.`
        : state.kind === 'blocked'
          ? `You're on ${MOD_VERSION}, which has been switched off; ${state.latest} is out.`
          : `You're on ${MOD_VERSION}; ${state.latest} is out${state.kind === 'required' ? ' and needed to keep earning' : ''}.`

    return `${where}\n${UPDATE_STEPS}`
  }

  if (verb === 'next') {
    await update($, bannerIndex, index => index + 1)

    const ad = currentBanner(rotationOf(await read($, ads), await read($, hidden), now, await read($, seat)), await read($, bannerIndex))

    return ad === undefined ? 'No banners to show.' : `Showing ad ${ad.id}${(await read($, bannerUp)) ? '' : ' during your next turn'}.`
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
    return reportAd($, rest)
  }

  if (verb !== 'status') {
    return 'Usage: /ads [login|logout|status|update|next|style pill|pause 1h|pause today|resume|report [scam|misleading|offensive|broken|other] [note]]'
  }

  const until = await read($, pausedUntil)
  const from = await read($, source)
  const who = await read($, account)
  const queued = queueOf(await $.store.get('queue')).length
  const reportsQueued = reportQueueOf(await $.store.get('reportQueue')).length
  const state = await read($, updateState)
  const seated = await read($, seat)
  const hides = Object.keys(activeHides(await read($, hidden), now)).length
  const ad = currentBanner(rotationOf(await read($, ads), await read($, hidden), now, seated), await read($, bannerIndex))
  const origin =
    from === 'server'
      ? run.endpoint
      : from === 'cache'
        ? `${run.endpoint} (cached)`
        : 'built-in house ads (ad server unreachable)'

  return [
    `Tokenbreak · ${state.kind === 'blocked' ? 'switched off' : until === null ? 'on' : `paused, ${describeWait(until - now)} left`}`,
    ...(state.kind === 'blocked' ? [SWITCHED_OFF] : []),
    `Account: ${
      who.kind === 'in'
        ? `@${who.login}`
        : who.kind === 'pending'
          ? `waiting for you to approve ${who.userCode} at ${who.url}`
          : 'signed out. /ads login links your GitHub account; ads start once you do'
    }`,
    ...(seated === null ? [] : [`Seat: ${seated === 'earning' ? 'earning' : `waiting. ${WAITING_NOTICE}`}`]),
    `Showing: ${
      who.kind !== 'in' || state.kind === 'blocked'
        ? 'nothing'
        : ad === undefined
          ? 'nothing'
          : `ad ${ad.id}${(await read($, bannerUp)) ? '' : ' (the banner shows during turns)'}`
    }`,
    `Ads from: ${origin}`,
    `Banner: during turns and ${BANNER_LINGER_MS / 1000}s after; none under ${BANNER_MIN_COLUMNS} columns${
      run.seen !== undefined && run.seen.columns < BANNER_MIN_COLUMNS ? ` (this terminal is ${run.seen.columns})` : ''
    }`,
    versionLine(state),
    ...(state.kind === 'current' ? [] : [AUTO_UPDATE_STEPS]),
    `Last turn: ${run.turn?.note ?? 'none yet'}`,
    ...(hides > 0 ? [`Hidden advertisers: ${hides} (✕ hides one for ${HIDE_CAMPAIGN_DAYS} days)`] : []),
    `Theater: ${run.isTheaterOn ? `on (fullscreen layout, 144+ columns, turns over 3s); last turn ${run.theaterNote}` : 'off'}`,
    ...(run.video.swapped + run.video.refused > 0
      ? [`Video: ${run.video.swapped} frames swapped, ${run.video.refused} refused${run.video.reason === undefined ? '' : ` (${run.video.reason})`}`]
      : []),
    `Impressions queued: ${queued}`,
    ...(reportsQueued > 0 ? [`Reports waiting to send: ${reportsQueued}`] : []),
    `Device: ${run.deviceId.slice(0, 8)}…`,
  ].join('\n')
}

/** A turn of the person's began: the banner comes up and its time on screen starts counting. */
async function openTurn($: EngineInterface, turnId: string) {
  const now = await $.clock.now()

  run.runningTurn = turnId
  run.lingerTimer?.cancel()
  run.lingerTimer = undefined
  run.theaterShown = undefined
  run.theaterOpen = undefined
  // A banner still up from the last turn's linger starts its stretch now.
  run.banner = noteDrawn(trackerOf(true), run.drawnBanner, now)
  await askTurn($, turnId)
  await update($, bannerUp, () => true)
  run.theaterTimer?.cancel()
  run.theaterTimer = run.isTheaterOn ? $.clock.after(THEATER_DELAY_MS, () => void openTheater($, turnId)) : undefined
}

async function closeTurn($: EngineInterface, turnId: string) {
  stopVideo()
  await stopSound($)
  run.runningTurn = undefined
  run.theaterTimer?.cancel()
  run.theaterTimer = undefined

  const at = await $.clock.now()
  // What was on screen stops counting at the turn's end; the linger after it never counts.
  const banner = longestPaid(endStretch(run.banner, at), MIN_SHOWN_MS.banner)

  run.banner = trackerOf()
  await endTheater($)

  const showing = await read($, theater)

  if (showing !== null) {
    await $.ui.close({ id: THEATER_PANE }).catch(() => undefined)
    await update($, theater, () => null)
  }

  run.lingerTimer?.cancel()
  run.lingerTimer = $.clock.after(BANNER_LINGER_MS, () => void endLinger($))

  // Only paid ads count, never house ads; nothing while paused, signed out, too old or switched off.
  if (
    !(await isSignedIn($)) ||
    (await read($, source)) === 'built-in' ||
    (await read($, pausedUntil)) !== null ||
    (await isUpdateRequired($))
  ) {
    return
  }

  const seenTheater = run.theaterShown
  const theaterShown =
    seenTheater?.turnId === turnId && !seenTheater.isHouse && seenTheater.ms >= MIN_SHOWN_MS.theater ? seenTheater : undefined
  const counted: [Impression['format'], Shown][] = [
    ...(banner === undefined ? [] : [['banner', banner] as [Impression['format'], Shown]]),
    ...(theaterShown === undefined ? [] : [['theater', theaterShown] as [Impression['format'], Shown]]),
  ]

  if (counted.length === 0) {
    return
  }

  // The turn's token may still be on its way (it waits TURN_TIMEOUT_MS at most): count once it's in, off the turn's path.
  const turn = run.turn?.turnId === turnId ? run.turn : undefined
  const surface = run.surface

  void (turn?.grant !== undefined ? Promise.resolve(turn.grant) : (turn?.pending ?? Promise.resolve(undefined))).then(grant => {
    // No token, no paid impression: the server credits none without one.
    if (grant === undefined) {
      return
    }

    return enqueue(
      $,
      counted.map(([format, shown]) => ({
        adId: shown.adId,
        ...(shown.serveToken !== undefined && { serveToken: shown.serveToken }),
        format,
        at,
        turnId,
        turnToken: grant.turnToken,
        surface,
        shownMs: Math.round(shown.ms),
      })),
    )
  })
}

async function snoozeTheater($: EngineInterface) {
  run.theaterSnoozedUntil = (await $.clock.now()) + THEATER_SNOOZE_MS
  await update($, theater, () => null)
}

/**
 * The band while signed out: one dim line in place of an ad, nothing counted. ✕ hides it
 * for the rest of the day, the same as pausing ads.
 */
function signInHint($: EngineInterface, e: RenderInput<'AbovePrompt'>, who: Exclude<Account, { kind: 'in' }>) {
  const { Box, Text, Link, Button } = $.ui.resolve(e)

  return (
    <Box width={e.props.bodyColumns} marginTop={1} flexDirection="row" gap={1}>
      <Text color={AD_YELLOW}>▚</Text>
      <Box flexGrow={1} flexShrink={1}>
        {who.kind === 'pending' ? (
          <Text wrap="truncate-end">
            Approve code <Text bold>{who.userCode}</Text> at{' '}
            <Link href={who.url}>{who.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}</Link> to start Tokenbreak.
          </Text>
        ) : (
          <Text wrap="truncate-end" dimColor>
            Tokenbreak is signed out. Run <Text bold>/ads login</Text> to show ads and earn.
          </Text>
        )}
      </Box>
      <Button key="hide" label="✕" plain dimColor onPress={() => void hideForToday($)} />
    </Box>
  )
}

/**
 * The welcome card the first sign-in shows, until the end of the next turn's
 * linger or its ✕: Tokenbreak's own, never counted.
 */
function welcomeCard($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  const { Box, Text, Link, Button } = $.ui.resolve(e)

  return (
    <Box width={e.props.bodyColumns} borderStyle="round" borderColor={AD_YELLOW} paddingX={1} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={AD_YELLOW} bold>
              ▚ Welcome to Tokenbreak.
            </Text>{' '}
            Ads show while Claude works and for {BANNER_LINGER_MS / 1000}s after.
          </Text>
        </Box>
        <Button key="hide" label="✕" plain dimColor onPress={() => void endWelcome($)} />
      </Box>
      {WELCOME_LINES.map(line =>
        line.includes('tokenbreak.dev/dashboard/earn') ? (
          <Link href={EARNINGS_URL}>
            <Text wrap="truncate-end">{line}</Text>
          </Link>
        ) : (
          <Text wrap="truncate-end">{line}</Text>
        ),
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  run = runOf(options)

  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await startSession($, e.surface)
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

    run.surface = surfaceOf(e.surface)

    const state = await read($, updateState)

    // Switched off: nothing at all, not even the sign-in hint.
    if (state.kind === 'blocked') {
      await noteBanner($, undefined)

      return next(e)
    }

    const until = await read($, pausedUntil)
    const who = await read($, account)

    if (who.kind !== 'in') {
      await noteBanner($, undefined)

      return e.props.hasSurvey || until !== null ? next(e) : signInHint($, e, who)
    }

    if (e.props.hasSurvey || until !== null) {
      await noteBanner($, undefined)

      return next(e)
    }

    if (state.kind === 'required') {
      // Too old to earn: the update notice takes the ad's place, and nothing is counted.
      const { Box, Text } = $.ui.resolve(e)

      await noteBanner($, undefined)

      return (
        <Box width={e.props.bodyColumns} marginTop={1} flexDirection="row" gap={1}>
          <Text color={AD_YELLOW}>⬆</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold>Update Tokenbreak to keep earning.</Text>
              {` Version ${state.latest} is out; you have ${MOD_VERSION}.`}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text backgroundColor={tint(AD_YELLOW, 0.22)} color={AD_YELLOW} bold>
              {' /ads update '}
            </Text>
          </Box>
        </Box>
      )
    }

    // No banner on a narrow terminal (a surface that doesn't say its width isn't held to it).
    if (e.viewport !== undefined && e.viewport.columns < BANNER_MIN_COLUMNS) {
      await noteBanner($, undefined)

      return next(e)
    }

    if (await read($, welcome)) {
      await noteBanner($, undefined)
      run.isWelcomeDrawn = true

      return welcomeCard($, e)
    }

    // The banner shows while a turn runs and for BANNER_LINGER_MS after, then hides until the next.
    if (!(await read($, bannerUp)) && !e.props.isWorking) {
      await noteBanner($, undefined)

      return next(e)
    }

    const seated = await read($, seat)
    const ad = currentBanner(
      rotationOf(await read($, ads), await read($, hidden), await $.clock.now(), seated),
      await read($, bannerIndex),
    )

    await noteBanner($, ad)

    if (ad === undefined) {
      return next(e)
    }

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
    // Only the words give way on a narrow terminal, cut with an ellipsis: everything
    // else keeps its width (flexShrink 0), so the band stays one row and every column
    // the label doesn't take goes to the headline.
    const row = (
      <Box flexDirection="row" gap={1} flexGrow={1}>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {style === 'rule' && <Text color={accent}>▎</Text>}
          {mark}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {href === undefined ? words : <Link href={href}>{words}</Link>}
        </Box>
        {action !== undefined && <Box flexShrink={0}>{action}</Box>}
        <Box flexDirection="row" gap={1} marginLeft={1} flexShrink={0}>
          <Text dimColor>{AD_LABEL}</Text>
          <Text dimColor>·</Text>
          <Button key="hide" label="✕" plain dimColor onPress={() => void hideCampaign($, ad)} />
        </Box>
      </Box>
    )

    // marginTop keeps a blank row between the banner and the spinner or transcript above it.
    const banner =
      style === 'card' ? (
        <Box width={e.props.bodyColumns} borderStyle="round" borderColor={accent} paddingX={1}>
          {row}
        </Box>
      ) : (
        <Box width={e.props.bodyColumns} marginTop={1}>
          {row}
        </Box>
      )

    // Waiting for an earning seat: house ads only, and one line saying they don't pay yet.
    return seated === 'waiting' ? (
      <Box width={e.props.bodyColumns} flexDirection="column">
        {banner}
        <Text wrap="truncate-end" dimColor>
          {WAITING_NOTICE}
        </Text>
      </Box>
    ) : (
      banner
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'tokenbreak-theater' }, async ($, e) => {
    const showing = await read($, theater)
    const list = rotationOf(await read($, ads), await read($, hidden), await $.clock.now(), await read($, seat))
    const isSoundOn = await read($, theaterSound)
    const ad = [...list, ...HOUSE_ADS].find(one => one.id === showing?.adId) ?? theaterOf(list)
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
          <Text dimColor>{AD_LABEL}</Text>
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
    // Only the turn's id is read, never its text. A subagent's run raises no turn.start:
    // every one is the person's.
    await openTurn($, e.turnId)

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
    await endTheater($)

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

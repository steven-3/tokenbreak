import type { CommandRunInput, On, RenderInput, TurnCompleteInput } from 'claude-code'
import type { mock, TestBody } from 'claude-code/testing'

import type { AdBatch } from '../types'

export const NAME = 'tokenbreak'
export const THEATER = 'tokenbreak-theater'
export const START = 1_800_000_000_000

export const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }

export const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
}

/** The band while a turn runs: the engine says so itself, and the banner shows. */
export const WORKING: RenderInput<'AbovePrompt'> = { ...BAND, props: { ...BAND.props, isWorking: true } }

export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: THEATER,
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: {
    title: 'Tokenbreak',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 44 },
    view: {},
  },
}

export const BATCH: AdBatch = {
  ads: [
    {
      id: 'acme-banner',
      format: 'banner',
      brand: 'Acme DB',
      glyph: '◆',
      headline: 'Postgres that scales to zero. Free tier forever.',
      accent: '#00C2A8',
      clickUrl: 'https://tokenbreak.dev/c/acme',
      isHouse: false,
    },
    {
      id: 'shipfast-banner',
      format: 'banner',
      brand: 'Shipfast',
      headline: 'Deploy with one command.',
      accent: '#FF5A1F',
      clickUrl: 'https://tokenbreak.dev/c/shipfast',
      isHouse: false,
    },
    {
      id: 'acme-theater',
      format: 'theater',
      brand: 'Acme DB',
      headline: 'Branch your database like your code.',
      accent: '#00C2A8',
      clickUrl: 'https://tokenbreak.dev/c/acme-theater',
      isHouse: false,
    },
  ],
  ttlSeconds: 600,
  servedAt: '2027-01-15T08:00:00.000Z',
}

/** A banner logo as the site makes it: a 36x36 four-color PNG (98 bytes), base64. */
export const LOGO_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkAQMAAADbzgrbAAAABlBMVEUaH9D/5gB1ckF/AAAAF0lEQVQI12NgIAbUH6AOyWD/gDokQQAALuAcaTWhHqAAAAAASUVORK5CYII='

/** The batch as a server that signs each serve sends it: a token on every ad but Shipfast's. */
export const SIGNED_BATCH: AdBatch = {
  ...BATCH,
  ads: BATCH.ads.map(ad => (ad.id === 'shipfast-banner' ? ad : { ...ad, serveToken: `serve.${ad.id}.sig` })),
}

export const command = (args: string): CommandRunInput => ({
  command: 'ads',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 180 },
})

export const complete = (turnId: string): TurnCompleteInput => ({
  answer: '',
  durationMs: 5_000,
  isAborted: false,
  turnId,
  reason: 'answer',
})

export type Engine = Parameters<TestBody>[0]
export type Clock = ReturnType<typeof mock.clock>

/** A turn of the person's that runs `ms`, then the 10s the server asks between one device's turns. */
export async function turn($: Engine, clock: Clock, turnId: string, ms = 2_000) {
  await $.turn.start({ text: '', turnId })
  await clock.advance(ms)
  await $.turn.complete(complete(turnId))
  await clock.settle()
  await clock.advance(10_000)
}

export type World = {
  /** The plugin's `$.store`, in memory. */
  store: Map<string, unknown>
  opened: string[]
  closed: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  commands: string[]
  fetches: { url: string; method: string; body?: string; headers?: Record<string, string> }[]
}

/** The session token a signed-in world starts with, and the one `/ads login` gets. */
export const TOKEN = 'session-token-1'
export const LOGIN = 'octocat'

export type WorldOptions = {
  /** Whether `GET /api/v1/ads` answers; false is an unreachable server. */
  isAdServerUp?: boolean
  /** Whether `POST /api/v1/impressions` answers 200. */
  isIngestUp?: boolean
  /** How many of the next pane opens the engine leaves undrawn. */
  unplaced?: number
  /** What the store holds at the start. */
  stored?: Readonly<Record<string, unknown>>
  /** The release info the ad server sends with the batch. */
  release?: { latest: string; min: string; blocked?: boolean }
  /** What `GET /api/v1/ads` serves; BATCH, with no serve tokens, unless set. */
  batch?: AdBatch
  /** The status `POST /api/v1/impressions` answers when up; 200 unless set. */
  ingestStatus?: number
  /** Whether the store starts with a session token from an earlier `/ads login`; true unless set. */
  isSignedIn?: boolean
  /** False when the site no longer honors the token: the ads and impressions APIs answer 401. */
  isTokenValid?: boolean
  /** How the site answers `/ads login`'s polls: approved after this many pending answers, or denied. */
  approval?: { after: number } | 'denied'
  /** How `POST /api/v1/turns` answers: a grant (200, the default), another status, unreachable, or never. */
  turns?: number | 'down' | 'hang'
  /** Whether `POST /api/v1/reports` answers 200; false is unreachable. */
  isReportsUp?: boolean
}

/** The grant `POST /api/v1/turns` answers its `n`th request with. */
export const grantOf = (n: number) => ({ turnId: `srv-turn-${n}`, turnToken: `turn.${n}.sig`, issuedAt: START })

/** The engine beneath the plugin, in memory: what it was asked to do, and the ad server's answers. */
export function worldOf(on: On, options: WorldOptions = {}): World {
  const { isAdServerUp = true, isIngestUp = true } = options
  let unplaced = options.unplaced ?? 0
  let pending = options.approval === undefined || options.approval === 'denied' ? 0 : options.approval.after
  let granted = 0
  const signedIn = options.isSignedIn === false ? {} : { token: TOKEN, login: LOGIN }
  const world: World = {
    store: new Map(Object.entries({ ...signedIn, ...options.stored })),
    opened: [],
    closed: [],
    statuses: [],
    toasts: [],
    commands: [],
    fetches: [],
  }

  on('store.get', ($, e) => ({ value: structuredClone(world.store.get(e.key)) }))
  on('store.set', ($, e) => {
    world.store.set(e.key, structuredClone(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    world.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...world.store.keys()] }))

  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'

    world.fetches.push({
      url: e.url,
      method,
      ...(e.init?.body !== undefined && { body: e.init.body }),
      ...(e.init?.headers !== undefined && { headers: e.init.headers }),
    })

    const json = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })
    const isAuthorized = e.init?.headers?.authorization === `Bearer ${TOKEN}` && options.isTokenValid !== false

    if (e.url.endsWith('/api/auth/device/code')) {
      return json(200, {
        device_code: 'device-code-1',
        user_code: 'WXYZ2345',
        verification_uri: 'https://tokenbreak.dev/device',
        verification_uri_complete: 'https://tokenbreak.dev/device?user_code=WXYZ2345',
        expires_in: 900,
        interval: 5,
      })
    }

    if (e.url.endsWith('/api/auth/device/token')) {
      if (options.approval === 'denied') {
        return json(400, { error: 'access_denied', error_description: 'denied' })
      }

      if (pending > 0) {
        pending -= 1

        return json(400, { error: 'authorization_pending', error_description: 'pending' })
      }

      return json(200, { access_token: TOKEN, expires_in: 2_592_000, scope: '' })
    }

    if (e.url.endsWith('/api/auth/get-session')) {
      return json(200, isAuthorized ? { user: { id: 'u1', name: 'The Octocat', githubLogin: LOGIN } } : null)
    }

    if (e.url.endsWith('/api/auth/sign-out')) {
      return json(200, { success: true })
    }

    if (e.url.includes('/api/v1/') && isAdServerUp && isIngestUp && !isAuthorized) {
      return json(401, { error: 'Sign in to show ads: run /ads login in Claude Code' })
    }

    if (e.url.endsWith('/api/v1/turns')) {
      const turns = options.turns ?? 200

      if (turns === 'hang') {
        return new Promise<never>(() => undefined)
      }

      if (turns === 'down') {
        return { deny: 'ECONNREFUSED' }
      }

      granted += 1

      return turns === 200 ? json(200, grantOf(granted)) : json(turns, { error: 'Too many turns' })
    }

    if (e.url.endsWith('/api/v1/reports')) {
      return options.isReportsUp === false ? { deny: 'ECONNREFUSED' } : json(200, { ok: true })
    }

    if (e.url.includes('/api/v1/ads')) {
      return isAdServerUp
        ? {
            value: {
              status: 200,
              ok: true,
              headers: {},
              text: JSON.stringify({ ...(options.batch ?? BATCH), ...(options.release !== undefined && { mod: options.release }) }),
            },
          }
        : { deny: 'ECONNREFUSED' }
    }

    return {
      value: !isIngestUp
        ? { status: 503, ok: false, headers: {}, text: '' }
        : options.ingestStatus === 426
          ? { status: 426, ok: false, headers: {}, text: '{"minVersion":"9.0.0","accepted":0}' }
          : { status: 200, ok: true, headers: {}, text: '{"accepted":1}' },
    }
  })

  on('command.register', ($, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } } as never
  })

  on('ui.open', ($, e) => {
    world.opened.push(e.id)

    if (unplaced > 0) {
      unplaced -= 1

      return { value: { isPlaced: false, reason: 'unasked below 144 columns' } } as never
    }

    return { value: { isPlaced: true } } as never
  })

  on('ui.close', ($, e) => {
    world.closed.push(e.id)

    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })

  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({}) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return world
}

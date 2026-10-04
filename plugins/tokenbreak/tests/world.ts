import type { CommandRunInput, On, RenderInput, TurnCompleteInput } from 'claude-code'

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

export type World = {
  /** The plugin's `$.store`, in memory. */
  store: Map<string, unknown>
  opened: string[]
  closed: string[]
  statuses: (string | undefined)[]
  commands: string[]
  fetches: { url: string; method: string; body?: string }[]
}

export type WorldOptions = {
  /** Whether `GET /api/v1/ads` answers; false is an unreachable server. */
  isAdServerUp?: boolean
  /** Whether `POST /api/v1/impressions` answers 200. */
  isIngestUp?: boolean
  /** How many of the next pane opens the engine leaves undrawn. */
  unplaced?: number
  /** What the store holds at the start. */
  stored?: Readonly<Record<string, unknown>>
}

/** The engine beneath the plugin, in memory: what it was asked to do, and the ad server's answers. */
export function worldOf(on: On, options: WorldOptions = {}): World {
  const { isAdServerUp = true, isIngestUp = true } = options
  let unplaced = options.unplaced ?? 0
  const world: World = {
    store: new Map(Object.entries(options.stored ?? {})),
    opened: [],
    closed: [],
    statuses: [],
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

    world.fetches.push({ url: e.url, method, ...(e.init?.body !== undefined && { body: e.init.body }) })

    if (e.url.includes('/api/v1/ads')) {
      return isAdServerUp
        ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(BATCH) } }
        : { deny: 'ECONNREFUSED' }
    }

    return {
      value: isIngestUp
        ? { status: 200, ok: true, headers: {}, text: '{"accepted":1}' }
        : { status: 503, ok: false, headers: {}, text: '' },
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

  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({}) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return world
}

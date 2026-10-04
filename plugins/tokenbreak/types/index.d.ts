// Tokenbreak's type contract.
//
// The wire types below mirror packages/shared/src/index.ts in the Tokenbreak
// monorepo (the API's zod schemas). A hooks module cannot import npm
// packages, so they are copied by hand: change both together.

export type AdFormat = 'status' | 'banner' | 'theater'

export type AdImage = {
  /** A whole PNG, base64; at most 2 MiB decoded (the Image element's limit). */
  png: string
  width: number
  height: number
}

export type Ad = {
  id: string
  format: AdFormat
  brand: string
  glyph?: string
  headline: string
  /** `#rrggbb` */
  accent: string
  /** Tracked click-through (`/c/<token>`), which logs and redirects. */
  clickUrl: string
  /** Theater only. */
  image?: AdImage
  isHouse: boolean
}

export type AdBatch = {
  ads: Ad[]
  ttlSeconds: number
  servedAt: string
}

export type Impression = {
  adId: string
  format: AdFormat
  /** Epoch milliseconds. */
  at: number
  turnId?: string
}

export type ImpressionBatch = {
  deviceId: string
  impressions: Impression[]
}

/** Where the ads on screen came from: the API, the store's last batch, or the module itself. */
export type AdSource = 'server' | 'cache' | 'built-in'

/** The Theater ad showing in the pane, for the turn it belongs to. */
export type TheaterShowing = {
  adId: string
  turnId: string
  isPlaced: boolean
}

declare module 'claude-code' {
  interface PluginState {
    tokenbreak: {
      ads: Ad[]
      source: AdSource
      bannerIndex: number
      pausedUntil: number | null
      theater: TheaterShowing | null
    }
  }
}

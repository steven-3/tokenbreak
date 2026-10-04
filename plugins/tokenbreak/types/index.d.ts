// Tokenbreak's type contract.
//
// The wire types below mirror packages/shared/src/index.ts in the Tokenbreak
// monorepo (the API's zod schemas). A hooks module cannot import npm
// packages, so they are copied by hand: change both together.

export type AdFormat = 'banner' | 'theater'

export type AdImage = {
  /** A whole PNG, base64; at most 2 MiB decoded (the Image element's limit). */
  png: string
  width: number
  height: number
}

/** A short loop, as PNG frames played in order. */
export type AdVideo = {
  /** Whole PNGs, base64, all the same size. */
  frames: string[]
  /**
   * Built-in ads only: absolute paths of PNG files the terminal reads itself, in
   * place of `frames`. Never taken from the ad server, which may not name files.
   */
  files?: string[]
  /** Frames a second, 1 to 30. */
  fps: number
  width: number
  height: number
}

/** An ad's sound: a URL the engine fetches, or (built-in ads only) a file the plugin ships. */
export type AdAudio = { url: string } | { asset: string }

export type Ad = {
  id: string
  format: AdFormat
  brand: string
  glyph?: string
  /**
   * Banner only: the brand's mark as a tiny PNG (36x36, at most 768 bytes), drawn in
   * two cells. Kept tiny on purpose: a picture's data can be cut off mid-send while
   * the screen redraws and spill out as text, and a small one goes in one short piece.
   */
  logo?: AdImage
  headline: string
  /** Banner only: the button's words (`Start free`); `Learn more` when absent. */
  cta?: string
  /** `#rrggbb` */
  accent: string
  /** Tracked click-through (`/c/<token>`), which logs and redirects. */
  clickUrl: string
  /** Theater only. */
  image?: AdImage
  /** Theater only: plays in place of `image` where the terminal shows pictures. */
  video?: AdVideo
  /** Theater only: cuts of the video in other shapes (9:16, 16:9, 1:1); the Theater plays the one that fills its pane best. */
  videos?: AdVideo[]
  /** Theater only: the video's sound, played only when the person presses the sound button. */
  audio?: AdAudio
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

/** How the banner is drawn: `pill` a colored call-to-action, `rule` an accent bar and an underlined link, `card` a bordered box. */
export type BannerStyle = 'pill' | 'rule' | 'card'

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
      bannerStyle: BannerStyle
      theaterSound: boolean
    }
  }
}

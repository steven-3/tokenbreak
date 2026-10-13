// Tokenbreak's type contract.
//
// The wire types below mirror packages/shared/src/index.ts in the Tokenbreak
// monorepo (the API's zod schemas). A hooks module cannot import npm
// packages, so they are copied by hand: change both together.

export type AdFormat = 'banner' | 'theater'

/** Where an ad was drawn: a terminal, or the desktop app's Code tab (text-only ads). */
export type AdSurface = 'terminal' | 'desktop'

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
  /** Paid ads only: the campaign, which `✕` hides on this machine. */
  campaignId?: string
  /**
   * Paid ads only: the server's signed receipt for this one serve, at most 512
   * characters. Each impression of the ad hands it back; house ads have none.
   */
  serveToken?: string
}

/** The mod's newest release, and the oldest that still earns. */
export type ModRelease = {
  latest: string
  min: string
  /** This build is switched off: show nothing, report nothing. */
  blocked?: boolean
}

/** Whether the account holds one of the beta's earning seats, or waits for one (house ads only). */
export type Seat = 'earning' | 'waiting'

export type AdBatch = {
  ads: Ad[]
  ttlSeconds: number
  servedAt: string
  mod?: ModRelease
  seat?: Seat
}

/** Where this build stands: current, an update out, too old to earn, or switched off by the server. */
export type UpdateState =
  | { kind: 'current' }
  | { kind: 'available'; latest: string }
  | { kind: 'required'; latest: string }
  | { kind: 'blocked'; latest: string }

export type Impression = {
  adId: string
  format: AdFormat
  /** Epoch milliseconds. */
  at: number
  turnId?: string
  /** The `serveToken` of the ad that was shown, when it had one; never another ad's. */
  serveToken?: string
  /** The server's token for the turn (`POST /api/v1/turns`). Paid impressions always carry one. */
  turnToken?: string
  /** Where the ad was drawn. */
  surface?: AdSurface
  /** The longest continuous stretch the ad was on screen during the turn, in ms. */
  shownMs?: number
}

/** `POST /api/v1/turns`, sent at the start of each of the person's turns. */
export type TurnRequest = {
  deviceId: string
  surface: AdSurface
}

/** The server's answer: a signed token naming the turn. */
export type TurnGrant = {
  turnId: string
  turnToken: string
  /** Epoch ms, the server's clock. */
  issuedAt: number
}

export type AdReportReason = 'scam' | 'misleading' | 'offensive' | 'broken' | 'other' | 'hide'

/** `POST /api/v1/reports`: `/ads report`, and `✕` (reason `hide`). */
export type AdReport = {
  adId: string
  serveToken?: string
  reason: AdReportReason
  note?: string
}

export type ImpressionBatch = {
  deviceId: string
  /** The reporting mod's version; the server credits nothing from one under its minimum. */
  modVersion?: string
  impressions: Impression[]
}

/** How the banner is drawn: `pill` a colored call-to-action, `rule` an accent bar and an underlined link, `card` a bordered box. */
export type BannerStyle = 'pill' | 'rule' | 'card'

/** Where the ads on screen came from: the API, the store's last batch, or the module itself. */
export type AdSource = 'server' | 'cache' | 'built-in'

/**
 * Who the mod is signed in as. Ads show and count only once signed in: `pending` while
 * `/ads login` waits for the code to be approved on the site.
 */
export type Account =
  | { kind: 'out' }
  | { kind: 'pending'; userCode: string; url: string }
  | { kind: 'in'; login: string }

/** The Theater ad showing in the pane, for the turn it belongs to. */
export type TheaterShowing = {
  adId: string
  /** The shown ad's `serveToken`, for the impression the turn's end counts. */
  serveToken?: string
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
      update: UpdateState
      account: Account
      /** Whether the banner may show: during a turn and for a while after it. */
      bannerUp: boolean
      /** Campaigns `✕` hid on this machine, each with when the hide ends (epoch ms). */
      hidden: Record<string, number>
      /** The account's seat, as the ad server last said; null until it says. */
      seat: Seat | null
      /** Whether the welcome card is still to be shown after the first sign-in. */
      welcome: boolean
    }
  }
}

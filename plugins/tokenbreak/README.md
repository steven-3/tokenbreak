# Tokenbreak for Claude Code

Opt-in ads in Claude Code. Tokenbreak is unofficial and not affiliated with Anthropic.

- **Prompt Banner**: a one-line ad above the prompt, a blank row above it, that rotates every 20, 40 or 90 seconds. The brand's logo (a tiny 36×36 picture, or a colored character where pictures are off) and its name and headline open the ad, beside a call-to-action button in the brand's color, a dim `sponsored` label and `✕` (hide for an hour).
- **Theater**: a pane beside the transcript while Claude works. It only opens in the fullscreen layout, at 144+ columns, once a turn has run for 3 seconds, and it closes when the turn ends. If you close it yourself, it stays away for 30 minutes. It shows the current banner brand's Theater ad when there is one. A video ad can come in several cuts (vertical, landscape); the Theater plays the one that fills the pane best, stacked over the text or beside it. A video ad's sound plays with it (macOS) unless you've muted it: the mute button silences ads and stays muted across sessions until you unmute. Sound always stops when the pane closes.
- **`/ads`**: `status`, `next`, `style [pill|rule|card]`, `pause [1h|30m|2h|today]`, `resume`, `report`.

It runs in the terminal and in the desktop app's Code tab, where ads are text only. A `claude -p` run draws nothing, so Tokenbreak stays off there and sends nothing.

## What it never does

Tokenbreak hooks no event that reads or shapes the conversation: no `prompt.compose`, `session.append`, `tool.call` or `turn.step`. It makes no call that reads files, prompts or the transcript. From `turn.start` and `turn.complete` it reads the turn's id and nothing else. `tests/privacy.test.ts` checks this against the engine's own scan of the module.

Ads never enter the model's context, so they cost you no tokens.

## What it sends

- `GET {endpoint}/api/v1/ads?formats=banner,theater` fetches ads. The request carries no identifiers.
- `POST {endpoint}/api/v1/impressions` sends `{ deviceId, impressions: [{ adId, format, at, turnId }] }` in batches of up to 200, once 20 are queued or every 5 minutes.
  - `deviceId` is a random UUID created on first run.
  - An impression is counted at most once per Claude turn, for the banner that was on screen and the Theater if it was shown.
  - Built-in house ads, which are shown when the server can't be reached, are never reported.

## Settings (`/config`)

| Field | Default | |
| --- | --- | --- |
| `endpoint` | `https://tokenbreak.dev` | Use `http://localhost:3000` while running the site locally |
| `frequency` | `normal` | `chill` 90s, `normal` 40s, `max` 20s |
| `theater` | `on` | `off` never opens the pane |
| `pictures` | `on` | Banner logos, Theater images and video; `off` keeps ads text only |
| `sound` | `on` | A video ad's sound when the Theater opens; `off` plays it only when you press the sound button |

## Install

```
/plugin marketplace add steven-3/tokenbreak
/plugin install tokenbreak@tokenbreak
```

Then turn on updates: `/plugin` → Marketplaces → tokenbreak → Enable auto-update. Claude Code leaves auto-update off for marketplaces outside Anthropic's own, and only the latest version earns.

## Updates

The ad server tells the mod its newest release and the oldest one that still earns; the mod compares them with its own version on your machine and sends nothing extra. When an update is out, you get one notice. When your version is too old to earn, the banner shows an update notice in place of ads and the mod reports nothing, and the server credits nothing from it either. `/ads update` prints the steps. Each impression report carries the mod's version.

For development: `claude --plugin-dir plugins/tokenbreak`.

## Develop

```
claude plugin validate plugins/tokenbreak
claude plugin test plugins/tokenbreak
tsc -p plugins/tokenbreak   # once Claude Code has loaded it and written .claude-plugin/types/
```

The wire types in `types/index.d.ts` mirror the ad server's API schemas. Change both together.

Built against Claude Code 2.1.288. The mod API is early access, so re-run `validate` and `test` after every Claude Code update.

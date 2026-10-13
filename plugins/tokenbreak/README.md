# Tokenbreak for Claude Code

Opt-in ads in Claude Code. Tokenbreak is unofficial and not affiliated with Anthropic.

- **Prompt Banner**: a one-line ad above the prompt, a blank row above it, that rotates every 20, 40 or 90 seconds. It shows while Claude works on a turn and for 30 seconds after the turn ends, then hides until your next prompt, so there's no ad above a prompt you're typing. Terminals under 80 columns get no banner at all. The brand's logo (a tiny 36×36 picture, or a colored character where pictures are off) and its name and headline open the ad, beside a call-to-action button in the brand's color (the advertiser's pick, `Learn more` by default), a dim `Ad` label and `✕`. On a narrow terminal only the headline gives way, cut with `…`; the band stays one row.
- **`✕`** hides that advertiser on this machine for 30 days and moves to the next ad. The hide stays in the plugin's local store with its end date, and the server gets a `hide` report (advertisers see a count). To turn every ad off, use `/ads pause`.
- **Theater**: a pane beside the transcript while Claude works. It only opens in the fullscreen layout, at 144+ columns, once a turn has run for 3 seconds, and it closes when the turn ends. If you close it yourself, it stays away for 30 minutes. It shows the current banner brand's Theater ad when there is one. A video ad can come in several cuts (vertical, landscape); the Theater plays the one that fills the pane best, stacked over the text or beside it. The Theater never plays sound.
- **`/ads`**: `login`, `logout`, `status`, `update`, `next`, `style [pill|rule|card]`, `pause [1h|30m|2h|today]`, `resume`, `report [scam|misleading|offensive|broken|other] [note]`.
  - `report` sends the paid ad on screen (or the last one that was) to Tokenbreak for a person to review, with the reason (`other` when you don't give one) and any note you type. Reports of one campaign from three developers within 7 days pause it until it's reviewed. Offline, the report waits on this machine and goes once the server can be reached.
  - `status` says whether this version is current, and how to turn on auto-update.

## Signing in

Tokenbreak shows ads only to a signed-in account. Until you run `/ads login`, the band above the prompt shows one dim line saying so (✕ hides it for the day), the Theater stays shut, and nothing is fetched or counted.

`/ads login` asks the site for a short code and prints a link. Open it, sign in with GitHub, check the code matches and approve; the mod polls the site meanwhile and picks up the session within seconds. The session token stays in the plugin's store on this machine and lasts 30 days from last use. `/ads logout` sends what's queued, ends the session on the site and forgets it. If the site stops honoring the token, the mod signs itself out.

The first sign-in on a machine opens with a welcome card in the banner's place: what `✕` does, `/ads pause`, where your earnings show (tokenbreak.dev/dashboard/earn) and how to turn on auto-update. It stays until the end of your next turn (and its 30 seconds after), or until you press its `✕`, and it never comes back on that machine. It's Tokenbreak's own card, so it pays nothing and nothing is counted.

During the launch beta only the first developers hold an earning seat. Until yours is granted, the server sends Tokenbreak's own house ads, and a line under the banner says: "You're on the list for an earning seat. Ads you see now don't pay yet." House ads are never counted.

## What it never does

Tokenbreak hooks no event that reads or shapes the conversation: no `prompt.compose`, `session.append`, `tool.call`, `tool.check` or `turn.step`. It makes no call that reads files, prompts or the transcript. From `turn.start` it reads the turn's id; from `turn.complete`, the turn's id and whether it was a subagent's (those are skipped). Nothing else. `tests/privacy.test.ts` checks this against the engine's own scan of the module, and fails if the mod ever hooks an event not on its list.

It doesn't step aside for permission prompts either. Claude Code's mod API has no event for "a dialog is open" that leaves the conversation out: the only ones (the classic `PermissionRequest` and `Notification` hooks) carry the tool's input or the prompt's text. Reading them to hide an ad would break this promise, so the mod doesn't.

Ads never enter the model's context, so they cost you no tokens.

## What it sends

Every request carries your session token as `Authorization: Bearer`. The token ties what's sent to your account. `deviceId` is a random UUID created on first run, which tells your machines apart. Nothing else about you, your code or your conversation is sent.

- `GET {endpoint}/api/v1/ads?formats=banner,theater` fetches ads, at session start and when the batch runs out (10 minutes by default). Headers: `X-Tokenbreak-Device` (the `deviceId`), `X-Tokenbreak-Version` (this build's version) and `X-Tokenbreak-Surface` (`terminal`, or `desktop` for the desktop app's Code tab).
- `POST {endpoint}/api/v1/turns` sends `{ deviceId, surface }`, with the same headers, when one of your turns starts. The server answers with a signed turn token, so it knows a real turn began and when. Paid impressions need one.
  - It never holds your turn up. It's sent in the background, and an answer later than 3 seconds is ignored.
  - A turn with no token (offline, an error, or a 429 because turns came too fast) still shows ads. It just reports nothing paid.
  - It isn't sent within 10 seconds of the last one (the server refuses those anyway), while ads are paused, or while you're waiting for an earning seat.
- `POST {endpoint}/api/v1/impressions` sends `{ deviceId, modVersion, impressions: [{ adId, format, at, turnId, serveToken, turnToken, surface, shownMs }] }`, in batches of up to 200, once 20 are queued or every 5 minutes.
  - Counted when the turn ends: at most one banner (the paid one on screen longest) and one Theater ad per turn.
  - A banner counts after 1 continuous second on screen and the Theater after 2 (the MRC display standard is one second). `shownMs` is the longest continuous stretch during the turn. The 30 seconds after a turn never count.
  - `shownMs` is what the mod itself knows: it runs from the moment the mod draws the ad until it draws something else, or the Theater from when its pane opens until it closes. The mod can't see past that: a collapsed band, a window behind another, or a screen you've walked away from all look the same to it. The server checks each impression against when it issued the turn's token.
  - `serveToken` is the server's own signed receipt for the paid ad that was shown, handed back as it came, so the server credits only ads it really served to this account and device. `turnToken` is the turn's token from above.
  - House ads (the built-in ones shown when the server can't be reached, the welcome card, and the server's own house ads) are never reported.
  - Impressions still queued after 24 hours are dropped, not sent: they earn nothing.
- `POST {endpoint}/api/v1/reports` sends `{ adId, serveToken, reason, note }`: from `/ads report` (with the reason and any note you typed), or from `✕` (reason `hide`, no note). Reports that can't be sent wait on this machine (up to 50) and go later.
- `/ads login` and `/ads logout` talk to `{endpoint}/api/auth/device/code`, `/device/token`, `/get-session` and `/sign-out`.

## Settings (`/config`)

| Field | Default | |
| --- | --- | --- |
| `endpoint` | `https://tokenbreak.dev` | Use `http://localhost:3000` while running the site locally |
| `frequency` | `normal` | `chill` 90s, `normal` 40s, `max` 20s |
| `theater` | `on` | `off` never opens the pane |
| `pictures` | `on` | Banner logos, Theater images and video; `off` keeps ads text only |

## Install

```
/plugin marketplace add steven-3/tokenbreak
/plugin install tokenbreak@tokenbreak
```

Then turn on updates: `/plugin` → **Marketplaces** → **tokenbreak** → **Enable auto-update**. Claude Code leaves auto-update off for every marketplace outside Anthropic's own. With it on, Claude Code checks within ten minutes of your first prompt in a session and installs new versions on disk. Run `/reload-plugins` to switch to the new version at once; otherwise it loads the next time you start Claude Code.

## Updates

The ad server tells the mod its newest release and the oldest one that still earns; the mod compares them with its own version on your machine and sends nothing extra. When an update is out, you get one notice. When your version is too old to earn, the banner shows an update notice in place of ads and the mod reports nothing, and the server credits nothing from it either. `/ads update` prints the steps, and `/ads status` says whether you're current. Each ad request and impression report carries the mod's version.

If a version turns out to be broken or unsafe, the server can switch it off. A switched-off version shows nothing at all and reports nothing. `/ads` keeps working and says the version has been switched off and to update.

For development: `claude --plugin-dir plugins/tokenbreak`.

## Develop

```
claude plugin validate plugins/tokenbreak
claude plugin test plugins/tokenbreak
tsc -p plugins/tokenbreak   # once Claude Code has loaded it and written .claude-plugin/types/
```

The wire types in `types/index.d.ts` mirror the ad server's API schemas. Change both together.

Built against Claude Code 2.1.292. The mod API is early access, so re-run `validate` and `test` after every Claude Code update.

# Tokenbreak

A commercial break for your tokens: opt-in ads in Claude Code that pay developers back.
Unofficial, not affiliated with Anthropic.

```
/plugin marketplace add steven-3/tokenbreak
/plugin install tokenbreak@tokenbreak
```

Then turn on updates: `/plugin` → Marketplaces → tokenbreak → Enable auto-update. Claude Code leaves auto-update off for marketplaces outside Anthropic's own, and only the latest version earns. `/ads update` shows how to update by hand.

The mod lives in [`plugins/tokenbreak`](plugins/tokenbreak). Its README covers what it shows, what it sends, and what it never touches. `plugins/tokenbreak/tests/privacy.test.ts` checks that it hooks nothing that reads your prompts, files or transcript.

Site: https://tokenbreak.dev

MIT licensed.

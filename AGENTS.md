# AGENTS.md

@WORKFLOW.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start local dev server via wrangler dev
npm run deploy   # Deploy to Cloudflare Workers via wrangler deploy
```

Secrets management:
```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put IMGUR_CLIENT_IDS   # comma-separated list, e.g. "id1,id2,id3"
```

Local dev setup: copy `.dev.vars.example` to `.dev.vars` and fill in credentials. This file is git-ignored and loaded automatically by `wrangler dev`.

## Architecture

Single-file Cloudflare Worker (`src/index.js`) with no external dependencies. The worker exposes one route: `POST /webhook`, which Telegram calls for every update.

**Request flow:**
1. Telegram sends a webhook update → `handleWebhook` → `processUpdate`
2. `processUpdate` dispatches on update type:
   - `callback_query` → `handleCallbackQuery` (button presses)
   - `message`/`channel_post` with media → `mirrorToImgur` → reply with link + inline keyboard
3. `mirrorToImgur` downloads the file from Telegram, then tries each Imgur Client ID (shuffled randomly) until one succeeds, falling back on 429 rate-limit errors.

**Delete flow (2-step confirmation):**
- First button press (`delete:<deletehash>`): edits message to show confirm/cancel buttons
- Confirm (`confirm:<deletehash>`): calls Imgur DELETE API, edits message to "Link deleted ✅"
- Cancel (`cancel:<imgurId>:<deletehash>`): restores the original message with the imgur URL and buttons

**Environment variables:**
- `TELEGRAM_BOT_TOKEN` — from BotFather
- `IMGUR_CLIENT_IDS` — comma-separated Imgur Client-IDs; requests are spread randomly across all keys with 429 fallback

The worker has no storage — the `deletehash` is embedded in the inline keyboard `callback_data` of each message, so it persists as long as the Telegram message exists.

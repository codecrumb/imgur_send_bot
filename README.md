# Imgur Send Bot

A Telegram bot that uploads images, videos, and GIFs to Imgur and replies with a direct link. Built on Cloudflare Workers — free to host, fast, and stateless.

## Features

- Upload photos, videos, GIFs, and image/video files (up to 20 MB)
- Paste a direct image/video URL and get an Imgur link back
- Copy, share, or delete uploads right from the chat
- Works in groups when tagged (`@yourbot`) or via `/upload`
- Multiple Imgur Client-IDs supported — rotated randomly with automatic 429 fallback

## How it works

1. You send the bot a photo, video, GIF, file, or image URL
2. The bot downloads it from Telegram (or passes the URL directly to Imgur)
3. Imgur hosts the file and returns a public link
4. The bot replies with the link and buttons to copy, share, or delete it

Everything runs on Cloudflare Workers — no server, no database, no state. The Imgur delete token is encoded directly in the delete button so nothing needs to be stored.

## Setup

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** you receive

### 2. Get an Imgur Client-ID

> **Note:** Imgur's app registration page (`https://api.imgur.com/oauth2/addclient`) has been intermittently broken. See [this issue](https://github.com/ShareX/ShareX/issues/8014) for workarounds if you can't access it.

1. Go to https://api.imgur.com/oauth2/addclient
2. Register an **anonymous** (non-OAuth) application
3. Copy the **Client-ID** (not the secret)

You can register multiple Client-IDs and supply them as a comma-separated list to distribute rate limits across them.

### 3. Deploy to Cloudflare Workers

```bash
npm install
npx wrangler deploy
```

Then set your secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # your bot token from BotFather
npx wrangler secret put IMGUR_CLIENT_IDS     # e.g. abc123  or  abc123,def456,ghi789
npx wrangler secret put BOT_USERNAME         # your bot's username without @, e.g. imgur_upload_bot
```

`BOT_USERNAME` is optional but required for @mention detection in groups.

### 4. Register the webhook

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/webhook"
```

### 5. Local development

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars with your values
npx wrangler dev
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `IMGUR_CLIENT_IDS` | Yes | Comma-separated Imgur Client-ID(s) |
| `BOT_USERNAME` | No | Bot username without `@` — enables @mention detection in groups |

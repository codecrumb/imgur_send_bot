/**
 * Telegram → Imgur mirror bot
 * Cloudflare Worker entry point
 *
 * Environment variables (set via `wrangler secret put` or .dev.vars):
 *   TELEGRAM_BOT_TOKEN  — from BotFather
 *   IMGUR_CLIENT_IDS    — comma-separated list of Imgur Client-IDs
 *                         e.g. "abc123,def456,ghi789"
 *                         Requests are spread randomly across all keys;
 *                         if one is rate-limited (429) the next is tried.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Telegram→Imgur bot is running.", { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  env.ctx
    ? env.ctx.waitUntil(processUpdate(update, env))
    : await processUpdate(update, env);

  return new Response("OK", { status: 200 });
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function processUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;

  // Handle /start command
  if (message.text && message.text.startsWith("/start")) {
    const username = message.from?.username
      ? `@${message.from.username}`
      : message.from?.first_name || "there";
    await sendMessage(
      chatId,
      `Hi ${username}! 👋\nSend me your images or videos, and I'll upload them to Imgur instantly.\nJust send a photo, video, GIF, or file (up to 20 MB) and I'll reply with the link!`,
      env
    );
    return;
  }

  const media = getMediaFile(message);
  if (!media) return;

  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — Telegram Bot API limit
  if (media.file_size && media.file_size > MAX_BYTES) {
    const mb = (media.file_size / (1024 * 1024)).toFixed(1);
    await sendMessage(
      chatId,
      `File too large (${mb} MB). Telegram limits bot downloads to 20 MB — please compress it and send again.`,
      env
    );
    return;
  }

  try {
    const imgurUrl = await mirrorToImgur(media.file_id, env);
    await sendMessage(chatId, imgurUrl, env, {
      inline_keyboard: [
        [{ text: "Copy Link", copy_text: { text: imgurUrl } }],
        [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(imgurUrl)}` }],
      ],
    });
  } catch (err) {
    console.error("mirrorToImgur error:", err);
    await sendMessage(chatId, `Error uploading: ${err.message}`, env);
  }
}

// Returns { file_id, file_size } for supported media types, or null.
function getMediaFile(message) {
  if (message.photo && message.photo.length > 0) {
    const p = message.photo[message.photo.length - 1];
    return { file_id: p.file_id, file_size: p.file_size };
  }
  if (message.video) {
    return { file_id: message.video.file_id, file_size: message.video.file_size };
  }
  if (message.animation) {
    return { file_id: message.animation.file_id, file_size: message.animation.file_size };
  }
  if (message.video_note) {
    return { file_id: message.video_note.file_id, file_size: message.video_note.file_size };
  }
  if (
    message.document &&
    message.document.mime_type &&
    (message.document.mime_type.startsWith("image/") ||
      message.document.mime_type.startsWith("video/"))
  ) {
    return { file_id: message.document.file_id, file_size: message.document.file_size };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

function telegramApi(method, env) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function downloadTelegramFile(fileId, env) {
  const infoRes = await fetch(
    `${telegramApi("getFile", env)}?file_id=${encodeURIComponent(fileId)}`
  );
  if (!infoRes.ok) {
    throw new Error(`getFile failed: ${infoRes.status} ${infoRes.statusText}`);
  }
  const info = await infoRes.json();
  if (!info.ok) {
    throw new Error(`getFile API error: ${JSON.stringify(info)}`);
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`File download failed: ${fileRes.status} ${fileRes.statusText}`);
  }

  // Buffer the bytes so we can retry the Imgur upload with a different key
  // if one is rate-limited.
  return fileRes.arrayBuffer();
}

async function sendMessage(chatId, text, env, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(telegramApi("sendMessage", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Imgur client-ID pool
// ---------------------------------------------------------------------------

/**
 * Returns the list of Client IDs from the environment.
 * Accepts a comma-separated IMGUR_CLIENT_IDS secret.
 */
function getClientIds(env) {
  const raw = env.IMGUR_CLIENT_IDS || "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("No Imgur Client IDs configured. Set IMGUR_CLIENT_IDS.");
  }
  return ids;
}

/**
 * Shuffles an array in-place using Fisher-Yates.
 * Starting from a random position distributes load across all keys evenly.
 */
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Imgur upload
// ---------------------------------------------------------------------------

/**
 * Downloads the Telegram file, then tries each Imgur Client ID (in random
 * order) until one succeeds.  Falls back to the next key on 429.
 */
async function mirrorToImgur(fileId, env) {
  const fileBytes = await downloadTelegramFile(fileId, env);
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const imgurRes = await fetch("https://api.imgur.com/3/image", {
      method: "POST",
      headers: {
        Authorization: `Client-ID ${clientId}`,
      },
      body: fileBytes,
    });

    const remaining = imgurRes.headers.get("X-RateLimit-ClientRemaining");
    console.log(`Imgur key …${clientId.slice(-6)}: status=${imgurRes.status} remaining=${remaining ?? "?"}`);

    if (imgurRes.status === 429) {
      lastError = new Error(`Client-ID …${clientId.slice(-6)} is rate-limited (0 remaining)`);
      continue; // try next key
    }

    if (!imgurRes.ok) {
      const errText = await imgurRes.text().catch(() => imgurRes.statusText);
      throw new Error(`Imgur upload failed (${imgurRes.status}): ${errText}`);
    }

    const imgurData = await imgurRes.json();
    if (!imgurData.success) {
      throw new Error(`Imgur API error: ${JSON.stringify(imgurData)}`);
    }

    return `https://imgur.com/${imgurData.data.id}`;
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

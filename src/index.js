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
 *   BOT_USERNAME        — (optional) bot's Telegram username without @
 *                         e.g. "imgur_send_bot"
 *                         When set, the bot only responds in groups when
 *                         mentioned (@username) or a command is used.
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
  // Handle delete button presses
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;

  // In groups, only act when the bot is explicitly addressed
  if (isGroupChat(message) && !isBotAddressed(message, env)) return;

  // Handle /upload with no media — show usage instructions
  if (message.text && message.text.toLowerCase().split("@")[0] === "/upload") {
    const inGroup = isGroupChat(message);
    const extra = inGroup
      ? `\n• Tag @${env.BOT_USERNAME || "me"} or use /upload along with your media`
      : ``;
    await sendMessage(
      chatId,
      `📸 To upload, send me:\n\n• A photo, GIF, or video (tap 📎)\n• A direct image/video URL${extra}\n\nSupported: JPG, PNG, GIF, WebP, MP4, WebM, MOV (up to 20 MB)`,
      env
    );
    return;
  }

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

  // Handle plain URL messages (e.g. https://example.com/photo.jpg)
  const imageUrl = getMediaUrl(message);
  if (imageUrl) {
    const [result, statusMsg] = await Promise.all([
      mirrorUrlToImgur(imageUrl, env).catch((err) => err),
      sendMessage(chatId, "⬆️ Uploading...", env),
    ]);
    if (result instanceof Error) {
      console.error("mirrorUrlToImgur error:", result);
      await editMessageText(chatId, statusMsg.message_id, `Error uploading: ${result.message}`, env);
    } else {
      const { url: imgurUrl, deletehash } = result;
      await editMessageText(chatId, statusMsg.message_id, imgurUrl, env, {
        inline_keyboard: [
          [{ text: "Copy Link", copy_text: { text: imgurUrl } }],
          [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(imgurUrl)}` }],
          [{ text: "🗑️ Delete", callback_data: `delete:${deletehash}` }],
        ],
      });
    }
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

  const [result, statusMsg] = await Promise.all([
    mirrorToImgur(media.file_id, env).catch((err) => err),
    sendMessage(chatId, "⬆️ Uploading...", env),
  ]);
  if (result instanceof Error) {
    console.error("mirrorToImgur error:", result);
    await editMessageText(chatId, statusMsg.message_id, `Error uploading: ${result.message}`, env);
  } else {
    const { url: imgurUrl, deletehash } = result;
    await editMessageText(chatId, statusMsg.message_id, imgurUrl, env, {
      inline_keyboard: [
        [{ text: "Copy Link", copy_text: { text: imgurUrl } }],
        [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(imgurUrl)}` }],
        [{ text: "🗑️ Delete", callback_data: `delete:${deletehash}` }],
      ],
    });
  }
}

async function handleCallbackQuery(query, env) {
  const { id: queryId, message, data } = query;

  if (!data) {
    await answerCallbackQuery(queryId, env);
    return;
  }

  // Step 1: first tap on delete — ask for confirmation
  if (data.startsWith("delete:")) {
    const deletehash = data.slice("delete:".length);
    const imgurId = message.text?.split("/").pop() ?? "";
    await Promise.all([
      editMessageText(
        message.chat.id,
        message.message_id,
        "Are you sure you want to delete this image?",
        env,
        {
          inline_keyboard: [
            [{ text: "✅ Yes, delete", callback_data: `confirm:${deletehash}` }],
            [{ text: "↩️ Cancel", callback_data: `cancel:${imgurId}:${deletehash}` }],
          ],
        }
      ),
      answerCallbackQuery(queryId, env),
    ]);
    return;
  }

  // Step 2a: confirmed — delete and mark as deleted
  if (data.startsWith("confirm:")) {
    const deletehash = data.slice("confirm:".length);
    try {
      await deleteFromImgur(deletehash, env);
    } catch (err) {
      console.error("deleteFromImgur error:", err);
    }
    await Promise.all([
      editMessageText(message.chat.id, message.message_id, "Link deleted ✅", env),
      answerCallbackQuery(queryId, env),
    ]);
    return;
  }

  // Step 2b: cancelled — restore original message
  if (data.startsWith("cancel:")) {
    const [imgurId, deletehash] = data.slice("cancel:".length).split(":");
    const imgurUrl = `https://imgur.com/${imgurId}`;
    await Promise.all([
      editMessageText(message.chat.id, message.message_id, imgurUrl, env, {
        inline_keyboard: [
          [{ text: "Copy Link", copy_text: { text: imgurUrl } }],
          [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(imgurUrl)}` }],
          [{ text: "🗑️ Delete", callback_data: `delete:${deletehash}` }],
        ],
      }),
      answerCallbackQuery(queryId, env),
    ]);
    return;
  }

  await answerCallbackQuery(queryId, env);
}

function isGroupChat(message) {
  return message.chat.type === "group" || message.chat.type === "supergroup";
}

function isBotAddressed(message, env) {
  const entities = message.entities || message.caption_entities || [];
  const text = message.text || message.caption || "";
  for (const e of entities) {
    if (e.type === "bot_command") {
      const cmd = text.slice(e.offset, e.offset + e.length).toLowerCase().split("@")[0];
      if (cmd === "/upload") return true;
    }
    if (e.type === "mention" && env.BOT_USERNAME) {
      const mentioned = text.slice(e.offset, e.offset + e.length);
      if (mentioned.toLowerCase() === `@${env.BOT_USERNAME.toLowerCase()}`) return true;
    }
  }
  return false;
}

// Returns the URL if the message is a single bare http(s) URL, else null.
function getMediaUrl(message) {
  const text = message.text?.trim();
  if (!text || text.includes(" ")) return null;
  try {
    const u = new URL(text);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return text;
  } catch {
    return null;
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
  const res = await fetch(telegramApi("sendMessage", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.result;
}

async function editMessageText(chatId, messageId, text, env, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(telegramApi("editMessageText", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answerCallbackQuery(callbackQueryId, env) {
  await fetch(telegramApi("answerCallbackQuery", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
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

    return {
      url: imgurData.data.link,
      deletehash: imgurData.data.deletehash,
    };
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

// Uploads an image by URL directly — Imgur fetches it server-side, no download needed.
async function mirrorUrlToImgur(imageUrl, env) {
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const imgurRes = await fetch("https://api.imgur.com/3/image", {
      method: "POST",
      headers: {
        Authorization: `Client-ID ${clientId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image: imageUrl, type: "url" }),
    });

    const remaining = imgurRes.headers.get("X-RateLimit-ClientRemaining");
    console.log(`Imgur key …${clientId.slice(-6)}: status=${imgurRes.status} remaining=${remaining ?? "?"}`);

    if (imgurRes.status === 429) {
      lastError = new Error(`Client-ID …${clientId.slice(-6)} is rate-limited (0 remaining)`);
      continue;
    }

    if (!imgurRes.ok) {
      const errText = await imgurRes.text().catch(() => imgurRes.statusText);
      throw new Error(`Imgur upload failed (${imgurRes.status}): ${errText}`);
    }

    const imgurData = await imgurRes.json();
    if (!imgurData.success) {
      throw new Error(`Imgur API error: ${JSON.stringify(imgurData)}`);
    }

    return {
      url: imgurData.data.link,
      deletehash: imgurData.data.deletehash,
    };
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

async function deleteFromImgur(deletehash, env) {
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const res = await fetch(`https://api.imgur.com/3/image/${deletehash}`, {
      method: "DELETE",
      headers: { Authorization: `Client-ID ${clientId}` },
    });

    if (res.status === 429) {
      lastError = new Error(`Client-ID …${clientId.slice(-6)} is rate-limited (0 remaining)`);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Imgur delete failed (${res.status}): ${errText}`);
    }

    return;
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

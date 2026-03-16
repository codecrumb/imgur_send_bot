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
 *
 * KV namespace (wrangler.toml):
 *   MEDIA_GROUPS        — used to collect media group files before album upload
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Telegram→Imgur bot is running.", { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // Await the fast prep phase; it returns a deferred promise if background work is needed.
  const deferred = await processUpdate(update, env);
  if (deferred && ctx) ctx.waitUntil(deferred);

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
      `Hi ${username}! 👋\n\nSend me a photo, video, GIF, or image URL and I'll upload it to Imgur.\nYou'll get a shareable link instantly.\n\nSupported:\n• JPG, PNG, GIF, WebP\n• MP4, WebM, MOV\n• Direct image/video URLs\n\nMax size: 20 MB\nUploads are anonymous.`,
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
      await editMessageText(chatId, statusMsg.message_id, `❌ ${formatUploadError(result)}`, env, null, "HTML");
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

  // Branch on media_group_id — collect and upload as album.
  // Returns the deferred promise so handleWebhook can register it with ctx.waitUntil
  // at the top level (nested waitUntil is not reliable in CF Workers).
  if (message.media_group_id) {
    return handleMediaGroup(message, media, env);
  }

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
    await editMessageText(chatId, statusMsg.message_id, `❌ ${formatUploadError(result)}`, env, null, "HTML");
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
    const msgText = message.text || "";
    const isAlbum = msgText.includes("imgur.com/a/");

    let itemId;
    if (isAlbum) {
      const match = msgText.match(/imgur\.com\/a\/([A-Za-z0-9]+)/);
      itemId = match ? match[1] : "";
    } else {
      itemId = msgText.split("/").pop() ?? "";
    }

    const confirmData = isAlbum ? `confirm:album:${deletehash}` : `confirm:img:${deletehash}`;
    const cancelData = isAlbum ? `cancel:a:${itemId}:${deletehash}` : `cancel:i:${itemId}:${deletehash}`;
    const question = isAlbum
      ? "Are you sure you want to delete this album?"
      : "Are you sure you want to delete this image?";

    await Promise.all([
      editMessageText(
        message.chat.id,
        message.message_id,
        question,
        env,
        {
          inline_keyboard: [
            [{ text: "✅ Yes, delete", callback_data: confirmData }],
            [{ text: "↩️ Cancel", callback_data: cancelData }],
          ],
        }
      ),
      answerCallbackQuery(queryId, env),
    ]);
    return;
  }

  // Step 2a: confirmed — delete and mark as deleted
  if (data.startsWith("confirm:")) {
    const rest = data.slice("confirm:".length);
    let deletehash;
    let isAlbum = false;

    if (rest.startsWith("album:")) {
      isAlbum = true;
      deletehash = rest.slice("album:".length);
    } else if (rest.startsWith("img:")) {
      deletehash = rest.slice("img:".length);
    } else {
      // Legacy format: confirm:{deletehash}
      deletehash = rest;
    }

    try {
      if (isAlbum) {
        await deleteAlbumFromImgur(deletehash, env);
      } else {
        await deleteFromImgur(deletehash, env);
      }
    } catch (err) {
      console.error("delete error:", err);
    }
    await Promise.all([
      editMessageText(message.chat.id, message.message_id, "Deleted ✅", env),
      answerCallbackQuery(queryId, env),
    ]);
    return;
  }

  // Step 2b: cancelled — restore original message
  if (data.startsWith("cancel:")) {
    const rest = data.slice("cancel:".length);
    const parts = rest.split(":");

    let imgurUrl, deletehash;
    if (parts.length >= 3) {
      // New format: type:id:hash
      const [type, id, hash] = parts;
      deletehash = hash;
      imgurUrl = type === "a" ? `https://imgur.com/a/${id}` : `https://imgur.com/${id}`;
    } else {
      // Legacy format: id:hash
      const [id, hash] = parts;
      deletehash = hash;
      imgurUrl = `https://imgur.com/${id}`;
    }

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

// ---------------------------------------------------------------------------
// Media group (album) handling
// ---------------------------------------------------------------------------

async function handleMediaGroup(message, media, env) {
  const groupId = message.media_group_id;
  const chatId = message.chat.id;

  let group = await kvGetGroup(groupId, env);

  if (!group) {
    // First item: send status message and init KV entry
    const statusMsg = await sendMessage(chatId, "⬆️ Uploading...", env);
    if (!statusMsg?.message_id) return;
    group = {
      chatId,
      statusMsgId: statusMsg.message_id,
      firstSeen: Date.now(),
      fileIds: [media.file_id],
      processed: false,
    };
  } else {
    // Subsequent items: append file_id
    group.fileIds.push(media.file_id);
  }

  await kvPutGroup(groupId, group, env);

  // Start deferred processing and return the promise.
  // The caller (handleWebhook) registers it with ctx.waitUntil before responding.
  return (async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const latest = await kvGetGroup(groupId, env);
    if (!latest || latest.processed) return;

    latest.processed = true;
    await kvPutGroup(groupId, latest, env);

    await processMediaGroup(latest, groupId, env);
  })();
}

async function processMediaGroup(group, groupId, env) {
  try {
    const imageIds = [];
    for (const fileId of group.fileIds) {
      try {
        const { id } = await mirrorToImgurRaw(fileId, env);
        imageIds.push(id);
      } catch (err) {
        console.error(`Failed to upload fileId ${fileId}:`, err);
      }
    }

    if (imageIds.length === 0) {
      await editMessageText(
        group.chatId,
        group.statusMsgId,
        "❌ All uploads failed. Please try again.",
        env
      );
      return;
    }

    let albumId, deletehash;
    try {
      ({ id: albumId, deletehash } = await createImgurAlbum(imageIds, env));
    } catch (err) {
      console.error("createImgurAlbum error:", err);
      await editMessageText(group.chatId, group.statusMsgId, `❌ ${formatUploadError(err)}`, env, null, "HTML");
      return;
    }
    const albumUrl = `https://imgur.com/a/${albumId}`;

    await editMessageText(group.chatId, group.statusMsgId, albumUrl, env, {
      inline_keyboard: [
        [{ text: "Copy Link", copy_text: { text: albumUrl } }],
        [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(albumUrl)}` }],
        [{ text: "🗑️ Delete", callback_data: `delete:${deletehash}` }],
      ],
    });
  } finally {
    await kvDeleteGroup(groupId, env);
  }
}

// ---------------------------------------------------------------------------
// KV helpers for media group state
// ---------------------------------------------------------------------------

async function kvGetGroup(groupId, env) {
  if (!env.MEDIA_GROUPS) return null;
  const val = await env.MEDIA_GROUPS.get(`mg:${groupId}`);
  return val ? JSON.parse(val) : null;
}

async function kvPutGroup(groupId, data, env) {
  if (!env.MEDIA_GROUPS) return;
  await env.MEDIA_GROUPS.put(`mg:${groupId}`, JSON.stringify(data), { expirationTtl: 30 });
}

async function kvDeleteGroup(groupId, env) {
  if (!env.MEDIA_GROUPS) return;
  await env.MEDIA_GROUPS.delete(`mg:${groupId}`);
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

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

async function editMessageText(chatId, messageId, text, env, replyMarkup, parseMode) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
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
// Error helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUploadError(err) {
  const friendly = escapeHtml(err.message);
  if (!err.details) return friendly;
  return `${friendly} <tg-spoiler>${escapeHtml(err.details)}</tg-spoiler>`;
}

// Transient errors worth retrying with a different key.
function isTransient(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// Human-friendly upload error shown to the user.
function uploadErrorMessage(status, imgurError) {
  if (imgurError) return imgurError;
  if (status === 429) return "Imgur is rate-limiting us right now. Try again in a moment.";
  if (status === 413) return "File too large for Imgur (max 20 MB).";
  if (status >= 500) return "Imgur is having issues right now. Try again in a moment.";
  return `Upload failed (${status}). Please try again.`;
}

// ---------------------------------------------------------------------------
// Imgur upload
// ---------------------------------------------------------------------------

/**
 * Downloads the Telegram file and uploads to Imgur.
 * Returns { id, deletehash } — no URL construction here.
 */
async function mirrorToImgurRaw(fileId, env) {
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

    if (isTransient(imgurRes.status)) {
      lastError = new Error(uploadErrorMessage(imgurRes.status));
      continue; // try next key
    }

    const rawBody = await imgurRes.text().catch(() => "");
    const imgurData = rawBody ? JSON.parse(rawBody) : null;
    const imgurError = imgurData?.data?.error;

    if (!imgurRes.ok || !imgurData?.success) {
      const err = new Error(uploadErrorMessage(imgurRes.status, imgurError));
      err.details = rawBody;
      throw err;
    }

    return {
      id: imgurData.data.id,
      deletehash: imgurData.data.deletehash,
    };
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

async function mirrorToImgur(fileId, env) {
  const { id, deletehash } = await mirrorToImgurRaw(fileId, env);
  return { url: `https://imgur.com/${id}`, deletehash };
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

    if (isTransient(imgurRes.status)) {
      lastError = new Error(uploadErrorMessage(imgurRes.status));
      continue;
    }

    const rawBody = await imgurRes.text().catch(() => "");
    const imgurData = rawBody ? JSON.parse(rawBody) : null;
    const imgurError = imgurData?.data?.error;

    if (!imgurRes.ok || !imgurData?.success) {
      const err = new Error(uploadErrorMessage(imgurRes.status, imgurError));
      err.details = rawBody;
      throw err;
    }

    return {
      url: `https://imgur.com/${imgurData.data.id}`,
      deletehash: imgurData.data.deletehash,
    };
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

async function createImgurAlbum(imageIds, env) {
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const imgurRes = await fetch("https://api.imgur.com/3/album", {
      method: "POST",
      headers: {
        Authorization: `Client-ID ${clientId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: imageIds }),
    });

    const remaining = imgurRes.headers.get("X-RateLimit-ClientRemaining");
    console.log(`Imgur key …${clientId.slice(-6)}: status=${imgurRes.status} remaining=${remaining ?? "?"}`);

    if (isTransient(imgurRes.status)) {
      lastError = new Error(uploadErrorMessage(imgurRes.status));
      continue;
    }

    const rawBody = await imgurRes.text().catch(() => "");
    const imgurData = rawBody ? JSON.parse(rawBody) : null;
    const imgurError = imgurData?.data?.error;

    if (!imgurRes.ok || !imgurData?.success) {
      const err = new Error(uploadErrorMessage(imgurRes.status, imgurError));
      err.details = rawBody;
      throw err;
    }

    return {
      id: imgurData.data.id,
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

    if (isTransient(res.status)) {
      lastError = new Error(`Delete failed (${res.status}), retrying...`);
      continue;
    }

    if (!res.ok) {
      throw new Error("Couldn't delete the image. Try again later.");
    }

    return;
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

async function deleteAlbumFromImgur(deletehash, env) {
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const res = await fetch(`https://api.imgur.com/3/album/${deletehash}`, {
      method: "DELETE",
      headers: { Authorization: `Client-ID ${clientId}` },
    });

    if (isTransient(res.status)) {
      lastError = new Error(`Delete failed (${res.status}), retrying...`);
      continue;
    }

    if (!res.ok) {
      throw new Error("Couldn't delete the album. Try again later.");
    }

    return;
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

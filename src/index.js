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
 * KV namespace (bound in wrangler.toml):
 *   IMGUR_BOT_MEDIA_GROUPS — stores per-photo keys for multi-photo albums
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

  const deferreds = [];
  await processUpdate(update, env, deferreds);

  for (const d of deferreds) {
    ctx.waitUntil(d);
  }

  return new Response("OK", { status: 200 });
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function processUpdate(update, env, deferreds) {
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

  // Multi-photo send — collect and create an album
  if (message.media_group_id) {
    await handleMediaGroup(message, media, env, deferreds);
    return;
  }

  // Single file upload
  const MAX_BYTES = 20 * 1024 * 1024;
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

// ---------------------------------------------------------------------------
// Media group (album) handler
// ---------------------------------------------------------------------------

async function handleMediaGroup(message, media, env, deferreds) {
  const groupId = message.media_group_id;
  const chatId = message.chat.id;

  if (!env.IMGUR_BOT_MEDIA_GROUPS) {
    console.error("IMGUR_BOT_MEDIA_GROUPS KV binding is missing");
    return;
  }

  const MAX_BYTES = 20 * 1024 * 1024;
  if (media.file_size && media.file_size > MAX_BYTES) {
    console.log(`Skipping oversized file ${media.file_id} in group ${groupId}`);
    return;
  }

  // Write one key per file — independent writes, no race conflicts
  const kvKey = `mg:${groupId}:${media.file_id}`;
  await env.IMGUR_BOT_MEDIA_GROUPS.put(
    kvKey,
    JSON.stringify({ chatId, fileId: media.file_id }),
    { expirationTtl: 60 }
  );

  // Push a deferred — handleWebhook will register it with ctx.waitUntil
  // before returning "OK" to Telegram.
  deferreds.push((async () => {
    try {
      // Wait for Telegram to deliver all photos in the group.
      // Random jitter (0–300ms) staggers simultaneous deferreds to reduce lock races.
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 300));

      const lockKey = `mg:${groupId}:_lock`;

      // Write-then-verify lock: every deferred writes its own UUID (last-writer-wins),
      // waits 500ms for KV to settle on one value, then reads back.
      // Only the deferred whose UUID survived the race proceeds.
      const myLockId = crypto.randomUUID();
      await env.IMGUR_BOT_MEDIA_GROUPS.put(lockKey, myLockId, { expirationTtl: 60 });
      await new Promise((r) => setTimeout(r, 500));
      const lockWinner = await env.IMGUR_BOT_MEDIA_GROUPS.get(lockKey);
      if (lockWinner !== myLockId) {
        console.log(`mg:${groupId}: lost lock, exiting`);
        return;
      }
      console.log(`mg:${groupId}: won lock`);

      try {
        // List all per-file keys for this group.
        // KV list() has eventual consistency lag — if it misses our own key,
        // add it explicitly via the closure-captured kvKey.
        const listed = await env.IMGUR_BOT_MEDIA_GROUPS.list({ prefix: `mg:${groupId}:` });
        console.log(`mg:${groupId}: list returned ${listed.keys.length} keys`);

        let fileKeys = listed.keys.filter((k) => !k.name.endsWith(":_lock"));

        if (!fileKeys.some((k) => k.name === kvKey)) {
          console.log(`mg:${groupId}: own key missing from list, adding via closure`);
          fileKeys = [{ name: kvKey }, ...fileKeys];
        }

        console.log(`mg:${groupId}: ${fileKeys.length} file key(s) to process`);

        if (fileKeys.length === 0) {
          console.log(`mg:${groupId}: no files found, aborting`);
          return;
        }

        const fileDataList = await Promise.all(
          fileKeys.map((k) => env.IMGUR_BOT_MEDIA_GROUPS.get(k.name, { type: "json" }))
        );
        const files = fileDataList.filter(Boolean);
        console.log(`mg:${groupId}: ${files.length} file record(s) fetched`);

        if (files.length === 0) {
          console.log(`mg:${groupId}: all gets returned null, aborting`);
          return;
        }

        const statusMsg = await sendMessage(chatId, "⬆️ Uploading...", env);

        // Upload each file, collect { id, deletehash }
        const uploaded = [];
        for (const f of files) {
          try {
            const result = await mirrorToImgurRaw(f.fileId, env);
            uploaded.push(result);
            console.log(`mg:${groupId}: uploaded ${f.fileId} → ${result.id}`);
          } catch (err) {
            console.error(`mg:${groupId}: upload failed for ${f.fileId}:`, err.message);
          }
        }

        if (uploaded.length === 0) {
          await editMessageText(chatId, statusMsg.message_id, "❌ Failed to upload any images.", env, null, "HTML");
          return;
        }

        // Only one image — treat as single upload
        if (uploaded.length === 1) {
          const { id, deletehash } = uploaded[0];
          const imgurUrl = `https://imgur.com/${id}`;
          await editMessageText(chatId, statusMsg.message_id, imgurUrl, env, {
            inline_keyboard: [
              [{ text: "Copy Link", copy_text: { text: imgurUrl } }],
              [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(imgurUrl)}` }],
              [{ text: "🗑️ Delete", callback_data: `delete:${deletehash}` }],
            ],
          });
          return;
        }

        // Create an album from all uploaded images
        try {
          const deletehashes = uploaded.map((r) => r.deletehash);
          const album = await createImgurAlbum(deletehashes, env);
          const albumUrl = `https://imgur.com/a/${album.id}`;
          console.log(`mg:${groupId}: album created → ${album.id}`);
          await editMessageText(chatId, statusMsg.message_id, albumUrl, env, {
            inline_keyboard: [
              [{ text: "Copy Link", copy_text: { text: albumUrl } }],
              [{ text: "Share", url: `https://t.me/share/url?url=${encodeURIComponent(albumUrl)}` }],
              [{ text: "🗑️ Delete", callback_data: `delete:${album.deletehash}` }],
            ],
          });
        } catch (err) {
          console.error(`mg:${groupId}: createImgurAlbum error:`, err.message);
          // Fallback: post individual links
          const links = uploaded.map((r) => `https://imgur.com/${r.id}`).join("\n");
          await editMessageText(chatId, statusMsg.message_id, links, env);
        }
      } finally {
        // Clean up all KV keys for this group
        const toDelete = await env.IMGUR_BOT_MEDIA_GROUPS.list({ prefix: `mg:${groupId}:` });
        await Promise.all(toDelete.keys.map((k) => env.IMGUR_BOT_MEDIA_GROUPS.delete(k.name)));
        console.log(`mg:${groupId}: cleaned up ${toDelete.keys.length} key(s)`);
      }
    } catch (err) {
      console.error(`mg:${groupId}: deferred crashed:`, err.message, err.stack);
    }
  })());
}

// ---------------------------------------------------------------------------
// Callback query handler
// ---------------------------------------------------------------------------

async function handleCallbackQuery(query, env) {
  const { id: queryId, message, data } = query;

  if (!data) {
    await answerCallbackQuery(queryId, env);
    return;
  }

  // Step 1: first tap on delete — ask for confirmation
  if (data.startsWith("delete:")) {
    const deletehash = data.slice("delete:".length);
    const msgText = message.text ?? "";
    const isAlbum = msgText.includes("imgur.com/a/");
    const imgurId = msgText.split("/").pop() ?? "";
    await Promise.all([
      editMessageText(
        message.chat.id,
        message.message_id,
        isAlbum
          ? "Are you sure you want to delete this album?"
          : "Are you sure you want to delete this image?",
        env,
        {
          inline_keyboard: [
            [{ text: "✅ Yes, delete", callback_data: `confirm:${isAlbum ? "album" : "img"}:${deletehash}` }],
            [{ text: "↩️ Cancel", callback_data: `cancel:${isAlbum ? "a" : "i"}:${imgurId}:${deletehash}` }],
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
      // Legacy: confirm:{deletehash}
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
    let imgurUrl, deletehash;

    if (rest.startsWith("a:")) {
      // cancel:a:{id}:{hash} — album
      const parts = rest.slice("a:".length).split(":");
      imgurUrl = `https://imgur.com/a/${parts[0]}`;
      deletehash = parts[1];
    } else if (rest.startsWith("i:")) {
      // cancel:i:{id}:{hash} — image
      const parts = rest.slice("i:".length).split(":");
      imgurUrl = `https://imgur.com/${parts[0]}`;
      deletehash = parts[1];
    } else {
      // Legacy: cancel:{imgurId}:{deletehash}
      const [imgurId, dh] = rest.split(":");
      imgurUrl = `https://imgur.com/${imgurId}`;
      deletehash = dh;
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
// Helpers
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

function getClientIds(env) {
  const raw = env.IMGUR_CLIENT_IDS || "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("No Imgur Client IDs configured. Set IMGUR_CLIENT_IDS.");
  }
  return ids;
}

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

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUploadError(err) {
  const friendly = escapeHtml(err.message);
  if (!err.details) return friendly;
  return `${friendly} <tg-spoiler>${escapeHtml(err.details)}</tg-spoiler>`;
}

function isTransient(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function uploadErrorMessage(status, imgurError) {
  if (imgurError) return imgurError;
  if (status === 429) return "Imgur is rate-limiting us right now. Try again in a moment.";
  if (status === 413) return "File too large for Imgur (max 20 MB).";
  if (status >= 500) return "Imgur is having issues right now. Try again in a moment.";
  return `Upload failed (${status}). Please try again.`;
}

// Uploads a Telegram file to Imgur, returns { id, deletehash }.
async function mirrorToImgurRaw(fileId, env) {
  const fileBytes = await downloadTelegramFile(fileId, env);
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const imgurRes = await fetch("https://api.imgur.com/3/image", {
      method: "POST",
      headers: { Authorization: `Client-ID ${clientId}` },
      body: fileBytes,
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

    return { id: imgurData.data.id, deletehash: imgurData.data.deletehash };
  }

  throw lastError ?? new Error("All Imgur Client IDs exhausted");
}

// Wraps mirrorToImgurRaw, adding the full URL (used by single-file flow).
async function mirrorToImgur(fileId, env) {
  const { id, deletehash } = await mirrorToImgurRaw(fileId, env);
  return { url: `https://imgur.com/${id}`, deletehash };
}

// Uploads an image by URL directly — Imgur fetches it server-side.
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

// Creates an anonymous Imgur album from an array of deletehashes.
async function createImgurAlbum(deletehashes, env) {
  const clientIds = shuffled(getClientIds(env));

  let lastError;
  for (const clientId of clientIds) {
    const imgurRes = await fetch("https://api.imgur.com/3/album", {
      method: "POST",
      headers: {
        Authorization: `Client-ID ${clientId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deletehashes }),
    });

    const remaining = imgurRes.headers.get("X-RateLimit-ClientRemaining");
    console.log(`createImgurAlbum key …${clientId.slice(-6)}: status=${imgurRes.status} remaining=${remaining ?? "?"}`);

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

    return { id: imgurData.data.id, deletehash: imgurData.data.deletehash };
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

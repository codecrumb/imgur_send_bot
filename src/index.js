/**
 * Telegram → Imgur mirror bot
 * Cloudflare Worker entry point
 *
 * Environment variables (set via `wrangler secret put` or .dev.vars):
 *   TELEGRAM_BOT_TOKEN  — from BotFather
 *   IMGUR_CLIENT_ID     — from https://api.imgur.com/oauth2/addclient (anonymous upload)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    // Health-check / accidental GET
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

  // Telegram only cares that we respond quickly; do the heavy work async.
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
  const fileId = getImageFileId(message);

  if (!fileId) return; // not a photo/image — ignore silently

  try {
    const imgurUrl = await mirrorToImgur(fileId, env);
    await sendMessage(chatId, imgurUrl, env);
  } catch (err) {
    console.error("mirrorToImgur error:", err);
    await sendMessage(chatId, `Error uploading image: ${err.message}`, env);
  }
}

/**
 * Returns the best file_id from the message, or null if there is no image.
 * Handles:
 *  - message.photo  (compressed Telegram photo — picks highest resolution)
 *  - message.document with an image MIME type (uncompressed "Send as file")
 */
function getImageFileId(message) {
  if (message.photo && message.photo.length > 0) {
    // photo array is sorted ascending by size; last element is largest.
    return message.photo[message.photo.length - 1].file_id;
  }

  if (
    message.document &&
    message.document.mime_type &&
    message.document.mime_type.startsWith("image/")
  ) {
    return message.document.file_id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

function telegramApi(method, env) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Resolves a file_id → downloadable URL, then returns the raw bytes.
 */
async function downloadTelegramFile(fileId, env) {
  // Step 1: getFile → file_path
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

  const filePath = info.result.file_path;

  // Step 2: download raw bytes
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(
      `File download failed: ${fileRes.status} ${fileRes.statusText}`
    );
  }

  return fileRes; // caller streams the body to Imgur
}

async function sendMessage(chatId, text, env) {
  await fetch(telegramApi("sendMessage", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ---------------------------------------------------------------------------
// Imgur upload
// ---------------------------------------------------------------------------

/**
 * Downloads the Telegram file and uploads it to Imgur anonymously.
 * Returns the direct i.imgur.com URL.
 */
async function mirrorToImgur(fileId, env) {
  const telegramFileRes = await downloadTelegramFile(fileId, env);

  // Stream the file body directly into the Imgur request to avoid buffering.
  const imgurRes = await fetch("https://api.imgur.com/3/image", {
    method: "POST",
    headers: {
      Authorization: `Client-ID ${env.IMGUR_CLIENT_ID}`,
      // No Content-Type — let fetch set it for the raw binary body.
    },
    body: telegramFileRes.body,
    // duplex is required in some runtimes when body is a ReadableStream
    duplex: "half",
  });

  if (!imgurRes.ok) {
    const errText = await imgurRes.text().catch(() => imgurRes.statusText);
    throw new Error(`Imgur upload failed (${imgurRes.status}): ${errText}`);
  }

  const imgurData = await imgurRes.json();
  if (!imgurData.success) {
    throw new Error(`Imgur API error: ${JSON.stringify(imgurData)}`);
  }

  return imgurData.data.link; // e.g. https://i.imgur.com/abc123.png
}

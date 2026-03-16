# Album Feature Plan

## What We're Building

Telegram sends each photo in a multi-photo send as a **separate webhook update**, all sharing the same `media_group_id`. The goal is to:
1. Collect all photos from the same group
2. Upload each to Imgur
3. Create an Imgur album containing all of them
4. Reply once with the album link + Copy/Share/Delete buttons

---

## Current Branch State

- **`main`** — reverted to last working single-photo bot (`fc58388`). Production is stable.
- **`album-feature`** — all album work lives here. Not production-ready yet.

---

## What We Built (album-feature)

### KV Schema
Each webhook invocation writes its own key to avoid write conflicts:
```
mg:{groupId}:{fileId}  →  { chatId }       (one per photo, TTL 30s)
mg:{groupId}:_lock     →  "1"              (written by the winning deferred)
```

### Flow
1. Telegram sends N webhook updates (one per photo), all with the same `media_group_id`
2. Each invocation writes `mg:{groupId}:{fileId}` to KV — independent keys, no conflicts
3. Each invocation pushes a deferred into `deferreds[]`; `handleWebhook` registers them all with `ctx.waitUntil` **before** returning "OK" to Telegram
4. After 2s (to collect stragglers), each deferred tries to write `mg:{groupId}:_lock`
5. First deferred to write the lock wins; others see the lock and exit early
6. Winner lists all `mg:{groupId}:*` keys (excluding lock), collects file IDs
7. Sends "⬆️ Uploading...", uploads each file via `mirrorToImgurRaw`, creates album via `createImgurAlbum`
8. Edits status message with album URL + inline keyboard
9. Cleans up all KV keys in `finally`

### New Imgur functions
- `mirrorToImgurRaw(fileId, env)` → `{ id, deletehash }` (no URL, used by album flow)
- `mirrorToImgur(fileId, env)` → wraps raw, adds URL (used by single-photo flow, unchanged)
- `createImgurAlbum(imageIds, env)` → POSTs to `/3/album`, same client-ID shuffle + 429 retry
- `deleteAlbumFromImgur(deletehash, env)` → DELETEs `/3/album/{deletehash}`

### Updated callback flows (backward-compatible)
- `delete:` → detects album via `/a/` in message URL, emits `confirm:album:` or `confirm:img:`
- `confirm:album:{hash}` → `deleteAlbumFromImgur`
- `confirm:img:{hash}` or legacy `confirm:{hash}` → `deleteFromImgur`
- `cancel:a:{id}:{hash}` → restores `https://imgur.com/a/{id}`
- `cancel:i:{id}:{hash}` or legacy `cancel:{id}:{hash}` → restores `https://imgur.com/{id}`

---

## Bugs We Hit & Fixed

### 1. Nested `ctx.waitUntil` doesn't work
**Problem:** Called `ctx.waitUntil(deferred())` from inside a function already running inside `ctx.waitUntil(processUpdate(...))`. CF Workers doesn't reliably extend lifetime for nested calls.

**Fix:** `handleMediaGroup` pushes the deferred into a `deferreds[]` array. `handleWebhook` registers all deferreds with `ctx.waitUntil` synchronously before returning "OK".

### 2. KV binding stripped on every deploy
**Problem:** KV namespace was configured in the CF dashboard but not in `wrangler.toml`. Every `wrangler deploy` wiped dashboard-only bindings, so `env.MEDIA_GROUPS` was always `undefined`.

**Fix:** Added real namespace ID (`bf5d70b9337a40598d80e7d13f94c742`) to `wrangler.toml`. KV IDs are not sensitive — they're identifiers, not credentials.

### 3. Multiple "⬆️ Uploading..." messages (KV write race)
**Problem:** For a 3-photo album, all 3 invocations arrived within ~100ms. All read `null` from KV before any write completed. All thought they were "first" and sent their own status message. With the old single-key approach (`mg:{groupId}`), the last write also overwrote earlier file IDs, losing photos.

**Fix:** Switched to per-file keys (`mg:{groupId}:{fileId}`). Writes never conflict. Moved the "⬆️ Uploading..." message into the winning deferred so it's sent exactly once.

### 4. Telegram retry loop / infinite spam
**Problem:** `handleWebhook` did `await processUpdate(update, env)`. Since `processUpdate` returned the deferred promise (which included a 2s `setTimeout`), `handleWebhook` awaited the full 2s+ before returning "OK". Telegram timed out waiting for the response and retried, causing an infinite loop of "⬆️ Uploading..." messages.

**Fix:** `processUpdate` no longer returns the deferred. Instead it writes to a `deferreds[]` array passed in. `handleWebhook` registers them and returns "OK" in ~50ms (just the KV write latency).

### 5. Syntax error (`})()` vs `})())`)
**Problem:** `deferreds.push((async () => { ... })())` — the outer `)` closing `push(` was missing, leaving `})()` instead of `})())`.

**Fix:** Added the missing `)`.

---

## What Still Needs Verification

### A. Does `createImgurAlbum` work anonymously?
We haven't gotten far enough to test this. The Imgur API docs mention that for anonymous uploads you may need `deletehashes[]` instead of `ids[]` to add images to an album. If anonymous album creation doesn't work with Client-ID auth, this is the next blocker.

**To test:** After a successful multi-photo send, check logs for `createImgurAlbum error:` output.

**Possible fix if needed:** Pass deletehashes instead of image IDs:
```js
body: JSON.stringify({ deletehashes: deletehashes })
```
This requires `mirrorToImgurRaw` to also collect `deletehash` per image and pass them through.

### B. Lock key race (theoretical)
Two deferreds could both read no lock within milliseconds of each other and both proceed. In practice this is nearly impossible (Telegram delivers photos sequentially, so deferreds fire ~200ms apart), but worth noting.

**Mitigation if needed:** Add a small random jitter (0–300ms) before the lock check so deferreds don't fire at exactly the same time.

### C. End-to-end test checklist
- [ ] Send 2 photos → single "⬆️ Uploading..." → album link
- [ ] Send 3 photos → single "⬆️ Uploading..." → album link with all 3
- [ ] Tap 🗑️ Delete on album → "delete this album?" → confirm → "Deleted ✅"
- [ ] Tap 🗑️ Delete → Cancel → album link restored
- [ ] Send single photo → works exactly as before (no regression)
- [ ] Send unsupported file in a group → other files upload, album created without it

---

## Nice-to-Have: `/cancel` command
When the album feature is active, a stuck "⬆️ Uploading..." can happen if the deferred crashes before editing. A `/cancel` command could:
1. List all `mg:*` KV keys for the user's chat
2. Delete them (clearing stuck state)
3. Reply "Cancelled — any pending upload has been cleared."

Not needed until album feature is stable.

---

## Next Steps
1. Merge or cherry-pick `album-feature` fixes back in, cleanly
2. Deploy to test environment
3. Verify `createImgurAlbum` works (item A above)
4. Run end-to-end checklist
5. Merge to `main`

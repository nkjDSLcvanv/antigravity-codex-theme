/**
 * core/daemon/activity-previews.mjs — Self-Contained Read-Only Conversation Preview Reader (node:sqlite)
 * Extracts latest assistant reply previews and tail error flags from Antigravity SQLite conversation DBs
 * with mtime/WAL signature caching. Zero dependency on optional metrics modules so sparse installs work cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCEL_TEXT_RE = /\b(cancel(?:led|ed)?|aborted|user\s+cancel|stop\s+requested)\b|用户已取消|已取消/i;

function parseProtoMap(buf) {
  const out = new Map();
  if (!buf || typeof buf.length !== 'number') return out;
  let i = 0;
  const len = buf.length;
  while (i < len) {
    let tag = 0;
    let shift = 0;
    while (i < len) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) return out;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < len) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 63) return out;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let blen = 0;
      let s = 0;
      while (i < len) {
        const b = buf[i++];
        blen |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 35) return out;
      }
      if (blen < 0 || i + blen > len) break;
      out.set(fn, buf.subarray(i, i + blen));
      i += blen;
    } else if (wt === 1) {
      if (i + 8 > len) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > len) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

export function getActivityDbSignature(cascadeId, conversationsDir) {
  if (!cascadeId || !UUID_RE.test(cascadeId) || !conversationsDir) return null;
  try {
    const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch {
    return null;
  }
}

export function stripMarkdownToPreview(rawText, maxChars = 220) {
  let s = String(rawText || '');
  if (!s.trim()) return '';
  s = s.replace(/\r\n?/g, '\n');

  // Drop fenced code blocks or keep compact first line if the entire reply is a code block
  const withoutFences = s.replace(/```[a-zA-Z0-9_+-]*\n?[\s\S]*?```/g, ' ');
  if (withoutFences.trim().length >= 8) {
    s = withoutFences;
  } else {
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?/g, ' ').replace(/```/g, ' ');
  }

  // Strip images & unwrap markdown links: ![alt](url) -> alt, [label](url) -> label
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Strip line-leading markdown decorations (headings, horizontal rules, quotes, bullets, tables)
  const lines = s.split('\n');
  const cleanedLines = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (/^\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>+\s*/, '')
      .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
      .replace(/^\|+|\|+$/g, '')
      .replace(/\s*\|\s*/g, ' · ')
      .trim();
    if (line) cleanedLines.push(line);
  }
  s = cleanedLines.join(' ');

  // Unwrap inline bold/italic/strikethrough/code while preserving snake_case identifiers
  s = s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[\s(（【「])\*([^*\n]+)\*(?=$|[\s.,!?;:）)】」])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!$~|])/g, '$1')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^>]*)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 220;
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  return chars.slice(0, limit).join('').trimEnd() + '…';
}

export function extractAssistantTextFromStepPayload(stepPayload) {
  if (!stepPayload || typeof stepPayload.length !== 'number' || stepPayload.length === 0) return '';
  const buf = Buffer.isBuffer(stepPayload) ? stepPayload : Buffer.from(stepPayload);
  const top = parseProtoMap(buf);
  const plannerRaw = top.get(20);
  if (!(plannerRaw instanceof Uint8Array) || plannerRaw.length === 0) return '';
  const planner = parseProtoMap(plannerRaw);
  // Field 8 = modifiedResponse (final displayed reply), Field 1 = response; skip Field 3 (thought/analysis)
  const preferred = planner.get(8);
  if (preferred instanceof Uint8Array && preferred.length > 0) {
    const txt = Buffer.from(preferred).toString('utf8').trim();
    if (txt) return txt;
  }
  const fallback = planner.get(1);
  if (fallback instanceof Uint8Array && fallback.length > 0) {
    const txt = Buffer.from(fallback).toString('utf8').trim();
    if (txt) return txt;
  }
  return '';
}

function isErrorStepWithoutCancel(stepRow) {
  if (!stepRow) return false;
  const isErr = Number(stepRow.step_type) === 17 || Number(stepRow.status) === 7;
  if (!isErr) return false;
  try {
    const rawParts = [];
    if (stepRow.error_details) rawParts.push(Buffer.from(stepRow.error_details).toString('utf8'));
    if (stepRow.step_payload) rawParts.push(Buffer.from(stepRow.step_payload).toString('utf8'));
    const joined = rawParts.join(' ');
    if (joined && CANCEL_TEXT_RE.test(joined)) return false;
  } catch {}
  return true;
}

export function extractLatestMessagePreviewFromDb(db, { maxChars = 220 } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    return { text: '', hasError: false, latestStepIdx: -1 };
  }
  let text = '';
  let latestStepIdx = -1;
  let hasError = false;

  try {
    const stmt = db.prepare(
      'SELECT idx, step_payload FROM steps WHERE step_type = 15 ORDER BY idx DESC LIMIT 120'
    );
    const iter = typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all();
    let seen = 0;
    for (const row of iter) {
      if (seen === 0 && typeof row.idx === 'number') latestStepIdx = row.idx;
      seen += 1;
      const raw = extractAssistantTextFromStepPayload(row.step_payload);
      if (raw) {
        const cleaned = stripMarkdownToPreview(raw, maxChars);
        if (cleaned) {
          text = cleaned;
          latestStepIdx = typeof row.idx === 'number' ? row.idx : latestStepIdx;
          break;
        }
      }
    }
  } catch {}

  try {
    const tailRow = db
      .prepare('SELECT idx, step_type, status, error_details, step_payload FROM steps WHERE step_type != 14 ORDER BY idx DESC LIMIT 1')
      .get();
    if (tailRow) {
      if (typeof tailRow.idx === 'number' && tailRow.idx > latestStepIdx) {
        latestStepIdx = tailRow.idx;
      }
      hasError = isErrorStepWithoutCancel(tailRow);
    }
  } catch {}

  return { text, hasError, latestStepIdx };
}

export function createActivityPreviewReader({ getDatabaseSync, maxCacheSize = 120 } = {}) {
  const cache = new Map();
  const limit = Number.isFinite(maxCacheSize) && maxCacheSize > 0 ? Math.floor(maxCacheSize) : 120;

  function setCache(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function readPreviewForConversation(cascadeId, conversationsDir, { openDb = null, maxChars = 220 } = {}) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) return null;
    const DatabaseSync = typeof openDb === 'function' ? null : typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
    if (!openDb && !DatabaseSync) return null;

    const sig = typeof openDb === 'function' ? '' : getActivityDbSignature(cascadeId, conversationsDir);
    if (!openDb && !sig) {
      return { text: '', hasError: false, latestStepIdx: -1, sig: '' };
    }

    const cacheKey = `${conversationsDir || ''}/${cascadeId}`;
    if (sig) {
      const cached = cache.get(cacheKey);
      if (cached && cached.sig === sig) return cached;
    }

    let db = null;
    try {
      const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
      db = typeof openDb === 'function' ? openDb() : new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
      const extracted = extractLatestMessagePreviewFromDb(db, { maxChars });
      const entry = {
        text: extracted.text,
        hasError: extracted.hasError,
        latestStepIdx: extracted.latestStepIdx,
        sig: sig || 'custom'
      };
      if (sig) setCache(cacheKey, entry);
      return entry;
    } catch {
      const stale = cache.get(cacheKey);
      return stale || { text: '', hasError: false, latestStepIdx: -1, sig: '' };
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  function getActivityPreviews(cascadeIds, conversationsDir, { maxBatch = 40, maxChars = 220 } = {}) {
    const previews = {};
    if (!Array.isArray(cascadeIds) || !conversationsDir) return { ok: true, previews };
    const seen = new Set();
    const cap = Math.min(Math.max(1, Number(maxBatch) || 40), 80);
    for (let i = 0; i < cascadeIds.length && seen.size < cap; i++) {
      const cid = String(cascadeIds[i] || '').trim();
      if (!UUID_RE.test(cid) || seen.has(cid)) continue;
      seen.add(cid);
      const item = readPreviewForConversation(cid, conversationsDir, { maxChars });
      if (item) {
        previews[cid] = {
          text: item.text,
          hasError: Boolean(item.hasError),
          sig: item.sig
        };
      }
    }
    return { ok: true, previews };
  }

  return {
    readPreviewForConversation,
    getActivityPreviews,
    clearCache: () => cache.clear()
  };
}

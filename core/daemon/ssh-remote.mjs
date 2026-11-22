/**
 * core/daemon/ssh-remote.mjs — Opt-In In-Memory SSH Remote Telemetry Reader
 *
 * When enabled via `modules.sshRemote: true` and explicit `sshHosts: ["..."]`
 * in `user/config.json`, queries the remote SQLite conversation database in
 * read-only mode over SSH (`python3` standard-library `sqlite3`), strips all
 * prompt/response/checkpoint text on the remote host before transmission, and
 * feeds an in-memory virtual DB adapter to `sqlite-metrics.mjs`.
 *
 * Zero `.db` / `.db-wal` / `.db-shm` files are copied to local disk and `scp`
 * is never invoked.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFileAsync = promisify(execFile);

export const VALID_CID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
// Must not start with '-' (prevents CLI option injection); allows user@host, aliases, IPv4/domain.
export const VALID_HOST_RE = /^[a-zA-Z0-9_@][a-zA-Z0-9._:@-]{0,127}$/;

const SYNC_INTERVAL_MS = 4000;
const NOT_FOUND_COOLDOWN_MS = 25000;
const MAX_REMOTE_SESSIONS = 24;
const SSH_TIMEOUT_MS = 8000;
const SSH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// Remote read-only Python extractor: strips all conversation/prompt/checkpoint
// text on the remote server and emits only compact numeric/status metadata JSON.
export const REMOTE_PY_EXTRACTOR = `
import base64, json, os, sqlite3, sys

def read_varint(buf, i):
    val = shift = 0
    n = len(buf)
    while i < n:
        b = buf[i]; i += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80): break
        shift += 7
    return val, i

def enc_varint(out, v):
    while v >= 0x80:
        out.append((v & 0x7f) | 0x80)
        v >>= 7
    out.append(v)

def filter_proto(buf, keep):
    if not buf: return b""
    out = bytearray()
    i, n = 0, len(buf)
    while i < n:
        start = i
        tag, i = read_varint(buf, i)
        fn, wt = tag >> 3, tag & 7
        if fn <= 0 or fn > 10000: break
        if wt == 0:
            _, i = read_varint(buf, i)
            if fn in keep: out.extend(buf[start:i])
        elif wt == 2:
            ln, val_start = read_varint(buf, i)
            i = val_start + ln
            if ln < 0 or i > n: break
            if fn in keep:
                sub = keep[fn]
                if isinstance(sub, dict):
                    f_sub = filter_proto(buf[val_start:i], sub)
                    enc_varint(out, tag)
                    enc_varint(out, len(f_sub))
                    out.extend(f_sub)
                else:
                    out.extend(buf[start:i])
        elif wt == 1:
            i += 8
            if i <= n and fn in keep: out.extend(buf[start:i])
        elif wt == 5:
            i += 4
            if i <= n and fn in keep: out.extend(buf[start:i])
        else:
            break
    return bytes(out)

def extract_cp_summary_len(buf):
    if not buf: return 0
    i, n = 0, len(buf)
    while i < n:
        tag, i = read_varint(buf, i)
        fn, wt = tag >> 3, tag & 7
        if fn <= 0 or fn > 10000: break
        if wt == 0:
            _, i = read_varint(buf, i)
        elif wt == 2:
            ln, val_start = read_varint(buf, i)
            i = val_start + ln
            if ln < 0 or i > n: break
            if fn == 30:
                j, m = val_start, i
                while j < m:
                    t2, j = read_varint(buf, j)
                    fn2, wt2 = t2 >> 3, t2 & 7
                    if wt2 == 0: _, j = read_varint(buf, j)
                    elif wt2 == 2:
                        ln2, vs2 = read_varint(buf, j)
                        j = vs2 + ln2
                        if fn2 == 5 and ln2 >= 0: return ln2
                    elif wt2 == 1: j += 8
                    elif wt2 == 5: j += 4
                    else: break
        elif wt == 1: i += 8
        elif wt == 5: i += 4
        else: break
    return 0

GEN_KEEP = {
    1: {
        4: {2: 1, 3: 1, 4: 1, 5: 1, 9: 1, 10: 1},
        9: {10: {4: 1}},
        11: {1: 1, 2: 1},
        12: {1: 1, 2: 1},
        17: {3: 1, 5: 1},
        19: 1,
        21: 1
    },
    2: 1,
    3: {28: 1}
}
META_KEEP = {1: {1: 1, 2: 1}, 20: {3: 1}}

cid, prev_sig, start_idx = sys.argv[2], sys.argv[3], int(sys.argv[4])
p = os.path.expanduser(f"~/.gemini/antigravity/conversations/{cid}.db")
if not os.path.isfile(p):
    print(json.dumps({"found": False}))
    sys.exit(0)
st = os.stat(p)
wp = p + "-wal"
wst = os.stat(wp) if os.path.isfile(wp) else None
sig = f"{int(st.st_mtime*1000)}:{st.st_size}|" + (f"{int(wst.st_mtime*1000)}:{wst.st_size}" if wst else "0:0")
if sig == prev_sig:
    print(json.dumps({"found": True, "unchanged": True, "sig": sig}))
    sys.exit(0)
b64 = lambda b: base64.b64encode(b).decode("ascii") if b else None
con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=0.5)
cur = con.cursor()
cnt, max_idx = cur.execute("SELECT COUNT(*), COALESCE(MAX(idx), -1) FROM gen_metadata").fetchone()
if cnt == 0 or max_idx < 0:
    print(json.dumps({"found": True, "sig": sig, "metaStat": {"cnt": 0, "maxIdx": -1}}))
    sys.exit(0)
u_idxs = [r[0] for r in cur.execute("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC").fetchall()]
last_u = u_idxs[-1] if u_idxs else -1
u_meta = None
if last_u >= 0:
    r = cur.execute("SELECT metadata, length(step_payload) FROM steps WHERE idx = ?", (last_u,)).fetchone()
    if r: u_meta = {"metadata": b64(filter_proto(r[0], META_KEEP)), "plen": r[1] or 0}
s_cnt, s_max = cur.execute("SELECT COUNT(*), COALESCE(MAX(idx), -1) FROM steps").fetchone()
cp = cur.execute("SELECT idx, status, metadata, step_payload FROM steps WHERE step_type = 23 AND status = 3 ORDER BY idx DESC LIMIT 1").fetchone()
cp_row = {"idx": cp[0], "status": cp[1], "metadata": b64(filter_proto(cp[2], META_KEEP)), "summaryLen": extract_cp_summary_len(cp[3])} if cp else None
act = [{"idx": r[0], "step_type": r[1], "status": r[2], "metadata": b64(filter_proto(r[3], META_KEEP)), "plen": r[4] or 0} for r in cur.execute("SELECT idx, step_type, status, metadata, length(step_payload) FROM steps WHERE status IN (1, 2, 8, 9, 11) ORDER BY idx DESC LIMIT 10").fetchall()]
def pack_step(r):
    if not r: return None
    err = r[3][:240] if isinstance(r[3], (bytes, bytearray)) else (r[3].encode("utf-8")[:240] if isinstance(r[3], str) else None)
    sp = r[4][:1024] if (r[1] == 17 and isinstance(r[4], (bytes, bytearray))) else None
    return {"idx": r[0], "step_type": r[1], "status": r[2], "error_details": b64(err), "step_payload": b64(sp), "metadata": b64(filter_proto(r[5], META_KEEP))}
m_row = pack_step(cur.execute("SELECT idx, step_type, status, error_details, CASE WHEN step_type = 17 THEN step_payload ELSE NULL END, metadata FROM steps WHERE step_type IN (15, 17, 23) ORDER BY idx DESC LIMIT 1").fetchone())
nu_row = pack_step(cur.execute("SELECT idx, step_type, status, error_details, CASE WHEN step_type = 17 THEN step_payload ELSE NULL END, metadata FROM steps WHERE step_type != 14 ORDER BY idx DESC LIMIT 1").fetchone())
lg = cur.execute("SELECT size, length(data) FROM gen_metadata WHERE idx = ?", (max_idx,)).fetchone()
lg_row = {"size": lg[0], "dlen": lg[1] or 0} if lg else None
t_cnt = cur.execute("SELECT COUNT(*) FROM steps WHERE step_type = 15 AND idx > ?", (last_u,)).fetchone()[0]
g_rows = [{"idx": r[0], "data": b64(filter_proto(r[1], GEN_KEEP))} for r in cur.execute("SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC", (start_idx,)).fetchall()]
print(json.dumps({"found": True, "sig": sig, "metaStat": {"cnt": cnt, "maxIdx": max_idx}, "userStepIdxs": u_idxs, "lastUserMetaRow": u_meta, "stepStat": {"cnt": s_cnt, "maxIdx": s_max}, "lastCpRow": cp_row, "activeStepRows": act, "lastModelStepRow": m_row, "latestNonUserStep": nu_row, "lastGenMetaRow": lg_row, "turnStat": {"cnt": t_cnt}, "startIdx": start_idx, "genRows": g_rows}))
`.trim();

const REMOTE_PY_B64 = Buffer.from(REMOTE_PY_EXTRACTOR, 'utf8').toString('base64');

export function validateSshHost(host) {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (!trimmed || trimmed.startsWith('-')) return false;
  return VALID_HOST_RE.test(trimmed);
}

export function normalizeSshHosts(sshHostsConfig) {
  if (!Array.isArray(sshHostsConfig) || sshHostsConfig.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const raw of sshHostsConfig) {
    const trimmed = String(raw || '').trim();
    if (!validateSshHost(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function encodeVarintBytes(v) {
  const out = [];
  let n = Math.max(0, Number(v) || 0);
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

export function synthesizeCheckpointPayload(summaryLen) {
  const len = Math.max(0, Number(summaryLen) || 0);
  if (len <= 0) return null;
  // Field 30 (tag = (30 << 3) | 2 = 242), subfield 5 (tag = (5 << 3) | 2 = 42) of length `len`
  const innerTag = encodeVarintBytes((5 << 3) | 2);
  const innerLen = encodeVarintBytes(len);
  const innerBody = Buffer.alloc(len);
  const inner = Buffer.concat([innerTag, innerLen, innerBody]);
  const outerTag = encodeVarintBytes((30 << 3) | 2);
  const outerLen = encodeVarintBytes(inner.length);
  return Buffer.concat([outerTag, outerLen, inner]);
}

function fromB64(str) {
  return typeof str === 'string' && str.length > 0 ? Buffer.from(str, 'base64') : null;
}

export function createVirtualRemoteDb(sessionState) {
  return {
    prepare(sql) {
      const q = String(sql || '');
      if (q.includes('FROM gen_metadata') && q.includes('COUNT(*)')) {
        return { get: () => sessionState.metaStat || { cnt: 0, maxIdx: -1 } };
      }
      if (q.includes('FROM steps WHERE step_type = 14')) {
        return { all: () => sessionState.userStepRows || [] };
      }
      if (q.includes('FROM steps WHERE idx = ?')) {
        return { get: () => sessionState.lastUserMetaRow || undefined };
      }
      if (q.includes('FROM steps') && q.includes('COALESCE(MAX(idx)')) {
        return { get: () => sessionState.stepStat || { cnt: 0, maxIdx: -1 } };
      }
      if (q.includes('WHERE step_type = 23 AND status = 3')) {
        return { get: () => sessionState.lastCpRow || undefined };
      }
      if (q.includes('WHERE status IN (1, 2, 8, 9, 11)')) {
        return { all: () => sessionState.activeStepRows || [] };
      }
      if (q.includes('WHERE step_type IN (15, 17, 23)')) {
        return { get: () => sessionState.lastModelStepRow || undefined };
      }
      if (q.includes('WHERE step_type != 14')) {
        return { get: () => sessionState.latestNonUserStep || undefined };
      }
      if (q.includes('SELECT size, length(data) AS dlen FROM gen_metadata')) {
        return { get: () => sessionState.lastGenMetaRow || undefined };
      }
      if (q.includes('WHERE step_type = 15 AND idx > ?')) {
        return { get: () => sessionState.turnStat || { cnt: 0 } };
      }
      if (q.includes('FROM gen_metadata WHERE idx >= ?')) {
        return {
          all: (startIdx = 0) => sessionState.allGenRows.filter((r) => r.idx >= startIdx)
        };
      }
      if (q.includes('SELECT idx, data FROM gen_metadata ORDER BY idx ASC')) {
        return { all: () => sessionState.allGenRows };
      }
      return { get: () => undefined, all: () => [] };
    },
    close() {}
  };
}

export function mergeRemoteSnapshot(prevState, rawJson) {
  const metaStat = rawJson.metaStat || { cnt: 0, maxIdx: -1 };
  if (metaStat.cnt === 0 || metaStat.maxIdx < 0) {
    return {
      sig: rawJson.sig,
      metaStat: { cnt: 0, maxIdx: -1 },
      allGenRows: []
    };
  }

  const startIdx = typeof rawJson.startIdx === 'number' ? rawJson.startIdx : 0;
  const keptRows =
    prevState && Array.isArray(prevState.allGenRows) && startIdx > 0
      ? prevState.allGenRows.filter((r) => r.idx < startIdx)
      : [];
  const deltaRows = Array.isArray(rawJson.genRows)
    ? rawJson.genRows.map((r) => ({
        idx: r.idx,
        data: fromB64(r.data) || Buffer.alloc(0)
      }))
    : [];
  const allGenRows = [...keptRows, ...deltaRows];

  const decodeStepRow = (r) =>
    r
      ? {
          idx: r.idx,
          step_type: r.step_type,
          status: r.status,
          error_details: fromB64(r.error_details),
          step_payload: fromB64(r.step_payload),
          metadata: fromB64(r.metadata)
        }
      : undefined;

  return {
    sig: rawJson.sig,
    metaStat,
    userStepRows: Array.isArray(rawJson.userStepIdxs)
      ? rawJson.userStepIdxs.map((idx) => ({ idx }))
      : [],
    lastUserMetaRow: rawJson.lastUserMetaRow
      ? {
          metadata: fromB64(rawJson.lastUserMetaRow.metadata),
          plen: rawJson.lastUserMetaRow.plen || 0
        }
      : undefined,
    stepStat: rawJson.stepStat || { cnt: 0, maxIdx: -1 },
    lastCpRow: rawJson.lastCpRow
      ? {
          idx: rawJson.lastCpRow.idx,
          status: rawJson.lastCpRow.status,
          metadata: fromB64(rawJson.lastCpRow.metadata),
          step_payload: synthesizeCheckpointPayload(rawJson.lastCpRow.summaryLen)
        }
      : undefined,
    activeStepRows: Array.isArray(rawJson.activeStepRows)
      ? rawJson.activeStepRows.map((r) => ({
          idx: r.idx,
          step_type: r.step_type,
          status: r.status,
          metadata: fromB64(r.metadata),
          plen: r.plen || 0
        }))
      : [],
    lastModelStepRow: decodeStepRow(rawJson.lastModelStepRow),
    latestNonUserStep: decodeStepRow(rawJson.latestNonUserStep),
    lastGenMetaRow: rawJson.lastGenMetaRow || undefined,
    turnStat: rawJson.turnStat || { cnt: 0 },
    allGenRows
  };
}

export function createSshRemoteController({ execFileImpl = defaultExecFileAsync } = {}) {
  const cidHostMap = new Map();
  const notFoundUntil = new Map();
  const sessionMap = new Map();
  const lastSyncAt = new Map();
  const inFlight = new Set();

  function setSessionState(cid, state) {
    if (sessionMap.has(cid)) sessionMap.delete(cid);
    sessionMap.set(cid, state);
    if (sessionMap.size > MAX_REMOTE_SESSIONS) {
      const oldestKey = sessionMap.keys().next().value;
      if (oldestKey) sessionMap.delete(oldestKey);
    }
  }

  async function queryRemoteHost(host, cid, prevSig, startIdx) {
    if (!validateSshHost(host) || !VALID_CID_RE.test(cid)) return null;
    const safeSig = /^[0-9:|]+$/.test(String(prevSig || '')) ? String(prevSig) : '';
    const safeStart = Math.max(0, Math.floor(Number(startIdx) || 0));
    const remoteCmd = `python3 -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${REMOTE_PY_B64} ${cid} '${safeSig}' ${safeStart}`;
    const { stdout } = await execFileImpl(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '--', host, remoteCmd],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: SSH_MAX_BUFFER_BYTES, windowsHide: true }
    );
    const trimmed = String(stdout || '').trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }

  async function syncCid(cid, hosts) {
    if (inFlight.has(cid)) return;
    inFlight.add(cid);
    try {
      const prev = sessionMap.get(cid) || null;
      const prevSig = prev?.sig || '';
      const startIdx = prev && prev.metaStat?.maxIdx >= 0 ? prev.metaStat.maxIdx : 0;

      const knownHost = cidHostMap.get(cid);
      const targetHosts = knownHost && hosts.includes(knownHost) ? [knownHost] : hosts;

      let hitHost = null;
      let hitData = null;

      if (targetHosts.length === 1) {
        const res = await queryRemoteHost(targetHosts[0], cid, prevSig, startIdx);
        if (res?.found) {
          hitHost = targetHosts[0];
          hitData = res;
        }
      } else {
        const results = await Promise.all(
          targetHosts.map(async (host) => {
            try {
              const res = await queryRemoteHost(host, cid, prevSig, startIdx);
              if (res?.found) return { host, res };
            } catch {}
            return null;
          })
        );
        const found = results.find(Boolean);
        if (found) {
          hitHost = found.host;
          hitData = found.res;
        }
      }

      if (!hitHost || !hitData) {
        notFoundUntil.set(cid, Date.now() + NOT_FOUND_COOLDOWN_MS);
        return;
      }

      cidHostMap.set(cid, hitHost);
      notFoundUntil.delete(cid);

      if (hitData.unchanged && prev) {
        return;
      }

      let merged = mergeRemoteSnapshot(prev, hitData);
      // If remote table was truncated/reset and delta count doesn't match, refetch from 0
      if (startIdx > 0 && merged.metaStat.cnt > 0 && merged.allGenRows.length !== merged.metaStat.cnt) {
        const fullRes = await queryRemoteHost(hitHost, cid, '', 0);
        if (fullRes?.found && !fullRes.unchanged) {
          merged = mergeRemoteSnapshot(null, fullRes);
        }
      }

      setSessionState(cid, merged);
    } catch {
      // Transient SSH failures are ignored and retried on the next poll window.
    } finally {
      lastSyncAt.set(cid, Date.now());
      inFlight.delete(cid);
    }
  }

  function getRemoteMetricsSource(cid, { sshHosts = [], force = false } = {}) {
    if (!VALID_CID_RE.test(String(cid || ''))) return null;
    // Strictly opt-in: only probe hosts explicitly listed in user config `sshHosts`.
    const hosts = normalizeSshHosts(sshHosts);
    if (hosts.length === 0) return null;

    const now = Date.now();
    const cooldownUntil = notFoundUntil.get(cid) || 0;
    const lastAt = lastSyncAt.get(cid) || 0;
    let syncPromise = null;
    if ((force || now - lastAt >= SYNC_INTERVAL_MS) && now >= cooldownUntil && !inFlight.has(cid)) {
      syncPromise = syncCid(cid, hosts);
    }

    const state = sessionMap.get(cid);
    if (state && state.sig) {
      return {
        host: cidHostMap.get(cid) || null,
        sig: state.sig,
        openDb: () => createVirtualRemoteDb(state),
        syncPromise
      };
    }
    return syncPromise ? { host: null, sig: null, openDb: null, syncPromise } : null;
  }

  return { getRemoteMetricsSource };
}

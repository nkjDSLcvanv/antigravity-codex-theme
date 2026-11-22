/**
 * core/daemon/ssh-remote.mjs — Opt-In SSH Remote Conversation Metrics Sync
 *
 * When enabled via `modules.sshRemote: true` and explicit `sshHosts: ["..."]`
 * in `user/config.json`, probes the configured SSH hosts for conversations
 * missing from the local `conversations/` directory, incrementally mirrors
 * changed `.db` / `.db-wal` / `.db-shm` files into a 0700-protected local cache
 * directory, and periodically prunes stale cache entries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFileAsync = promisify(execFile);

export const DEFAULT_SSH_CACHE_DIR = path.join(os.tmpdir(), 'ag-codex-ssh-cache');
export const VALID_CID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
// Must not start with '-' (prevents CLI option injection); allows user@host, aliases, IPv4/domain.
export const VALID_HOST_RE = /^[a-zA-Z0-9_@][a-zA-Z0-9._:@-]{0,127}$/;

const SYNC_INTERVAL_MS = 4000;
const NOT_FOUND_COOLDOWN_MS = 25000;
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CACHE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CACHED_CONVERSATIONS = 24;
const STALE_STAGING_MAX_AGE_MS = 10 * 60 * 1000;
const SSH_TIMEOUT_MS = 6000;
const SCP_TIMEOUT_MS = 20000;

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

export function parseRemoteStatOutput(stdout, cid) {
  const res = { db: '', wal: '', shm: '' };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const sep = line.lastIndexOf('|');
    if (sep <= 0) continue;
    const filePath = line.slice(0, sep).trim();
    const sig = line.slice(sep + 1).trim();
    if (!sig) continue;
    if (filePath.endsWith(`/${cid}.db`)) res.db = sig;
    else if (filePath.endsWith(`/${cid}.db-wal`)) res.wal = sig;
    else if (filePath.endsWith(`/${cid}.db-shm`)) res.shm = sig;
  }
  return res;
}

export function ensureCacheDir(cacheDir = DEFAULT_SSH_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(cacheDir, 0o700);
  } catch {}
}

export function pruneStaleCacheFiles(
  cacheDir = DEFAULT_SSH_CACHE_DIR,
  {
    maxAgeMs = DEFAULT_MAX_CACHE_AGE_MS,
    maxConversations = DEFAULT_MAX_CACHED_CONVERSATIONS,
    nowMs = Date.now()
  } = {}
) {
  if (!fs.existsSync(cacheDir)) return { removedConversations: 0, removedStaging: 0 };
  let removedConversations = 0;
  let removedStaging = 0;
  const convEntries = [];

  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return { removedConversations, removedStaging };
  }

  for (const entry of entries) {
    const fullPath = path.join(cacheDir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('.staging-')) {
      try {
        const st = fs.statSync(fullPath, { throwIfNoEntry: false });
        if (!st || nowMs - st.mtimeMs >= STALE_STAGING_MAX_AGE_MS) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedStaging++;
        }
      } catch {}
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.db')) {
      const cid = entry.name.slice(0, -3);
      if (!VALID_CID_RE.test(cid)) continue;
      try {
        const dbStat = fs.statSync(fullPath, { throwIfNoEntry: false });
        if (!dbStat) continue;
        const walPath = path.join(cacheDir, `${cid}.db-wal`);
        const walStat = fs.statSync(walPath, { throwIfNoEntry: false });
        const lastModifiedMs = Math.max(dbStat.mtimeMs || 0, walStat?.mtimeMs || 0);
        convEntries.push({ cid, lastModifiedMs });
      } catch {}
    }
  }

  convEntries.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  for (let i = 0; i < convEntries.length; i++) {
    const item = convEntries[i];
    const expired = maxAgeMs > 0 && nowMs - item.lastModifiedMs > maxAgeMs;
    const overLimit = maxConversations > 0 && i >= maxConversations;
    if (!expired && !overLimit) continue;

    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      try {
        fs.rmSync(path.join(cacheDir, `${item.cid}${suffix}`), { force: true });
      } catch {}
    }
    removedConversations++;
  }

  return { removedConversations, removedStaging };
}

export function createSshRemoteController({
  cacheDir = DEFAULT_SSH_CACHE_DIR,
  execFileImpl = defaultExecFileAsync
} = {}) {
  const cidHostMap = new Map();
  const notFoundUntil = new Map();
  const remoteSigCache = new Map();
  const lastSyncAt = new Map();
  const inFlight = new Set();
  let lastPruneAt = 0;

  async function statRemoteCid(host, cid) {
    if (!validateSshHost(host) || !VALID_CID_RE.test(cid)) {
      return { db: '', wal: '', shm: '' };
    }
    const remotePattern = `~/.gemini/antigravity/conversations/${cid}.db*`;
    // Compatible with both GNU coreutils stat (-c) and macOS/BSD stat (-f)
    const cmd = `stat -c '%n|%Y:%s' ${remotePattern} 2>/dev/null || stat -f '%N|%m:%z' ${remotePattern} 2>/dev/null || true`;
    const { stdout } = await execFileImpl(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '--', host, cmd],
      { timeout: SSH_TIMEOUT_MS, windowsHide: true }
    );
    return parseRemoteStatOutput(stdout, cid);
  }

  async function resolveHostForCid(cid, hosts) {
    const existing = cidHostMap.get(cid);
    if (existing && hosts.includes(existing)) {
      return { host: existing, stat: null };
    }

    const results = await Promise.all(
      hosts.map(async (host) => {
        try {
          const stat = await statRemoteCid(host, cid);
          if (stat.db) return { host, stat };
        } catch {}
        return null;
      })
    );
    const hit = results.find(Boolean);
    if (hit) {
      cidHostMap.set(cid, hit.host);
      notFoundUntil.delete(cid);
      return hit;
    }
    notFoundUntil.set(cid, Date.now() + NOT_FOUND_COOLDOWN_MS);
    return null;
  }

  function moveStagingFile(srcPath, destPath) {
    if (!fs.existsSync(srcPath)) return;
    try {
      fs.renameSync(srcPath, destPath);
    } catch {
      fs.copyFileSync(srcPath, destPath);
      try {
        fs.unlinkSync(srcPath);
      } catch {}
    }
    try {
      fs.chmodSync(destPath, 0o600);
    } catch {}
  }

  async function syncCid(cid, hosts, force = false) {
    if (inFlight.has(cid)) return;
    inFlight.add(cid);
    const stagingDir = path.join(cacheDir, `.staging-${cid}`);
    try {
      ensureCacheDir(cacheDir);
      const now = Date.now();
      if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = now;
        pruneStaleCacheFiles(cacheDir, { nowMs: now });
      }

      const resolved = await resolveHostForCid(cid, hosts);
      if (!resolved) return;

      const { host } = resolved;
      const remoteStat = resolved.stat || (await statRemoteCid(host, cid));
      if (!remoteStat.db) return;

      const localDb = path.join(cacheDir, `${cid}.db`);
      const localWal = path.join(cacheDir, `${cid}.db-wal`);
      const localShm = path.join(cacheDir, `${cid}.db-shm`);
      const prev = remoteSigCache.get(cid) || { db: '', wal: '', shm: '' };
      const needDb = !fs.existsSync(localDb) || prev.db !== remoteStat.db;
      const needWal = Boolean(remoteStat.wal) && (prev.wal !== remoteStat.wal || !fs.existsSync(localWal));
      const needShm = Boolean(remoteStat.shm) && (prev.shm !== remoteStat.shm || !fs.existsSync(localShm));

      if (!needDb && !needWal && !needShm) {
        return;
      }

      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
      fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

      const remoteSources = [];
      if (needDb) {
        remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db*`);
      } else {
        if (needWal) remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db-wal`);
        if (needShm) remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db-shm`);
      }

      await execFileImpl(
        'scp',
        ['-q', '-B', '-o', 'ConnectTimeout=5', '--', ...remoteSources, `${stagingDir}${path.sep}`],
        { timeout: SCP_TIMEOUT_MS, windowsHide: true }
      );

      moveStagingFile(path.join(stagingDir, `${cid}.db`), localDb);
      if (remoteStat.wal) {
        moveStagingFile(path.join(stagingDir, `${cid}.db-wal`), localWal);
      } else if (fs.existsSync(localWal)) {
        try {
          fs.unlinkSync(localWal);
        } catch {}
      }
      if (remoteStat.shm) {
        moveStagingFile(path.join(stagingDir, `${cid}.db-shm`), localShm);
      } else if (fs.existsSync(localShm)) {
        try {
          fs.unlinkSync(localShm);
        } catch {}
      }

      remoteSigCache.set(cid, remoteStat);
      console.log(`[Daemon] Synced SSH remote conversation ${cid} from ${host}`);
    } catch {
      // Transient SSH/SCP failures are ignored and retried on the next poll window.
    } finally {
      lastSyncAt.set(cid, Date.now());
      inFlight.delete(cid);
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
      } catch {}
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
      syncPromise = syncCid(cid, hosts, force);
    }

    const localDb = path.join(cacheDir, `${cid}.db`);
    if (fs.existsSync(localDb)) {
      return { dir: cacheDir, host: cidHostMap.get(cid) || null, syncPromise };
    }
    return syncPromise ? { dir: null, host: null, syncPromise } : null;
  }

  return { getRemoteMetricsSource };
}

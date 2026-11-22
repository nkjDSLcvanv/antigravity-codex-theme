/**
 * core/daemon/ssh-remote.mjs — SSH Remote Conversation Metrics Sync
 *
 * When a conversation ID (cid) is not found in the local Antigravity
 * conversations directory (e.g. an SSH Remote window), probes configured or
 * ~/.ssh/config hosts via passwordless SSH, mirrors its .db / .db-wal / .db-shm
 * files into a local temp cache on change, and exposes the cache directory to
 * the metrics reader without blocking the daemon poll loop.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SSH_CACHE_DIR = path.join(os.tmpdir(), 'ag-codex-ssh-cache');
const VALID_CID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const VALID_HOST_RE = /^[a-zA-Z0-9._:@-]+$/;
const SYNC_INTERVAL_MS = 4000;
const NOT_FOUND_COOLDOWN_MS = 25000;
const SSH_TIMEOUT_MS = 6000;
const SCP_TIMEOUT_MS = 20000;

export function parseSshConfigHosts(sshConfigText) {
  const hosts = [];
  const seen = new Set();
  for (const rawLine of String(sshConfigText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      if (!token || /[*?!]/.test(token) || !VALID_HOST_RE.test(token)) continue;
      if (!seen.has(token)) {
        seen.add(token);
        hosts.push(token);
      }
    }
  }
  return hosts;
}

export function createSshRemoteController() {
  const cidHostMap = new Map();
  const notFoundUntil = new Map();
  const remoteSigCache = new Map();
  const lastSyncAt = new Map();
  const inFlight = new Set();

  let cachedSshConfigMtime = '';
  let cachedSshConfigHosts = [];

  function ensureCacheDir() {
    if (!fs.existsSync(SSH_CACHE_DIR)) {
      fs.mkdirSync(SSH_CACHE_DIR, { recursive: true });
    }
  }

  function resolveCandidateHosts(sshHostsConfig) {
    if (Array.isArray(sshHostsConfig) && sshHostsConfig.length > 0) {
      return sshHostsConfig
        .map((h) => String(h || '').trim())
        .filter((h) => h && VALID_HOST_RE.test(h));
    }
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    try {
      const st = fs.statSync(sshConfigPath, { throwIfNoEntry: false });
      if (!st || !st.isFile()) return [];
      const mtimeSig = `${st.mtimeMs}:${st.size}`;
      if (mtimeSig !== cachedSshConfigMtime) {
        cachedSshConfigHosts = parseSshConfigHosts(fs.readFileSync(sshConfigPath, 'utf8'));
        cachedSshConfigMtime = mtimeSig;
      }
      return cachedSshConfigHosts;
    } catch {
      return [];
    }
  }

  function parseStatOutput(stdout, cid) {
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

  async function statRemoteCid(host, cid) {
    const remotePattern = `~/.gemini/antigravity/conversations/${cid}.db*`;
    const cmd = `stat -c '%n|%Y:%s' ${remotePattern} 2>/dev/null || true`;
    const { stdout } = await execFileAsync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', host, cmd],
      { timeout: SSH_TIMEOUT_MS, windowsHide: true }
    );
    return parseStatOutput(stdout, cid);
  }

  async function resolveHostForCid(cid, hosts) {
    const existing = cidHostMap.get(cid);
    if (existing) return { host: existing, stat: null };

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
  }

  async function syncCid(cid, hosts, force = false) {
    if (inFlight.has(cid)) return;
    inFlight.add(cid);
    const stagingDir = path.join(SSH_CACHE_DIR, `.staging-${cid}`);
    try {
      ensureCacheDir();
      const resolved = await resolveHostForCid(cid, hosts);
      if (!resolved) return;

      const { host } = resolved;
      const remoteStat = resolved.stat || (await statRemoteCid(host, cid));
      if (!remoteStat.db) return;

      const localDb = path.join(SSH_CACHE_DIR, `${cid}.db`);
      const localWal = path.join(SSH_CACHE_DIR, `${cid}.db-wal`);
      const localShm = path.join(SSH_CACHE_DIR, `${cid}.db-shm`);
      const prev = remoteSigCache.get(cid) || { db: '', wal: '', shm: '' };
      const needDb = !fs.existsSync(localDb) || prev.db !== remoteStat.db;
      const needWal = Boolean(remoteStat.wal) && (prev.wal !== remoteStat.wal || !fs.existsSync(localWal));
      const needShm = Boolean(remoteStat.shm) && (prev.shm !== remoteStat.shm || !fs.existsSync(localShm));

      if (!force && !needDb && !needWal && !needShm) {
        return;
      }
      if (!needDb && !needWal && !needShm) {
        return;
      }

      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
      fs.mkdirSync(stagingDir, { recursive: true });

      const remoteSources = [];
      if (needDb) {
        remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db*`);
      } else {
        if (needWal) remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db-wal`);
        if (needShm) remoteSources.push(`${host}:~/.gemini/antigravity/conversations/${cid}.db-shm`);
      }

      await execFileAsync(
        'scp',
        ['-q', '-B', '-o', 'ConnectTimeout=5', ...remoteSources, `${stagingDir}${path.sep}`],
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
    const hosts = resolveCandidateHosts(sshHosts);
    if (hosts.length === 0) return null;

    const now = Date.now();
    const cooldownUntil = notFoundUntil.get(cid) || 0;
    const lastAt = lastSyncAt.get(cid) || 0;
    if ((force || now - lastAt >= SYNC_INTERVAL_MS) && now >= cooldownUntil && !inFlight.has(cid)) {
      syncCid(cid, hosts, force);
    }

    const localDb = path.join(SSH_CACHE_DIR, `${cid}.db`);
    if (fs.existsSync(localDb)) {
      return { dir: SSH_CACHE_DIR, host: cidHostMap.get(cid) || null };
    }
    return null;
  }

  return { getRemoteMetricsSource };
}

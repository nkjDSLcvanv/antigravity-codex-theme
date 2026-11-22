/**
 * core/daemon/cdp-bridge.mjs — CDP Target Discovery, Host Fingerprint Gate, Swarm Relay, M2 Cold-Start Relay & Log Hygiene
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isAllowedOrigin as sharedIsAllowedOrigin,
  readPortFromFile,
  fetchTargetsFromPort,
  isConfirmedDaemonPid
} from '../shared.mjs';
import { ROOT_DIR } from './paths.mjs';
import { createCdpRelaunchController } from './cdp-relaunch.mjs';

const __bridgeDir = path.dirname(fileURLToPath(import.meta.url));
let getLsLogSig = () => '';
let getDbSignature = () => null;
let createSshRemoteController = () => ({ getRemoteMetricsSource: () => null });
if (fs.existsSync(path.join(__bridgeDir, 'ls-log.mjs'))) {
  try {
    const lsMod = await import('./ls-log.mjs');
    if (typeof lsMod.getLsLogSig === 'function') getLsLogSig = lsMod.getLsLogSig;
  } catch {}
}
if (fs.existsSync(path.join(__bridgeDir, 'sqlite-metrics.mjs'))) {
  try {
    const sqMod = await import('./sqlite-metrics.mjs');
    if (typeof sqMod.getDbSignature === 'function') getDbSignature = sqMod.getDbSignature;
  } catch {}
}
if (fs.existsSync(path.join(__bridgeDir, 'ssh-remote.mjs'))) {
  try {
    const sshMod = await import('./ssh-remote.mjs');
    if (typeof sshMod.createSshRemoteController === 'function') {
      createSshRemoteController = sshMod.createSshRemoteController;
    }
  } catch {}
}

function getTargetOriginKey(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(urlStr || '').slice(0, 64);
  }
}

export function acquireDaemonPidLock(cliChannel = null, runOnce = false) {
  if (runOnce) return;
  const pidKey = cliChannel || 'default';
  const pidFile = path.join(os.tmpdir(), `ag-codex-daemon-${pidKey}.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (isConfirmedDaemonPid(oldPid, ['antigravity-codex-daemon.mjs', 'codex-theme'])) {
        try {
          process.kill(oldPid, 'SIGTERM');
        } catch {}
      }
    }
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    const cleanPid = () => {
      try {
        if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
          fs.unlinkSync(pidFile);
        }
      } catch {}
    };
    process.on('exit', cleanPid);
    process.on('SIGINT', () => {
      cleanPid();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanPid();
      process.exit(0);
    });
  } catch {}
}

export function trimLogFileIfOversized(filePath, maxBytes = 256 * 1024, keepBytes = 64 * 1024) {
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size <= maxBytes) return false;
    const readLen = Math.min(keepBytes, st.size);
    const fd = fs.openSync(filePath, 'r');
    let tail;
    try {
      const buf = Buffer.allocUnsafe(readLen);
      fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      const nlIdx = buf.indexOf(0x0a);
      tail = nlIdx !== -1 && nlIdx + 1 < buf.length ? buf.subarray(nlIdx + 1) : buf;
    } finally {
      fs.closeSync(fd);
    }
    const header = Buffer.from(`[Daemon] Log trimmed at ${new Date().toISOString()} (kept ${tail.length}B)\n`, 'utf8');
    fs.writeFileSync(filePath, Buffer.concat([header, tail]));
    return true;
  } catch {
    return false;
  }
}

export function trimDaemonLogsIfNeeded(runOnce = false) {
  if (runOnce || process.platform !== 'darwin') return;
  trimLogFileIfOversized('/tmp/antigravity-codex-daemon.log');
  trimLogFileIfOversized('/tmp/antigravity-codex-daemon.err');
}

export function createCdpManager({ bundleCtrl, metricsReader, hasSqlite, runOnce = false, safeMode = false }) {
  const attachedTargets = new Map();
  const fallbackBackoffUntil = new Map();
  const skippedNonHostTargets = new Map();
  const targetMetaMap = new Map();
  const targetThemeModes = new Map();
  const cdpRelaunchCtrl = createCdpRelaunchController();
  const sshRemoteCtrl = createSshRemoteController();
  let isSyncing = false;
  let syncTickCount = 0;
  let lastTargetDiscoveryMs = 0;
  const TARGET_DISCOVERY_INTERVAL_MS = 12500;

  function resolveParentThemeMode(targetId, channel) {
    let curId = targetId;
    for (let depth = 0; depth < 6 && curId; depth += 1) {
      const meta = targetMetaMap.get(curId);
      const pid = meta?.parentId || null;
      if (pid && targetThemeModes.has(pid)) {
        return targetThemeModes.get(pid);
      }
      curId = pid;
    }
    for (const [id, mode] of targetThemeModes.entries()) {
      const meta = targetMetaMap.get(id);
      if (!channel || !meta?.channel || meta.channel === channel) {
        return mode;
      }
    }
    return '';
  }

  async function relayThemeModeToChildIframes(parentId, channel, mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    for (const [id, entry] of attachedTargets.entries()) {
      if (!entry.isSwarmIframe || !entry.hostConfirmed) continue;
      if (channel && entry.endpoint?.channel && entry.endpoint.channel !== channel) continue;
      if (parentId && entry.parentId && entry.parentId !== parentId) {
        const resolved = resolveParentThemeMode(id, entry.endpoint?.channel);
        if (resolved && resolved !== mode) continue;
      }
      try {
        await entry.send('Runtime.evaluate', {
          expression: `window.__ag_host_theme_mode = ${JSON.stringify(mode)}; if (typeof window.__ag_set_host_theme_mode === 'function') window.__ag_set_host_theme_mode(${JSON.stringify(mode)});`,
          returnByValue: false
        });
        if (entry.updateNewDocScript) {
          await entry.updateNewDocScript();
        }
      } catch {}
    }
  }

  function attachTarget(target, endpoint) {
    const wsUrl = target.webSocketDebuggerUrl;
    if (!wsUrl) return Promise.resolve(false);
    const isSwarmIframe = target.type === 'iframe' && String(target.url || '').startsWith('plugin://swarm--');

    return new Promise((resolveAttach) => {
      let settled = false;
      const finishAttach = (ok) => {
        if (!settled) {
          settled = true;
          resolveAttach(ok);
        }
      };
      const attachTimeout = setTimeout(() => finishAttach(false), 3000);

      try {
        const ws = new WebSocket(wsUrl);
        let msgId = 1;
        let activeCascadeIds = [];
        const pushedSessions = new Map();
        let evalScriptId = null;
        let hostConfirmed = isSwarmIframe;
        let currentTargetUrl = target.url || '';
        const pendingCallbacks = new Map();

        const parseCascadeIdList = (raw) => {
          const out = [];
          const pushId = (val) => {
            const s = String(val || '').trim();
            if (/^[0-9a-f-]{36}$/i.test(s) && !out.includes(s)) out.push(s);
          };
          if (Array.isArray(raw)) {
            for (const item of raw) pushId(item);
            return out.slice(0, 6);
          }
          const str = String(raw || '').trim();
          if (!str) return out;
          if (str.startsWith('[')) {
            try {
              const parsed = JSON.parse(str);
              if (Array.isArray(parsed)) {
                for (const item of parsed) pushId(item);
                return out.slice(0, 6);
              }
            } catch {}
          }
          for (const part of str.split(/[,\s]+/)) pushId(part);
          return out.slice(0, 6);
        };

        const send = (method, params = {}) =>
          new Promise((resolve) => {
            if (ws.readyState !== WebSocket.OPEN) return resolve(null);
            const id = msgId++;
            const timer = setTimeout(() => {
              pendingCallbacks.delete(id);
              resolve(null);
            }, 2500);
            pendingCallbacks.set(id, (msg) => {
              clearTimeout(timer);
              resolve(msg);
            });
            ws.send(JSON.stringify({ id, method, params }));
          });

        const buildEffectiveScript = () => {
          const { cachedInjectScript } = bundleCtrl.getState();
          if (!isSwarmIframe) return cachedInjectScript;
          const inheritedMode = resolveParentThemeMode(target.id, endpoint.channel);
          const preamble = inheritedMode ? `window.__ag_host_theme_mode = ${JSON.stringify(inheritedMode)};\n` : '';
          return `${preamble}${cachedInjectScript}`;
        };

        const verifyHostTarget = async () => {
          if (isSwarmIframe) return true;
          const probe = await send('Runtime.evaluate', {
            expression: `(() => {
              const loc = window.location;
              const isHost = Boolean(
                (loc && loc.protocol === 'vscode-file:') ||
                (window.__APP_CONFIG__ && window.__APP_CONFIG__.productName === 'antigravity') ||
                (window.electronNative && (
                  typeof window.electronNative.setTitleBarOverlay === 'function' ||
                  typeof window.electronNative.getZoomLevel === 'function'
                )) ||
                (typeof document !== 'undefined' && document.querySelector &&
                  document.querySelector('link[href*="/jetbox.css"], body[data-agy-theme], body[data-newux-theme], [id="antigravity.agentSidePanelInputBox"]'))
              );
              return isHost;
            })()`,
            returnByValue: true
          });
          return probe?.result?.result?.value === true;
        };

        const updateNewDocScript = async () => {
          if (!hostConfirmed) return;
          const { activeConfig } = bundleCtrl.getState();
          if (evalScriptId) {
            await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: evalScriptId });
            evalScriptId = null;
          }
          if (activeConfig.enabled) {
            const addRes = await send('Page.addScriptToEvaluateOnNewDocument', { source: buildEffectiveScript() });
            if (addRes?.result?.identifier) {
              evalScriptId = addRes.result.identifier;
            }
          }
        };

        const inject = async () => {
          if (!hostConfirmed) return false;
          const { cachedPatchVersion } = bundleCtrl.getState();
          const res = await send('Runtime.evaluate', {
            expression: buildEffectiveScript(),
            returnByValue: true
          });
          if (res?.error) {
            console.error(`[Daemon] Injection error on ${target.id}:`, res.error.message || res.error);
            return false;
          }
          if (res?.result?.exceptionDetails) {
            console.error(
              `[Daemon] Injection failed on ${target.id}:`,
              res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text
            );
            return false;
          }
          console.log(
            `[Daemon] Injected (${cachedPatchVersion}) into ${isSwarmIframe ? 'swarm iframe' : 'target'} ${target.id} [${endpoint.channel}]`
          );
          return true;
        };

        const syncMetricsForSession = async (force = false) => {
          if (isSwarmIframe || !hostConfirmed) return;
          const { activeConfig } = bundleCtrl.getState();
          if (!hasSqlite() || !activeConfig.modules.metrics || !activeConfig.enabled) return;

          if (activeCascadeIds.length === 0 || force) {
            const evalRes = await send('Runtime.evaluate', {
              expression: `(function(){
                if (typeof window.__ag_get_watched_cascade_ids === 'function') {
                  const list = window.__ag_get_watched_cascade_ids();
                  if (Array.isArray(list)) return list;
                }
                const out = [];
                const add = (id) => {
                  const s = String(id || '').trim();
                  if (/^[0-9a-f-]{36}$/i.test(s) && !out.includes(s)) out.push(s);
                };
                if (window.__ag_watched_cascade_id) add(window.__ag_watched_cascade_id);
                const m = window.location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
                if (m) {
                  add(m[1]);
                } else if (!document.querySelector('[data-testid="home-greeting"], [data-testid="home-splash-content"]')) {
                  const el = document.querySelector('[data-testid=conversation-row-sidebar][data-selected=true]');
                  if (el) add(el.getAttribute('data-cascade-id'));
                }
                document.querySelectorAll('[data-testid="side-question-tab-conversation"][data-cascade-id]').forEach((el) => {
                  if (!el.querySelector('[data-testid="side-question-tab-empty"]')) {
                    add(el.getAttribute('data-cascade-id'));
                  }
                });
                return out;
              })()`,
              returnByValue: true
            });
            const detected = parseCascadeIdList(evalRes?.result?.result?.value);
            activeCascadeIds = detected;
            for (const existingCid of [...pushedSessions.keys()]) {
              if (!activeCascadeIds.includes(existingCid)) {
                pushedSessions.delete(existingCid);
              }
            }
          }
          if (activeCascadeIds.length === 0) return;

          for (const cid of activeCascadeIds) {
            const prev = pushedSessions.get(cid) || { hash: '', pendingActive: false };
            let rawSig = getDbSignature(cid, endpoint.conversationsDir);
            let remoteSource = null;
            if (!rawSig && activeConfig.modules?.sshRemote === true) {
              remoteSource = sshRemoteCtrl.getRemoteMetricsSource(cid, {
                sshHosts: activeConfig.sshHosts,
                force
              });
              if (remoteSource?.sig && typeof remoteSource.openDb === 'function') {
                rawSig = remoteSource.sig;
              }
            }
            rawSig = rawSig || 'empty';
            const isRemote = Boolean(remoteSource?.sig && typeof remoteSource.openDb === 'function');
            const lsSig = prev.pendingActive && !isRemote ? getLsLogSig(endpoint.lsLogFile) : '';
            const sessionKey = `${cid}@${rawSig}|lim:${activeConfig.manualContextLimit || 0}:${activeConfig.fallbackContextLimit || 256000}|ly:${activeConfig.telemetryLayout}:${activeConfig.telemetryCacheMode}${lsSig ? `|ls:${lsSig}` : ''}`;
            if (!force && sessionKey === prev.hash) continue;

            const payload = metricsReader.parseConversationMetrics(
              cid,
              endpoint.conversationsDir,
              isRemote
                ? {
                    cacheKey: `ssh://${remoteSource.host || 'remote'}/${cid}`,
                    rawDbSig: remoteSource.sig,
                    openDb: remoteSource.openDb,
                    lsLogFile: '',
                    lsSig: ''
                  }
                : {
                    lsLogFile: endpoint.lsLogFile,
                    lsSig
                  }
            );
            if (!payload || payload.transientError) {
              if (force && payload?.cachedPayload) {
                await send('Runtime.evaluate', {
                  expression: `(window.__ag_last_daemon_hb = Date.now(), window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload.cachedPayload)}))`,
                  returnByValue: false
                });
              }
              continue;
            }

            const nextPendingActive = Boolean(
              payload.stats &&
                (payload.stats.generatingPending || payload.stats.compactingNow || payload.stats.pendingRetrying)
            );
            await send('Runtime.evaluate', {
              expression: `(window.__ag_last_daemon_hb = Date.now(), window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload)}))`,
              returnByValue: false
            });
            pushedSessions.set(cid, { hash: sessionKey, pendingActive: nextPendingActive });
          }
        };

        const checkAndInject = async () => {
          if (!hostConfirmed) return;
          try {
            const { activeConfig, cachedPatchVersion } = bundleCtrl.getState();
            const checkRes = await send('Runtime.evaluate', {
              expression:
                '((window.__ag_last_daemon_hb = Date.now()), window.__ag_refresh_wait_ui && window.__ag_refresh_wait_ui(), window.__ag_patch_version === ' +
                JSON.stringify(cachedPatchVersion) +
                ' && (' +
                JSON.stringify(!activeConfig.enabled) +
                ' || (window.__ag_body_ready === true && !!document.getElementById("ag-codex-theme"))))',
              returnByValue: true
            });
            if (checkRes?.result?.result?.value !== true) {
              await inject();
              await syncMetricsForSession(true);
            }
          } catch {}
        };

        let initialAttachDone = false;
        let navDebounceTimer = null;

        ws.addEventListener('open', async () => {
          await send('Page.enable');
          await send('Runtime.enable');

          const isHost = await verifyHostTarget();
          if (!isHost) {
            skippedNonHostTargets.set(target.id, { origin: getTargetOriginKey(currentTargetUrl) });
            try {
              ws.close();
            } catch {}
            clearTimeout(attachTimeout);
            finishAttach(false);
            return;
          }
          hostConfirmed = true;
          const entryRef = attachedTargets.get(target.id);
          if (entryRef) entryRef.hostConfirmed = true;

          console.log(
            `[Daemon] Attached ${isSwarmIframe ? 'swarm iframe' : 'target'}: ${target.id} (${target.title || 'Untitled'}) [${endpoint.channel}]`
          );
          if (!isSwarmIframe) {
            await send('Runtime.addBinding', { name: '__agRequestMetrics' });
            await send('Runtime.addBinding', { name: '__agSyncHostThemeMode' });
          }
          await updateNewDocScript();
          const ok = await inject();
          if (!isSwarmIframe) {
            const modeRes = await send('Runtime.evaluate', {
              expression: `document.documentElement ? (document.documentElement.getAttribute('data-ag-theme-mode') || '') : ''`,
              returnByValue: true
            });
            const resolvedMode = String(modeRes?.result?.result?.value || '').trim();
            if (resolvedMode === 'dark' || resolvedMode === 'light') {
              targetThemeModes.set(target.id, resolvedMode);
            }
          }
          await syncMetricsForSession(true);
          initialAttachDone = true;
          clearTimeout(attachTimeout);
          finishAttach(ok);
        });

        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.id && pendingCallbacks.has(msg.id)) {
              const cb = pendingCallbacks.get(msg.id);
              pendingCallbacks.delete(msg.id);
              cb(msg);
              return;
            }
            if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agRequestMetrics') {
              const nextIds = parseCascadeIdList(msg.params.payload);
              activeCascadeIds = nextIds;
              for (const existingCid of [...pushedSessions.keys()]) {
                if (!activeCascadeIds.includes(existingCid)) {
                  pushedSessions.delete(existingCid);
                }
              }
              if (activeCascadeIds.length > 0) {
                for (const cid of activeCascadeIds) {
                  const prev = pushedSessions.get(cid);
                  if (prev) pushedSessions.set(cid, { hash: '', pendingActive: prev.pendingActive });
                }
                syncMetricsForSession(true);
              }
              return;
            }
            if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agSyncHostThemeMode') {
              const nextMode = String(msg.params.payload || '').trim();
              if (nextMode === 'dark' || nextMode === 'light') {
                const prevMode = targetThemeModes.get(target.id);
                targetThemeModes.set(target.id, nextMode);
                if (prevMode !== nextMode) {
                  relayThemeModeToChildIframes(target.id, endpoint.channel, nextMode);
                }
              }
              return;
            }
            if (!initialAttachDone) return;
            if (
              msg.method === 'Page.frameNavigated' ||
              msg.method === 'Page.loadEventFired' ||
              msg.method === 'Page.domContentEventFired'
            ) {
              if (!msg.params?.frame || !msg.params.frame.parentId) {
                if (navDebounceTimer) clearTimeout(navDebounceTimer);
                navDebounceTimer = setTimeout(() => {
                  navDebounceTimer = null;
                  checkAndInject();
                }, 120);
              }
            }
          } catch {}
        });

        const closeHandler = () => {
          clearTimeout(attachTimeout);
          if (navDebounceTimer) {
            clearTimeout(navDebounceTimer);
            navDebounceTimer = null;
          }
          for (const [, cb] of pendingCallbacks) cb(null);
          pendingCallbacks.clear();
          attachedTargets.delete(target.id);
          targetThemeModes.delete(target.id);
          finishAttach(false);
        };
        ws.addEventListener('close', closeHandler);
        ws.addEventListener('error', closeHandler);

        attachedTargets.set(target.id, {
          ws,
          send,
          updateNewDocScript,
          inject,
          checkAndInject,
          syncMetricsForSession,
          endpoint,
          isSwarmIframe,
          parentId: target.parentId || null,
          hostConfirmed,
          updateTargetUrl: (u) => {
            if (u) currentTargetUrl = u;
          }
        });
      } catch {
        clearTimeout(attachTimeout);
        finishAttach(false);
      }
    });
  }

  async function sync() {
    if (isSyncing) return;
    isSyncing = true;
    syncTickCount = (syncTickCount + 1) % 6000;
    try {
      if (syncTickCount % 24 === 1) trimDaemonLogsIfNeeded(runOnce);
      const bundleChanged = bundleCtrl.rebuildBundleIfNeeded();
      const { activeConfig } = bundleCtrl.getState();
      if (!activeConfig.enabled) {
        targetThemeModes.clear();
      }
      const shouldHeartbeatCheck = bundleChanged || syncTickCount % 6 === 1;
      const nowMs = Date.now();
      const shouldDiscoverTargets =
        runOnce ||
        bundleChanged ||
        attachedTargets.size === 0 ||
        nowMs - lastTargetDiscoveryMs >= TARGET_DISCOVERY_INTERVAL_MS;

      if (!shouldDiscoverTargets) {
        for (const entry of attachedTargets.values()) {
          if (!entry.hostConfirmed) continue;
          if (shouldHeartbeatCheck && entry.checkAndInject) await entry.checkAndInject();
          if (entry.syncMetricsForSession) await entry.syncMetricsForSession(false);
        }
        return;
      }

      lastTargetDiscoveryMs = nowMs;
      const activeTargetIds = new Set();
      const seenRawTargetIds = new Set();
      const pendingPages = [];
      const pendingIframes = [];
      const probedPorts = new Set();

      for (const endpoint of activeConfig.endpoints) {
        const port = readPortFromFile(endpoint.portFile);
        let targets = [];
        if (port && !probedPorts.has(port)) {
          probedPorts.add(port);
          targets = await fetchTargetsFromPort(port);
        }
        if (
          targets.length === 0 &&
          endpoint.channelInstalled !== false &&
          endpoint.fallbackPort &&
          !probedPorts.has(endpoint.fallbackPort) &&
          (runOnce || nowMs >= (fallbackBackoffUntil.get(endpoint.fallbackPort) || 0))
        ) {
          probedPorts.add(endpoint.fallbackPort);
          targets = await fetchTargetsFromPort(endpoint.fallbackPort);
          if (targets.length === 0) {
            fallbackBackoffUntil.set(endpoint.fallbackPort, nowMs + 10000);
          } else {
            fallbackBackoffUntil.delete(endpoint.fallbackPort);
          }
        }
        if (targets.length === 0) continue;

        for (const t of targets) {
          if (!t?.id) continue;
          seenRawTargetIds.add(t.id);
          targetMetaMap.set(t.id, { type: t.type, parentId: t.parentId || null, channel: endpoint.channel });
          const skipped = skippedNonHostTargets.get(t.id);
          if (skipped && (!sharedIsAllowedOrigin(t.url, activeConfig.allowedOrigins) || getTargetOriginKey(t.url) !== skipped.origin)) {
            skippedNonHostTargets.delete(t.id);
          }
        }

        const pages = targets.filter(
          (t) =>
            (t.type === 'page' || (t.type === 'iframe' && String(t.url || '').startsWith('plugin://swarm--'))) &&
            t.webSocketDebuggerUrl &&
            !String(t.url || '').startsWith('devtools://') &&
            sharedIsAllowedOrigin(t.url, activeConfig.allowedOrigins) &&
            !String(t.title || '').includes('Launchpad') &&
            skippedNonHostTargets.get(t.id)?.origin !== getTargetOriginKey(t.url)
        );

        for (const page of pages) {
          activeTargetIds.add(page.id);
          if (page.type === 'iframe') {
            pendingIframes.push({ page, endpoint });
          } else {
            pendingPages.push({ page, endpoint });
          }
        }
      }

      const syncTargetBatch = async (items) => {
        const attachPromises = [];
        for (const { page, endpoint } of items) {
          if (!attachedTargets.has(page.id)) {
            attachPromises.push(attachTarget(page, endpoint));
          } else {
            const entry = attachedTargets.get(page.id);
            entry.endpoint = endpoint;
            entry.parentId = page.parentId || entry.parentId || null;
            entry.updateTargetUrl?.(page.url);
            if (entry.hostConfirmed) {
              if (bundleChanged && entry.updateNewDocScript) {
                await entry.updateNewDocScript();
              }
              if (shouldHeartbeatCheck && entry.checkAndInject) await entry.checkAndInject();
              if (entry.syncMetricsForSession) await entry.syncMetricsForSession(bundleChanged);
            }
          }
        }
        if (attachPromises.length > 0) {
          await Promise.allSettled(attachPromises);
        }
      };

      await syncTargetBatch(pendingPages);
      await syncTargetBatch(pendingIframes);

      if (pendingPages.length === 0 && attachedTargets.size === 0) {
        cdpRelaunchCtrl.maybeAutoRelaunchColdStartWithoutCdp({
          activeConfig,
          safeMode,
          runOnce,
          rootDir: ROOT_DIR
        });
      }

      for (const [id, entry] of attachedTargets.entries()) {
        if (!activeTargetIds.has(id)) {
          try {
            entry.ws.close();
          } catch {}
          attachedTargets.delete(id);
          targetThemeModes.delete(id);
        }
      }
      if (seenRawTargetIds.size > 0) {
        for (const id of skippedNonHostTargets.keys()) {
          if (!seenRawTargetIds.has(id)) skippedNonHostTargets.delete(id);
        }
        for (const id of targetMetaMap.keys()) {
          if (!seenRawTargetIds.has(id)) targetMetaMap.delete(id);
        }
      } else if (attachedTargets.size === 0) {
        targetMetaMap.clear();
      }
    } finally {
      isSyncing = false;
    }
  }

  function closeAll() {
    for (const [, entry] of attachedTargets.entries()) {
      try {
        entry.ws.close();
      } catch {}
    }
    attachedTargets.clear();
    targetThemeModes.clear();
  }

  return { sync, closeAll };
}

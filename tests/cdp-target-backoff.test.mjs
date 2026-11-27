/**
 * tests/cdp-target-backoff.test.mjs — Bounded Backoff, Cold-Start Retry & Event-Driven Target Discovery Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  SKIPPED_TARGET_BACKOFF_MS,
  getNextSkippedTargetEntry,
  isSkippedTargetCoolingDown,
  shouldTriggerImmediateTargetDiscovery,
  createCdpManager
} from '../core/daemon/cdp-bridge.mjs';

test('getNextSkippedTargetEntry backs off 4s -> 10s -> 25s and exhausts genuine non-host targets', () => {
  const origin = 'http://127.0.0.1:49152';
  let entry = null;
  let t = 1_000_000;

  for (let i = 0; i < SKIPPED_TARGET_BACKOFF_MS.length; i++) {
    entry = getNextSkippedTargetEntry(entry, { origin, nowMs: t, timedOut: false });
    assert.equal(entry.attempts, i + 1);
    assert.equal(entry.exhausted, false);
    assert.equal(entry.nextRetryAtMs, t + SKIPPED_TARGET_BACKOFF_MS[i]);
    assert.equal(isSkippedTargetCoolingDown(entry, origin, t + SKIPPED_TARGET_BACKOFF_MS[i] - 1), true);
    assert.equal(isSkippedTargetCoolingDown(entry, origin, t + SKIPPED_TARGET_BACKOFF_MS[i]), false);
    t = entry.nextRetryAtMs;
  }

  // 4th consecutive confirmed non-host probe stops infinite retries for the same origin
  entry = getNextSkippedTargetEntry(entry, { origin, nowMs: t, timedOut: false });
  assert.equal(entry.exhausted, true);
  assert.equal(isSkippedTargetCoolingDown(entry, origin, t + 60 * 60 * 1000), true);

  // Origin navigation immediately clears cooldown
  assert.equal(isSkippedTargetCoolingDown(entry, 'http://127.0.0.1:49999', t), false);
});

test('Transient Runtime.evaluate timeouts retry quickly without exhausting non-host retry budget', () => {
  const origin = 'http://127.0.0.1:49152';
  let entry = null;
  let t = 2_000_000;

  for (let i = 0; i < 4; i++) {
    entry = getNextSkippedTargetEntry(entry, { origin, nowMs: t, timedOut: true });
    assert.equal(entry.exhausted, false);
    assert.equal(entry.attempts, 0);
    assert.equal(entry.timeoutCount, i + 1);
    const expectedDelay = i < 3 ? 3000 : 12000;
    assert.equal(entry.nextRetryAtMs, t + expectedDelay);
    assert.equal(isSkippedTargetCoolingDown(entry, origin, t + expectedDelay - 1), true);
    assert.equal(isSkippedTargetCoolingDown(entry, origin, t + expectedDelay), false);
    t = entry.nextRetryAtMs;
  }
});

test('shouldTriggerImmediateTargetDiscovery matches Swarm iframes, new host pages, and child frame events while rejecting noise', () => {
  const attachedSet = new Set(['PAGE_ATTACHED', 'SWARM_ATTACHED']);
  const attachedMap = new Map([
    ['PAGE_ATTACHED', {}],
    ['SWARM_ATTACHED', {}]
  ]);

  // 1. Target.targetCreated / Target.targetInfoChanged for Swarm OOPIF iframes
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'SWARM_NEW_1',
            type: 'iframe',
            url: 'plugin://swarm--swarm_board-56665/?token=abc&conversationId=123'
          }
        }
      },
      attachedSet
    ),
    true
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'SWARM_NEW_2',
            type: 'iframe',
            url: 'plugin://swarm--swarm_board-56665/?token=def'
          }
        }
      },
      attachedMap
    ),
    true
  );

  // Already-attached Swarm iframe is deduplicated
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'SWARM_ATTACHED',
            type: 'iframe',
            url: 'plugin://swarm--swarm_board-56665/?token=abc'
          }
        }
      },
      attachedMap
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'SWARM_ATTACHED',
            type: 'iframe',
            url: 'plugin://swarm--swarm_board-56665/?token=abc'
          }
        }
      },
      attachedSet
    ),
    false
  );

  // Non-swarm iframes are rejected on Target.*
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'IFRAME_OTHER',
            type: 'iframe',
            url: 'https://127.0.0.1:56622/preview'
          }
        }
      },
      attachedSet
    ),
    false
  );

  // 2. Newly opened Antigravity page targets
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'PAGE_NEW_1',
            type: 'page',
            title: 'Antigravity',
            url: 'https://127.0.0.1:56622/c/new-conv'
          }
        }
      },
      attachedSet
    ),
    true
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'PAGE_NEW_VSCODE',
            type: 'page',
            title: 'Workspace - Antigravity',
            url: 'vscode-file://vscode-app/index.html'
          }
        }
      },
      attachedSet
    ),
    true
  );

  // Reject already-attached page, devtools, Launchpad, data: splash pages, external pages, workers, and cooling-down skipped targets
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'PAGE_ATTACHED',
            type: 'page',
            title: 'Antigravity',
            url: 'https://127.0.0.1:56622/c/abc'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'DEVTOOLS_1',
            type: 'page',
            title: 'DevTools',
            url: 'devtools://devtools/bundled/inspector.html'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'LAUNCHPAD_1',
            type: 'page',
            title: 'Antigravity Launchpad',
            url: 'https://127.0.0.1:56622/'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'SPLASH_1',
            type: 'page',
            title: 'data:text/html,...',
            url: 'data:text/html,<!doctype html><html></html>'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'EXTERNAL_1',
            type: 'page',
            title: 'Example',
            url: 'https://example.com/'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'WORKER_1',
            type: 'worker',
            url: 'https://127.0.0.1:56622/worker.js'
          }
        }
      },
      attachedSet
    ),
    false
  );
  const skippedTargets = new Map([
    [
      'PAGE_NON_HOST',
      getNextSkippedTargetEntry(null, { origin: 'http://127.0.0.1:9999', nowMs: 1000, timedOut: false })
    ]
  ]);
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'PAGE_NON_HOST',
            type: 'page',
            title: 'Other Local App',
            url: 'http://127.0.0.1:9999/dashboard'
          }
        }
      },
      attachedSet,
      { skippedTargets, nowMs: 2000 }
    ),
    false
  );

  // 3. Page.frameNavigated: only child Swarm frames trigger immediate discovery
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: 'SWARM_FRAME_NEW',
            parentId: 'PAGE_ATTACHED',
            url: 'plugin://swarm--swarm_board-56665/?token=xyz'
          }
        }
      },
      attachedSet
    ),
    true
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: 'SWARM_ATTACHED',
            parentId: 'PAGE_ATTACHED',
            url: 'plugin://swarm--swarm_board-56665/?token=xyz'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: 'CHILD_NON_SWARM',
            parentId: 'PAGE_ATTACHED',
            url: 'https://127.0.0.1:56622/subframe'
          }
        }
      },
      attachedSet
    ),
    false
  );
  // Top-level frames without parentId are handled by checkAndInject(), never immediate discovery
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: 'TOP_SWARM',
            url: 'plugin://swarm--swarm_board-56665/?token=xyz'
          }
        }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: 'TOP_PAGE',
            url: 'https://127.0.0.1:56622/c/123'
          }
        }
      },
      attachedSet
    ),
    false
  );

  // 4. Page.frameAttached: child frame mount triggers discovery; missing parentFrameId or already-attached frameId does not
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameAttached',
        params: { frameId: 'CHILD_NEW', parentFrameId: 'PAGE_ATTACHED' }
      },
      attachedSet
    ),
    true
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameAttached',
        params: { frameId: 'SWARM_ATTACHED', parentFrameId: 'PAGE_ATTACHED' }
      },
      attachedSet
    ),
    false
  );
  assert.equal(
    shouldTriggerImmediateTargetDiscovery(
      {
        method: 'Page.frameAttached',
        params: { frameId: 'ROOT_ONLY' }
      },
      attachedSet
    ),
    false
  );

  // 5. Unrelated events / malformed inputs
  assert.equal(shouldTriggerImmediateTargetDiscovery({ method: 'Target.targetDestroyed', params: {} }, attachedSet), false);
  assert.equal(shouldTriggerImmediateTargetDiscovery({ method: 'Page.loadEventFired', params: {} }, attachedSet), false);
  assert.equal(shouldTriggerImmediateTargetDiscovery(null, attachedSet), false);
});

test('createCdpManager enables Target.setDiscoverTargets on host pages and attaches Swarm iframes immediately on CDP events', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cdp-event-test-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');
  let targetList = [];
  let listFetchCount = 0;
  let holdNextListResponse = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      listFetchCount += 1;
      const bodySnapshot = JSON.stringify(targetList);
      const sendList = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(bodySnapshot);
      };
      if (holdNextListResponse) {
        const releaseHook = holdNextListResponse;
        holdNextListResponse = null;
        releaseHook(sendList);
      } else {
        sendList();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  fs.writeFileSync(portFile, `${port}\n/devtools/browser/test\n`, 'utf8');

  const socketsByUrl = new Map();
  const OrigWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.sentMethods = [];
      this.documentScripts = new Map();
      this.injectedVersions = [];
      this.settingsResponses = 0;
      this.settingsReplyExpressions = [];
      socketsByUrl.set(url, this);
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    _emit(type, evt) {
      const fns = this.listeners.get(type);
      if (!fns) return;
      for (const fn of [...fns]) fn(evt);
    }
    emitCdpEvent(payload) {
      this._emit('message', { data: JSON.stringify(payload) });
    }
    send(raw) {
      const req = JSON.parse(raw);
      this.sentMethods.push(req.method);
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        let result = {};
        if (req.method === 'Runtime.evaluate') {
          const expr = String(req.params?.expression || '');
          if (expr.includes('window.__APP_CONFIG__')) {
            result = { result: { value: true } };
          } else if (expr.includes('data-ag-theme-mode')) {
            result = { result: { value: 'light' } };
          } else if (expr.includes('window.__ag_patch_version ===')) {
            result = { result: { value: expr.includes(JSON.stringify(this.injectedVersions.at(-1))) } };
          } else {
            const version = expr.match(/window\.__ag_test = "([^"]+)";/)?.[1];
            if (version) this.injectedVersions.push(version);
            if (expr.includes('window.__ag_on_settings_state(')) {
              this.settingsResponses += 1;
              this.settingsReplyExpressions.push(expr);
            }
            result = { result: { value: true } };
          }
        } else if (req.method === 'Page.addScriptToEvaluateOnNewDocument') {
          result = { identifier: `doc-${req.id}` };
          this.documentScripts.set(result.identifier, req.params.source);
        } else if (req.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          this.documentScripts.delete(req.params.identifier);
        }
        this._emit('message', { data: JSON.stringify({ id: req.id, result }) });
      });
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this._emit('close', {});
    }
  }

  const waitUntil = async (pred, timeoutMs = 1500) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.fail(`Timed out waiting for condition after ${timeoutMs}ms`);
  };

  let manager = null;
  try {
    globalThis.WebSocket = FakeWebSocket;
    targetList = [
      {
        id: 'HOST_PAGE_1',
        type: 'page',
        title: 'Antigravity',
        url: `https://127.0.0.1:${port}/c/conv-1`,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/HOST_PAGE_1`
      }
    ];

    let surfaceOpacity = 85;
    const opacityWrites = [];
    const wallpaperWrites = [];
    const workerEvents = [];
    const patchVersion = () => `1.4.2-test-${surfaceOpacity}-${wallpaperWrites.length}`;
    const bundleCtrl = {
      rebuildBundleIfNeeded: () => false,
      updateUserConfig: (patch) => {
        if (Object.hasOwn(patch.appearance, 'surfaceOpacity')) {
          surfaceOpacity = patch.appearance.surfaceOpacity;
          opacityWrites.push(surfaceOpacity);
        }
        if (Object.hasOwn(patch.appearance, 'wallpaper')) wallpaperWrites.push(patch.appearance.wallpaper);
        return { ok: true };
      },
      getState: () => ({
        cachedInjectScript: `window.__ag_test = ${JSON.stringify(patchVersion())};`,
        cachedPatchVersion: patchVersion(),
        activeConfig: {
          enabled: true,
          appearance: { surfaceOpacity },
          allowedOrigins: ['http://127.0.0.1', 'https://127.0.0.1', 'vscode-file://', 'plugin://swarm--'],
          modules: { metrics: false, sshRemote: false, promptSuggestions: false },
          endpoints: [
            {
              channel: 'stable',
              portFile,
              fallbackPort: null,
              channelInstalled: true,
              conversationsDir: tmpDir,
              lsLogFile: ''
            }
          ]
        }
      })
    };

    manager = createCdpManager({
      bundleCtrl,
      promptSuggester: {
        stop: () => workerEvents.push('stop'),
        syncState: () => workerEvents.push('sync')
      },
      metricsReader: { parseConversationMetrics: () => null },
      hasSqlite: () => false,
      runOnce: false,
      safeMode: true
    });

    await manager.sync();
    assert.equal(listFetchCount, 1);
    const hostWs = socketsByUrl.get(`ws://127.0.0.1:${port}/devtools/page/HOST_PAGE_1`);
    assert.ok(hostWs, 'Host page WebSocket should be attached');
    assert.ok(
      hostWs.sentMethods.includes('Target.setDiscoverTargets'),
      'Host page should enable Target.setDiscoverTargets'
    );

    // 1. Open a Swarm OOPIF iframe after initial attach: Target.targetCreated must attach immediately (<500ms)
    const swarmUrl = 'plugin://swarm--swarm_board-56665/?token=tok1&conversationId=conv-1';
    const swarmWsUrl = `ws://127.0.0.1:${port}/devtools/page/SWARM_1`;
    targetList = [
      ...targetList,
      {
        id: 'SWARM_1',
        type: 'iframe',
        parentId: 'HOST_PAGE_1',
        title: swarmUrl,
        url: swarmUrl,
        webSocketDebuggerUrl: swarmWsUrl
      }
    ];
    hostWs.emitCdpEvent({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'SWARM_1', type: 'iframe', url: swarmUrl } }
    });

    await waitUntil(() => socketsByUrl.has(swarmWsUrl), 800);
    const swarmWs = socketsByUrl.get(swarmWsUrl);
    assert.ok(swarmWs, 'Swarm iframe should attach immediately without waiting 12.5s');
    assert.equal(
      swarmWs.sentMethods.includes('Target.setDiscoverTargets'),
      false,
      'Swarm iframe itself must not call Target.setDiscoverTargets'
    );
    assert.equal(listFetchCount, 2);

    // 2. Burst of Page.frameAttached events must coalesce to a single discovery pass (500ms cooldown)
    const countBeforeBurst = listFetchCount;
    for (let i = 0; i < 6; i++) {
      hostWs.emitCdpEvent({
        method: 'Page.frameAttached',
        params: { frameId: `BURST_F_${i}`, parentFrameId: 'HOST_PAGE_1' }
      });
    }
    await waitUntil(() => listFetchCount === countBeforeBurst + 1, 800);
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(listFetchCount, countBeforeBurst + 1, 'Page.frameAttached burst must coalesce to 1 discovery fetch');

    // 3. Target event arriving WHILE sync() is in-flight must queue pendingImmediateDiscovery and run a follow-up sync
    const swarm2Url = 'plugin://swarm--swarm_board-56665/?token=tok2&conversationId=conv-2';
    const swarm2WsUrl = `ws://127.0.0.1:${port}/devtools/page/SWARM_2`;
    let releaseBlockedFetch = null;
    holdNextListResponse = (sendList) => {
      releaseBlockedFetch = sendList;
    };

    // Trigger an in-flight discovery via a Target.targetCreated for an upcoming target
    hostWs.emitCdpEvent({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'SWARM_2', type: 'iframe', url: swarm2Url } }
    });
    await waitUntil(() => typeof releaseBlockedFetch === 'function', 800);

    // While the in-flight /json/list request is blocked (targetList does not contain SWARM_2 yet),
    // add SWARM_2 to targetList and emit Target.targetInfoChanged so pendingImmediateDiscovery is set!
    targetList = [
      ...targetList,
      {
        id: 'SWARM_2',
        type: 'iframe',
        parentId: 'HOST_PAGE_1',
        title: swarm2Url,
        url: swarm2Url,
        webSocketDebuggerUrl: swarm2WsUrl
      }
    ];
    hostWs.emitCdpEvent({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: 'SWARM_2', type: 'iframe', url: swarm2Url } }
    });
    // Release the stale in-flight response (snapshotted BEFORE SWARM_2 was added) — SWARM_2 can ONLY attach via follow-up sync
    const fetchesAtBlock = listFetchCount;
    releaseBlockedFetch();
    await waitUntil(() => listFetchCount >= fetchesAtBlock + 1 && socketsByUrl.has(swarm2WsUrl), 800);
    assert.ok(socketsByUrl.has(swarm2WsUrl), 'Follow-up sync after in-flight sync should attach SWARM_2');

    const sendSettings = (ws, payload) => ws.emitCdpEvent({
      method: 'Runtime.bindingCalled',
      params: { name: '__agUpdateSettings', payload: JSON.stringify(payload) }
    });
    const sendOpacity = (value) => sendSettings(hostWs, {
      reqId: `opacity-${value}`, patch: { appearance: { surfaceOpacity: value } }
    });
    await t.test('Concurrent slider changes write once and leave one latest script on each target', async () => {
      const sockets = [...socketsByUrl.values()];
      await waitUntil(() => sockets.every((ws) => ws.injectedVersions.length > 0));
      const updateStart = sockets.map((ws) => ws.injectedVersions.length);
      const values = [74, 75, 76, 77, 78, 79];
      for (const value of values) sendOpacity(value);
      await waitUntil(() => hostWs.settingsResponses === values.length);
      assert.deepEqual(opacityWrites, [79]);
      for (const [index, ws] of sockets.entries()) {
        assert.equal(ws.documentScripts.size, 1);
        assert.ok([...ws.documentScripts.values()][0].includes(patchVersion()));
        assert.deepEqual(ws.injectedVersions.slice(updateStart[index]), [patchVersion()]);
      }
    });

    await t.test('A wallpaper import can only finish if it is still current across host windows', async () => {
      const peer = {
        id: 'HOST_PAGE_2', type: 'page', title: 'Antigravity',
        url: `https://127.0.0.1:${port}/c/conv-peer`,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/HOST_PAGE_2`
      };
      targetList = [...targetList, peer];
      hostWs.emitCdpEvent({ method: 'Target.targetCreated', params: { targetInfo: { ...peer, targetId: peer.id } } });
      await waitUntil(() => socketsByUrl.get(peer.webSocketDebuggerUrl)?.injectedVersions.length > 0);
      const peerWs = socketsByUrl.get(peer.webSocketDebuggerUrl);
      const older = '1-2-3-4';
      const newer = '5-6-7-8';
      const saveWallpaper = (ws, reqId, wallpaper, wallpaperImportToken) => sendSettings(ws, {
        reqId, wallpaperImportToken, patch: { appearance: { wallpaper } }
      });
      const oldImage = 'older-test-wallpaper';
      const newImage = 'newer-test-wallpaper';

      sendSettings(hostWs, { wallpaperImportStart: older });
      saveWallpaper(peerWs, 'removed', '');
      await waitUntil(() => peerWs.settingsResponses === 1);
      const hostReplyCount = hostWs.settingsResponses;
      saveWallpaper(hostWs, 'late-import', oldImage, older);
      await waitUntil(() => hostWs.settingsResponses === hostReplyCount + 1);
      assert.deepEqual(wallpaperWrites, ['']);
      assert.match(hostWs.settingsReplyExpressions.at(-1), /wallpaper_import_superseded/);

      sendSettings(hostWs, { wallpaperImportStart: older });
      sendSettings(peerWs, { wallpaperImportStart: newer });
      saveWallpaper(hostWs, 'older-import', oldImage, older);
      saveWallpaper(peerWs, 'newer-import', newImage, newer);
      await waitUntil(() => peerWs.settingsResponses === 2 && hostWs.settingsResponses === hostReplyCount + 2);
      assert.deepEqual(wallpaperWrites, ['', newImage]);
    });

    await t.test('Closing the renderer and daemon still saves accepted opacity', async () => {
      const fetchesBeforeClose = listFetchCount;
      hostWs.emitCdpEvent({
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId: 'SWARM_AFTER_CLOSE',
            type: 'iframe',
            url: 'plugin://swarm--swarm_board-56665/?token=after-close'
          }
        }
      });
      sendOpacity(71);
      hostWs.close();
      const eventsBeforeClose = workerEvents.length;
      manager.closeAll();
      assert.deepEqual(opacityWrites, [79, 71]);
      assert.deepEqual(workerEvents.slice(eventsBeforeClose), ['stop']);
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(listFetchCount, fetchesBeforeClose, 'closeAll() must cancel pending immediate discovery timer');
    });
  } finally {
    if (manager) manager.closeAll();
    globalThis.WebSocket = OrigWebSocket;
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

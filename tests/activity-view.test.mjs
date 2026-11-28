/**
 * tests/activity-view.test.mjs — Activity View Data Layer, Priority/Recent Grouping, Shortcut, Config & Runtime Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  stripMarkdownToPreview,
  extractAssistantTextFromStepPayload,
  extractLatestMessagePreviewFromDb,
  createActivityPreviewReader
} from '../core/daemon/activity-previews.mjs';
import { createCdpManager } from '../core/daemon/cdp-bridge.mjs';
import { sanitizeConfigPatch, normalizeActivityViewConfig, createBundleController } from '../core/daemon/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function encodeVarint(num) {
  const bytes = [];
  let v = num >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNum, payloadBuf) {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payloadBuf.length);
  return Buffer.concat([tag, len, payloadBuf]);
}

function makePlannerStepPayload({ response = '', modifiedResponse = '', thought = '' } = {}) {
  const inner = [];
  if (response) inner.push(encodeLengthDelimited(1, Buffer.from(response, 'utf8')));
  if (thought) inner.push(encodeLengthDelimited(3, Buffer.from(thought, 'utf8')));
  if (modifiedResponse) inner.push(encodeLengthDelimited(8, Buffer.from(modifiedResponse, 'utf8')));
  return encodeLengthDelimited(20, Buffer.concat(inner));
}

function loadActivityPureHelpers() {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '65-activity-view.js'), 'utf8');
  const sandbox = {
    IS_SWARM_PLUGIN_FRAME: false,
    ENABLED: true,
    MODULES: { activityView: true, i18n: false },
    boot: { platform: 'darwin', userConfig: {} },
    Intl
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${src}\nthis.__exports = { AG_ACTIVITY_ATTENTION_RANK, normalizeActivityPrefs, isDefaultActivityPrefs, parseActivityTimestampMs, isToggleActivityShortcut, extractActivityWorkspaceLabel, classifyConversationAttention, sortActivityPriorityItems, groupActivitySections, formatActivityDayLabel };`,
    sandbox
  );
  return sandbox.__exports;
}

test('stripMarkdownToPreview cleans markdown formatting while preserving identifiers and CJK', () => {
  const md = [
    '### 一、清理结果总览',
    '',
    '- 已完成 `/nfs100/caixiang/claude_code` 下所有 **H3 / Flex** 清理，详情见 [report.md](file:///tmp/report.md)。',
    '```bash',
    'rm -rf /tmp/unused',
    '```',
    '> 下一步建议验证 `claude_code` 工作区。'
  ].join('\n');
  const out = stripMarkdownToPreview(md, 200);
  assert.ok(out.includes('一、清理结果总览'));
  assert.ok(out.includes('claude_code'), 'snake_case identifier underscores must be preserved');
  assert.ok(out.includes('report.md'));
  assert.ok(!out.includes('file:///tmp/report.md'), 'markdown link URLs should be stripped');
  assert.ok(!out.includes('**'), 'bold markers should be stripped');
  assert.ok(!out.includes('```'), 'fenced code blocks should be omitted when prose exists');

  // Code-only reply falls back to showing inner code snippet
  const codeOnly = '```js\nconsole.log("hello world");\n```';
  assert.equal(stripMarkdownToPreview(codeOnly, 100), 'console.log("hello world");');

  // Truncation with ellipsis
  const longText = '测试字符'.repeat(80);
  const clipped = stripMarkdownToPreview(longText, 20);
  assert.equal(Array.from(clipped).length, 21);
  assert.ok(clipped.endsWith('…'));

  assert.equal(stripMarkdownToPreview('   \n\t  '), '');
});

test('extractAssistantTextFromStepPayload prefers field 8 over field 1 and ignores thinking field 3', () => {
  const thoughtOnly = makePlannerStepPayload({ thought: 'internal chain of thought only' });
  assert.equal(extractAssistantTextFromStepPayload(thoughtOnly), '');

  const both = makePlannerStepPayload({
    response: 'raw response text',
    modifiedResponse: 'final modified text',
    thought: 'secret thinking'
  });
  assert.equal(extractAssistantTextFromStepPayload(both), 'final modified text');

  const responseOnly = makePlannerStepPayload({ response: 'plain response text' });
  assert.equal(extractAssistantTextFromStepPayload(responseOnly), 'plain response text');

  assert.equal(extractAssistantTextFromStepPayload(Buffer.alloc(0)), '');
  assert.equal(extractAssistantTextFromStepPayload(null), '');
});

test('extractLatestMessagePreviewFromDb and createActivityPreviewReader read real SQLite DBs with caching and UUID validation', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-av-preview-'));
  const cid1 = '11111111-2222-3333-4444-555555555555';
  const cid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    const db1Path = path.join(tmpDir, `${cid1}.db`);
    const db1 = new DatabaseSync(db1Path);
    db1.exec(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);'
    );
    const ins = db1.prepare(
      'INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run(0, 14, 3, null, Buffer.from('user prompt'));
    ins.run(1, 15, 3, null, makePlannerStepPayload({ modifiedResponse: 'Latest **assistant** answer in `claude_code`.' }));
    // Later step 2 is a thought/tool-only planner step; extractor must walk back to step 1!
    ins.run(2, 15, 3, null, makePlannerStepPayload({ thought: 'calling a tool...' }));
    // Step 3 is a real terminal error step
    ins.run(3, 17, 7, Buffer.from('Upstream model timeout'), null);

    const direct = extractLatestMessagePreviewFromDb(db1);
    assert.equal(direct.text, 'Latest assistant answer in claude_code.');
    assert.equal(direct.hasError, true);
    db1.close();

    // DB2 ends with user cancellation -> hasError must stay false and empty assistant text triggers fallback
    const db2Path = path.join(tmpDir, `${cid2}.db`);
    const db2 = new DatabaseSync(db2Path);
    db2.exec(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);'
    );
    db2
      .prepare('INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)')
      .run(0, 17, 7, Buffer.from('Request cancelled by user'), null);
    db2.close();

    const reader = createActivityPreviewReader({ getDatabaseSync: () => DatabaseSync });
    const batch = reader.getActivityPreviews(
      [cid1, cid2, '../etc/passwd', 'not-a-uuid', '99999999-9999-9999-9999-999999999999'],
      tmpDir
    );
    assert.equal(batch.ok, true);
    assert.equal(batch.previews[cid1].text, 'Latest assistant answer in claude_code.');
    assert.equal(batch.previews[cid1].hasError, true);
    assert.equal(batch.previews[cid2].text, '');
    assert.equal(batch.previews[cid2].hasError, false);
    assert.equal(batch.previews['../etc/passwd'], undefined, 'non-UUID path traversal must be rejected');
    assert.equal(batch.previews['99999999-9999-9999-9999-999999999999'].text, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Activity view pure helpers enforce Codex 4-tier priority sorting, 7-day grouping, held-read clearing, and macOS Opt+Cmd+U dead-key shortcut', () => {
  const h = loadActivityPureHelpers();

  // Shortcut matching (including macOS dead-key ¨ for Option+U)
  assert.equal(h.isToggleActivityShortcut({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, code: 'KeyU', key: '¨' }, 'darwin'), true);
  assert.equal(h.isToggleActivityShortcut({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, code: 'KeyU', key: 'u' }, 'MacIntel'), true);
  assert.equal(h.isToggleActivityShortcut({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: true, code: 'KeyU', key: 'u' }, 'darwin'), false);
  assert.equal(h.isToggleActivityShortcut({ metaKey: false, altKey: true, ctrlKey: true, shiftKey: false, code: 'KeyU', key: 'u' }, 'darwin'), false);
  assert.equal(h.isToggleActivityShortcut({ metaKey: false, altKey: true, ctrlKey: true, shiftKey: false, code: 'KeyU', key: 'u' }, 'win32'), true);
  assert.equal(h.isToggleActivityShortcut({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, code: 'KeyU', key: 'u' }, 'linux'), false);

  // Timestamp parsing
  assert.equal(h.parseActivityTimestampMs({ seconds: '1795710868', nanos: 250000000 }), 1795710868250);
  assert.equal(h.parseActivityTimestampMs({ seconds: 1795710868n, nanos: 0 }), 1795710868000);
  assert.equal(h.parseActivityTimestampMs(1795710868), 1795710868000);
  assert.equal(h.parseActivityTimestampMs(null), 0);

  // Workspace label resolution
  assert.equal(
    h.extractActivityWorkspaceLabel(
      { workspaces: [{ workspaceFolderAbsoluteUri: 'file:///Users/edy/aiXcoder/claude_code' }] },
      {},
      false
    ),
    'claude_code'
  );
  assert.equal(
    h.extractActivityWorkspaceLabel({ trajectoryMetadata: { projectId: 'outside-of-project' } }, {}, true),
    '项目外'
  );
  assert.equal(
    h.extractActivityWorkspaceLabel({ trajectoryMetadata: { projectId: 'p1' } }, { p1: 'swarm/board' }, false),
    'swarm/board'
  );

  // Priority sorting & section grouping
  const now = new Date(2026, 10, 27, 15, 0, 0).getTime(); // Nov 27, 2026 15:00 local
  const oneHour = 3600 * 1000;
  const oneDay = 24 * oneHour;

  const items = [
    { id: 'c-active', title: 'Active chat', isActive: true, recencyMs: now - 1000 },
    { id: 'c-unread', title: 'Unread chat', isUnread: true, recencyMs: now - 5000 },
    { id: 'c-waiting', title: 'Waiting approval', waitingCount: 1, recencyMs: now - 10000 },
    { id: 'c-held-read', title: 'Clicked in session', recencyMs: now - 2000 },
    { id: 'c-pinned', title: 'Pinned idle', isPinned: true, recencyMs: now - 3 * oneHour },
    { id: 'c-scheduled', title: 'Scheduled run', isScheduled: true, isUnread: true, recencyMs: now - 2000 },
    { id: 'c-archived', title: 'Archived unread', isArchived: true, isUnread: true, recencyMs: now },
    { id: 'c-today', title: 'Today read', recencyMs: now - 2 * oneHour },
    { id: 'c-yesterday', title: 'Yesterday read', recencyMs: now - oneDay },
    { id: 'c-old', title: '10 days ago', recencyMs: now - 10 * oneDay }
  ];

  const held = new Set(['c-held-read', 'c-unread']);
  const g1 = h.groupActivitySections({
    items,
    heldPriorityIds: held,
    clearedReadIds: new Set(),
    prefs: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
    nowMs: now,
    visibleLimit: 20
  });

  // Priority order: waiting (0) -> unread (1) -> active (2) -> held-read idle (3); archived & scheduled excluded
  const prioSec = g1.sections.find((s) => s.kind === 'priority');
  assert.ok(prioSec);
  assert.deepEqual(
    Array.from(prioSec.items, (x) => x.id),
    ['c-waiting', 'c-unread', 'c-active', 'c-held-read']
  );
  assert.equal(g1.hasHeldReadInPriority, true);
  assert.equal(g1.unreadPriorityCount, 1);
  assert.equal(g1.hasAnyAttention, true);

  // Recent sections: Today (c-today, c-pinned), Yesterday (c-yesterday), Earlier (c-old)
  const recents = Array.from(g1.sections).filter((s) => s.kind === 'recent');
  assert.deepEqual(
    recents.map((r) => [r.relativeDay, Array.from(r.items, (x) => x.id)]),
    [
      ['today', ['c-today', 'c-pinned']],
      ['yesterday', ['c-yesterday']],
      ['earlier', ['c-old']]
    ]
  );

  // Clearing read chats removes c-held-read from Priority and flips hasHeldReadInPriority to false
  const gCleared = h.groupActivitySections({
    items,
    heldPriorityIds: held,
    clearedReadIds: new Set(['c-held-read']),
    prefs: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
    nowMs: now,
    visibleLimit: 20
  });
  assert.deepEqual(
    Array.from(gCleared.sections[0].items, (x) => x.id),
    ['c-waiting', 'c-unread', 'c-active']
  );
  assert.equal(gCleared.hasHeldReadInPriority, false);

  // Enabling showPinned & showScheduled surfaces Pinned section and includes scheduled unread in Priority
  const gOpts = h.groupActivitySections({
    items,
    heldPriorityIds: new Set(),
    clearedReadIds: new Set(),
    prefs: { showPriority: true, showPinned: true, showScheduled: true, unreadOnly: false },
    nowMs: now,
    visibleLimit: 20
  });
  assert.ok(Array.from(gOpts.sections).find((s) => s.kind === 'pinned')?.items.some((x) => x.id === 'c-pinned'));
  assert.ok(Array.from(gOpts.sections).find((s) => s.kind === 'priority')?.items.some((x) => x.id === 'c-scheduled'));

  // Unread-only filter drops active-only and read items
  const gUnread = h.groupActivitySections({
    items,
    heldPriorityIds: held,
    clearedReadIds: new Set(),
    prefs: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: true },
    nowMs: now,
    visibleLimit: 20
  });
  assert.deepEqual(
    Array.from(gUnread.sections).flatMap((s) => Array.from(s.items, (x) => x.id)),
    ['c-waiting', 'c-unread']
  );
});

test('sanitizeConfigPatch validates modules.activityView and activityView prefs while preserving other config', () => {
  const base = {
    enabled: true,
    preset: 'codex-dark',
    modules: { theme: true, quotaSidebar: true, activityView: true },
    activityView: normalizeActivityViewConfig({})
  };
  const next = sanitizeConfigPatch(base, {
    modules: { activityView: false, unknownMod: true },
    activityView: { showPriority: false, showPinned: true, unreadOnly: true, showScheduled: 'yes', badKey: true }
  });
  assert.equal(next.preset, 'codex-dark');
  assert.equal(next.modules.theme, true);
  assert.equal(next.modules.activityView, false);
  assert.equal(next.modules.unknownMod, undefined);
  assert.deepEqual(next.activityView, {
    showPriority: false,
    showPinned: true,
    showScheduled: false,
    unreadOnly: true
  });
});

test('Assembled activity-view runtime mounts toggle button, handles Opt+Cmd+U, renders previews & fallback, navigates, and cleans up', () => {
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  const docAttrs = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const navigated = [];
  const previewRequests = [];
  const settingsPatches = [];

  function makeEl(tag, id = '') {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      get id() {
        return attrs.get('id') || '';
      },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && elementsById.get(prev) === el) elementsById.delete(prev);
        attrs.set('id', String(v));
        if (v) elementsById.set(String(v), el);
      },
      type: '',
      hidden: false,
      disabled: false,
      scrollTop: 0,
      innerHTML: '',
      textContent: '',
      style: {},
      parentElement: null,
      parentNode: null,
      children,
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentElement.children.length ? this.parentElement.children[idx + 1] : null;
      },
      setAttribute(k, v) {
        if (k === 'id') {
          this.id = v;
          return;
        }
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = el;
        child.parentNode = el;
        children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) child.remove();
        child.parentElement = el;
        child.parentNode = el;
        const idx = children.indexOf(ref);
        if (idx === -1) children.push(child);
        else children.splice(idx, 0, child);
        return child;
      },
      remove() {
        if (this.parentElement) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx !== -1) this.parentElement.children.splice(idx, 1);
          this.parentElement = null;
          this.parentNode = null;
        }
        if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        const list = listeners.get(type) || [];
        const fullEv = Object.assign({ preventDefault() {}, stopPropagation() {}, target: el }, ev);
        for (const fn of list) fn(fullEv);
      },
      getBoundingClientRect: () => ({ left: 100, top: 10, right: 128, bottom: 38, width: 28, height: 28 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      closest(sel) {
        if (sel === `#${this.id}`) return this;
        return null;
      }
    };
    if (id) el.id = id;
    return el;
  }

  const headEl = makeEl('head');
  const bodyEl = makeEl('body');
  const sidebarEl = makeEl('aside');
  sidebarEl.setAttribute('class', 'bg-sidebar');
  const topHeaderRow = makeEl('div');
  const searchBtn = makeEl('button');
  searchBtn.setAttribute('data-testid', 'sidebar-search-button');
  searchBtn.closest = (sel) => (sel.includes('aside') || sel.includes('.bg-sidebar') ? sidebarEl : null);
  topHeaderRow.appendChild(searchBtn);
  sidebarEl.appendChild(topHeaderRow);

  const listParent = makeEl('div');
  const listEl = makeEl('div');
  listEl.setAttribute('data-testid', 'conversation-list-sidebar');
  listEl.closest = (sel) => (sel.includes('aside') || sel.includes('.bg-sidebar') ? sidebarEl : null);
  listParent.appendChild(listEl);
  sidebarEl.appendChild(listParent);

  const nowSec = Math.floor(Date.now() / 1000);
  const cidUnread = '11111111-1111-1111-1111-111111111111';
  const cidToday = '22222222-2222-2222-2222-222222222222';
  const fakeStoreState = {
    sideBar: { isOpen: true },
    conversation: {
      convoState: { cascadeId: cidToday },
      localLastViewedTimes: { [cidUnread]: nowSec - 600, [cidToday]: nowSec }
    },
    sidebarProjects: { projects: [{ id: 'p-1', name: 'claude_code' }] },
    trajectorySummaries: {
      indexes: {
        topLevel: { [cidUnread]: true, [cidToday]: true },
        active: {},
        pinned: {},
        archived: {},
        serverUnread: {},
        hasWaitingSteps: {}
      },
      summaries: {
        [cidUnread]: {
          summary: '排查 Antigravity Prompt 提议功能',
          status: 1,
          notFullyIdle: false,
          hasActivity: false,
          lastModifiedTime: { seconds: String(nowSec - 60), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec - 600), nanos: 0 } },
          trajectoryMetadata: { projectId: 'p-1', workspaceUris: [] }
        },
        [cidToday]: {
          summary: '排查 W&B 链接问题',
          status: 1,
          notFullyIdle: false,
          hasActivity: false,
          lastModifiedTime: { seconds: String(nowSec - 120), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec), nanos: 0 } },
          trajectoryMetadata: { projectId: 'p-1', workspaceUris: [] }
        }
      }
    }
  };
  const fakeStore = {
    getState: () => fakeStoreState,
    subscribe: () => () => {}
  };
  const fakeRouter = {
    routesByPath: { '/c/$cascadeId': {} },
    navigate(opts) {
      navigated.push(opts);
      if (opts && opts.params && opts.params.cascadeId) {
        fakeStoreState.conversation.convoState.cascadeId = opts.params.cascadeId;
      }
    }
  };
  // Attach React fiber chain exposing Redux store & TanStack Router
  listEl.__reactFiber$test = {
    memoizedProps: { value: { store: fakeStore } },
    return: {
      memoizedProps: { value: fakeRouter },
      return: null
    }
  };

  const storageMap = new Map();
  const fakeDocument = {
    head: headEl,
    body: bodyEl,
    hidden: false,
    documentElement: {
      style: { removeProperty() {} },
      setAttribute: (k, v) => docAttrs.set(k, String(v)),
      getAttribute: (k) => docAttrs.get(k) ?? null,
      removeAttribute: (k) => docAttrs.delete(k)
    },
    getElementById: (id) => elementsById.get(id) || null,
    createElement: (tag) => makeEl(tag),
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector(sel) {
      if (sel === '[data-testid="sidebar-search-button"]') return searchBtn;
      if (sel === '[data-testid="conversation-list-sidebar"]') return listEl;
      return null;
    },
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => false }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    }
  };

  const intervals = new Set();
  const observedTargets = [];
  const sandbox = {
    location: { pathname: `/c/${cidToday}`, href: `https://127.0.0.1/c/${cidToday}`, search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: fakeDocument,
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class {
      observe(target) {
        observedTargets.push(target);
      }
      disconnect() {}
    },
    Intl,
    setTimeout: (fn) => {
      return 1;
    },
    clearTimeout() {},
    setInterval: (fn) => {
      const id = intervals.size + 1;
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    __agRequestActivityPreviews(raw) {
      previewRequests.push(JSON.parse(raw));
    },
    __agUpdateSettings(raw) {
      settingsPatches.push(JSON.parse(raw));
    },
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-test',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '/* test */',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
      selectors: {},
      userConfig: { modules: { activityView: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  // 1. Toggle button mounted immediately before sidebar-search-button with attention dot; zero poll timer while closed; observer scoped to sidebar
  const toggleBtn = elementsById.get('ag-activity-toggle-btn');
  assert.ok(toggleBtn, 'Activity View toggle button should be mounted');
  assert.equal(toggleBtn.nextElementSibling, searchBtn, 'Toggle button must be placed immediately left of search button');
  assert.equal(toggleBtn.getAttribute('data-active'), 'false');
  assert.ok(toggleBtn.innerHTML.includes('ag-av-toggle-dot'), 'Unread item should light up header attention dot');
  assert.equal(intervals.size, 0, 'Closed Activity View must not run background poll intervals');
  assert.deepEqual(observedTargets, [sidebarEl], 'MutationObserver must scope to sidebar root instead of document.body');

  // 2. Press macOS Opt+Cmd+U (with dead-key ¨) to open Activity View
  const keyListeners = winListeners.get('keydown') || [];
  let prevented = false;
  for (const fn of keyListeners) {
    fn({
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      code: 'KeyU',
      key: '¨',
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {}
    });
  }
  assert.equal(prevented, true);
  assert.equal(docAttrs.get('data-ag-activity-open'), 'true');
  assert.equal(toggleBtn.getAttribute('data-active'), 'true');
  assert.equal(intervals.size, 1, 'Opening Activity View should start preview refresh interval');

  const panel = elementsById.get('ag-activity-view');
  assert.ok(panel, 'Activity View panel should be mounted in conversation list parent');
  assert.ok(panel.innerHTML.includes('Priority'), 'Priority section header must render');
  assert.ok(panel.innerHTML.includes('排查 Antigravity Prompt 提议功能'));
  assert.ok(panel.innerHTML.includes('ag-av-fallback'), 'Cards without previews yet should show workspace folder fallback');
  assert.ok(panel.innerHTML.includes('claude_code'));
  assert.equal(previewRequests.length, 1, 'Opening Activity View should request previews from daemon');

  // 3. Deliver daemon SQLite preview for cidUnread -> card updates to 2-line preview while cidToday stays on folder fallback
  sandbox.__ag_on_activity_previews(previewRequests[0].reqId, {
    ok: true,
    previews: {
      [cidUnread]: { text: '用 Computer Use 实测后，agy not found 已经消失。', hasError: false, sig: '1:1' },
      [cidToday]: { text: '', hasError: false, sig: '1:1' }
    }
  });
  assert.ok(panel.innerHTML.includes('用 Computer Use 实测后，agy not found 已经消失。'));
  assert.ok(panel.innerHTML.includes('ag-av-preview'));
  assert.ok(panel.innerHTML.includes('ag-av-fallback'));

  // 4. Clicking cidUnread navigates via TanStack Router, marks read, holds card in Priority, and surfaces Clear read chats icon
  panel.dispatch('click', {
    target: {
      closest(sel) {
        if (sel === '.ag-av-card[data-cascade-id]') {
          return {
            getAttribute: (k) => (k === 'data-cascade-id' ? cidUnread : k === 'data-mod-sec' ? String(nowSec - 60) : null)
          };
        }
        return null;
      }
    }
  });
  assert.equal(navigated.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(navigated[0])), { to: '/c/$cascadeId', params: { cascadeId: cidUnread } });
  assert.ok(
    panel.innerHTML.includes('ag-activity-clear-read-btn'),
    'Reading a Priority card should keep it held in Priority and reveal the Clear read chats button'
  );

  // 5. Clicking Clear read chats removes the held read card from Priority
  panel.dispatch('click', {
    target: {
      closest: (sel) => (sel === '#ag-activity-clear-read-btn' ? { id: 'ag-activity-clear-read-btn' } : null)
    }
  });
  assert.ok(!panel.innerHTML.includes('ag-activity-clear-read-btn'), 'Clear read chats should flush read items from Priority');
  assert.ok(panel.innerHTML.includes('Nothing needs attention'), 'Empty Priority should show Codex empty state');

  // 6. Options menu toggles persist prefs via localStorage and __agUpdateSettings, and restore-defaults resets cleanly
  panel.dispatch('click', {
    target: {
      closest: (sel) => (sel === '#ag-activity-options-btn' ? makeEl('button', 'ag-activity-options-btn') : null)
    }
  });
  const optMenu = elementsById.get('ag-activity-options-menu');
  assert.ok(optMenu && optMenu.hidden === false, 'Options menu should open on sliders click');
  assert.ok(optMenu.innerHTML.includes('Priority section'));
  assert.ok(optMenu.innerHTML.includes('Unread only'));

  optMenu.dispatch('click', {
    target: {
      closest: (sel) =>
        sel === 'button[data-av-act]'
          ? { disabled: false, getAttribute: (k) => (k === 'data-av-act' ? 'toggle-unreadOnly' : null) }
          : null
    }
  });
  assert.equal(sandbox.__ag_get_activity_view_state().prefs.unreadOnly, true);
  assert.equal(JSON.parse(storageMap.get('ag-activity-view-prefs-v1')).unreadOnly, true);
  assert.ok(settingsPatches.some((p) => p.patch?.activityView?.unreadOnly === true));

  optMenu.dispatch('click', {
    target: {
      closest: (sel) =>
        sel === 'button[data-av-act]'
          ? { disabled: false, getAttribute: (k) => (k === 'data-av-act' ? 'restore-defaults' : null) }
          : null
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__ag_get_activity_view_state().prefs)), {
    showPriority: true,
    showPinned: false,
    showScheduled: false,
    unreadOnly: false
  });

  // 6b. Closing Activity View stops poll interval cleanly
  sandbox.__ag_set_activity_view_open(false);
  assert.equal(intervals.size, 0, 'Closing Activity View should stop background poll interval');
  sandbox.__ag_set_activity_view_open(true);
  assert.equal(intervals.size, 1);

  // 7. Cleanup functions cleanly remove DOM nodes, listeners, and intervals
  for (const fn of sandbox.__ag_cleanup_fns) fn();
  assert.equal(elementsById.get('ag-activity-toggle-btn'), undefined);
  assert.equal(elementsById.get('ag-activity-view'), undefined);
  assert.equal(elementsById.get('ag-activity-options-menu'), undefined);
  assert.equal(docAttrs.get('data-ag-activity-open'), undefined);
  assert.equal(intervals.size, 0);
});

test('Activity view degrades cleanly with zero DOM or timers when modules.activityView is false', () => {
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  let intervalsCreated = 0;
  let appendedToggle = false;
  const headEl = { appendChild() {} };
  const fakeDoc = {
    head: headEl,
    body: { classList: { contains: () => false }, style: { removeProperty() {} } },
    hidden: false,
    documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
    getElementById: () => null,
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), id: '', textContent: '', style: {}, setAttribute() {}, removeAttribute() {}, remove() {} };
      if (tag === 'button') appendedToggle = true;
      return el;
    },
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => false }),
    addEventListener() {},
    removeEventListener() {}
  };
  const sandbox = {
    location: { pathname: '/', href: 'https://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: fakeDoc,
    localStorage: { getItem: () => null, setItem() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => ++intervalsCreated,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    addEventListener() {},
    removeEventListener() {},
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-disabled-av',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: false },
      selectors: {},
      userConfig: { modules: { activityView: false } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);
  assert.equal(intervalsCreated, 0);
  assert.equal(appendedToggle, false);
});

test('75-settings-ui includes bilingual Sidebar Activity View toggle switch', () => {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '75-settings-ui.js'), 'utf8');
  assert.ok(src.includes('data-bind-mod="activityView"'));
  assert.ok(src.includes('Sidebar Activity View'));
  assert.ok(src.includes('侧栏活动视图'));
});

test('Updating activityView filter prefs preserves cachedPatchVersion (zero-reinjection) while updating boot script, and activityView defaults to false (Opt-in)', () => {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-av-cfg-'));
  try {
    // 0. Default Opt-in: omitting modules.activityView keeps it false
    fs.writeFileSync(
      path.join(tmpUserDir, 'config.json'),
      JSON.stringify({ enabled: true, preset: 'codex-dark', modules: { theme: true } }, null, 2),
      'utf8'
    );
    const defaultCtrl = createBundleController({
      cliOpts: { cliChannel: 'stable', safeMode: false },
      hasSqlite: true,
      userDir: tmpUserDir
    });
    defaultCtrl.rebuildBundleIfNeeded(true);
    assert.equal(defaultCtrl.getState().activeConfig.modules.activityView, false);

    fs.writeFileSync(
      path.join(tmpUserDir, 'config.json'),
      JSON.stringify({ enabled: true, preset: 'codex-dark', modules: { theme: true, activityView: true } }, null, 2),
      'utf8'
    );
    const ctrl = createBundleController({
      cliOpts: { cliChannel: 'stable', safeMode: false },
      hasSqlite: true,
      userDir: tmpUserDir
    });
    ctrl.rebuildBundleIfNeeded(true);
    const before = ctrl.getState();

    const res1 = ctrl.updateUserConfig({
      activityView: { showPriority: true, showPinned: true, showScheduled: false, unreadOnly: true }
    });
    assert.equal(res1.ok, true);
    const afterPref = ctrl.getState();
    assert.equal(afterPref.cachedPatchVersion, before.cachedPatchVersion);
    assert.equal(afterPref.activeConfig.activityView.unreadOnly, true);
    assert.equal(afterPref.activeConfig.activityView.showPinned, true);
    assert.ok(afterPref.cachedInjectScript.includes('"unreadOnly":true'));

    // Toggling modules.activityView MUST change cachedPatchVersion so live pages re-inject/cleanup
    const res2 = ctrl.updateUserConfig({ modules: { activityView: false } });
    assert.equal(res2.ok, true);
    const afterMod = ctrl.getState();
    assert.notEqual(afterMod.cachedPatchVersion, before.cachedPatchVersion);
    assert.equal(afterMod.activeConfig.modules.activityView, false);
    assert.equal(afterPref.activeConfig.activityViewConfigured, true);
  } finally {
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  }
});

test('extractLatestMessagePreviewFromDb handles >12 consecutive tool-only planner steps and unescapes markdown punctuation', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-av-deep-'));
  try {
    const dbPath = path.join(tmpDir, 'deep.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);'
    );
    const ins = db.prepare(
      'INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run(0, 15, 3, null, makePlannerStepPayload({ modifiedResponse: '每月赠送 \\$100 API 额度，详见 **docs**。' }));
    // Insert 20 consecutive thought/tool-only planner steps after idx=0 (previously missed by LIMIT 12)
    for (let i = 1; i <= 20; i++) {
      ins.run(i, 15, 3, null, makePlannerStepPayload({ thought: `tool step ${i}` }));
    }
    const res = extractLatestMessagePreviewFromDb(db);
    assert.equal(res.text, '每月赠送 $100 API 额度，详见 docs。');
    assert.equal(res.hasError, false);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Regression: serverUnread mark-as-read, showPriority=false mark-all-read, config precedence, collapsed re-expand, modSec preview refresh, tooltip child hover, and disposed globals', () => {
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  const docAttrs = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const previewRequests = [];
  let sidebarToggleClicks = 0;

  function makeEl(tag, id = '') {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      get id() {
        return attrs.get('id') || '';
      },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && elementsById.get(prev) === el) elementsById.delete(prev);
        attrs.set('id', String(v));
        if (v) elementsById.set(String(v), el);
      },
      type: '',
      hidden: false,
      disabled: false,
      scrollTop: 0,
      innerHTML: '',
      textContent: '',
      style: {},
      parentElement: null,
      parentNode: null,
      children,
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentElement.children.length ? this.parentElement.children[idx + 1] : null;
      },
      contains(other) {
        if (other === this) return true;
        for (const c of children) {
          if (c === other || (typeof c.contains === 'function' && c.contains(other))) return true;
        }
        return false;
      },
      setAttribute(k, v) {
        if (k === 'id') {
          this.id = v;
          return;
        }
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = el;
        child.parentNode = el;
        children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) child.remove();
        child.parentElement = el;
        child.parentNode = el;
        const idx = children.indexOf(ref);
        if (idx === -1) children.push(child);
        else children.splice(idx, 0, child);
        return child;
      },
      remove() {
        if (this.parentElement) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx !== -1) this.parentElement.children.splice(idx, 1);
          this.parentElement = null;
          this.parentNode = null;
        }
        if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        const list = listeners.get(type) || [];
        const fullEv = Object.assign({ preventDefault() {}, stopPropagation() {}, target: el }, ev);
        for (const fn of list) fn(fullEv);
      },
      click() {
        this.dispatch('click');
      },
      getBoundingClientRect: () => ({ left: 0, top: 173, right: 400, bottom: 900, width: 400, height: 727 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      closest(sel) {
        if (sel === `#${this.id}`) return this;
        return null;
      }
    };
    if (id) el.id = id;
    return el;
  }

  const headEl = makeEl('head');
  const bodyEl = makeEl('body');
  const topHeaderRow = makeEl('div');
  const sidebarToggleBtn = makeEl('button');
  sidebarToggleBtn.setAttribute('data-testid', 'sidebar-toggle');
  sidebarToggleBtn.addEventListener('click', () => {
    sidebarToggleClicks += 1;
    fakeStoreState.sideBar.isOpen = !fakeStoreState.sideBar.isOpen;
  });
  const searchBtn = makeEl('button');
  searchBtn.setAttribute('data-testid', 'sidebar-search-button');
  topHeaderRow.appendChild(sidebarToggleBtn);
  topHeaderRow.appendChild(searchBtn);

  const listParent = makeEl('div');
  const listEl = makeEl('div');
  listEl.setAttribute('data-testid', 'conversation-list-sidebar');
  listParent.appendChild(listEl);

  const nowSec = Math.floor(Date.now() / 1000);
  const cidServerUnread = '33333333-3333-3333-3333-333333333333';
  const cidSelected = '44444444-4444-4444-4444-444444444444';
  const storeSubscribers = [];
  const fakeStoreState = {
    sideBar: { isOpen: true },
    conversation: {
      convoState: { cascadeId: cidSelected },
      localLastViewedTimes: { [cidSelected]: nowSec }
    },
    sidebarProjects: { projects: [] },
    trajectorySummaries: {
      indexes: {
        topLevel: { [cidServerUnread]: true, [cidSelected]: true },
        active: {},
        pinned: {},
        archived: {},
        serverUnread: { [cidServerUnread]: true },
        hasWaitingSteps: {}
      },
      summaries: {
        [cidServerUnread]: {
          summary: 'Server Unread Chat',
          status: 1,
          lastModifiedTime: { seconds: String(nowSec - 30), nanos: 0 },
          annotations: {},
          trajectoryMetadata: { projectId: 'outside-of-project' }
        },
        [cidSelected]: {
          summary: 'Active Selected Chat',
          status: 1,
          lastModifiedTime: { seconds: String(nowSec - 10), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec), nanos: 0 } },
          trajectoryMetadata: { projectId: 'outside-of-project' }
        }
      }
    }
  };
  const fakeStore = {
    getState: () => fakeStoreState,
    subscribe: (fn) => {
      storeSubscribers.push(fn);
      return () => {
        const i = storeSubscribers.indexOf(fn);
        if (i !== -1) storeSubscribers.splice(i, 1);
      };
    }
  };
  listEl.__reactFiber$test = { memoizedProps: { value: { store: fakeStore } }, return: null };

  // Seed stale localStorage with showPriority: true, showPinned: true to verify boot.activityViewConfigured overrides it!
  const storageMap = new Map([
    ['ag-activity-view-prefs-v1', JSON.stringify({ showPriority: true, showPinned: true, showScheduled: false, unreadOnly: false })]
  ]);
  const fakeDocument = {
    head: headEl,
    body: bodyEl,
    hidden: false,
    documentElement: {
      style: { removeProperty() {} },
      setAttribute: (k, v) => docAttrs.set(k, String(v)),
      getAttribute: (k) => docAttrs.get(k) ?? null,
      removeAttribute: (k) => docAttrs.delete(k)
    },
    getElementById: (id) => elementsById.get(id) || null,
    createElement: (tag) => makeEl(tag),
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector(sel) {
      if (sel === '[data-testid="sidebar-search-button"]') return searchBtn;
      if (sel === '[data-testid="sidebar-toggle"]') return sidebarToggleBtn;
      if (sel === '[data-testid="conversation-list-sidebar"]') return listEl;
      return null;
    },
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => false }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    }
  };

  const sandbox = {
    location: { pathname: `/c/${cidSelected}`, href: `https://127.0.0.1/c/${cidSelected}`, search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: fakeDocument,
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Intl,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    __agRequestActivityPreviews(raw) {
      previewRequests.push(JSON.parse(raw));
    },
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-reg',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: true, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: false, showPinned: false, showScheduled: false, unreadOnly: false },
      activityViewConfigured: true,
      selectors: {},
      userConfig: { modules: { activityView: true, i18n: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  // 1. Authoritative boot.activityView (showPriority: false, showPinned: false) overrode stale localStorage!
  assert.equal(sandbox.__ag_get_activity_view_state().prefs.showPriority, false);
  assert.equal(sandbox.__ag_get_activity_view_state().prefs.showPinned, false);

  // Open Activity View -> verify Chinese UI labels (i18n: true)
  sandbox.__ag_set_activity_view_open(true);
  const panel = elementsById.get('ag-activity-view');
  assert.ok(panel.innerHTML.includes('今天'), 'Chinese Today heading should render when modules.i18n is true');
  assert.ok(panel.innerHTML.includes('项目外'), 'Chinese Outside of Project label should render');
  assert.ok(panel.innerHTML.includes('data-unread="true"'), 'serverUnread chat should render as unread');

  // 2. With showPriority: false, Mark all as read must STILL be enabled and clear serverUnread!
  panel.dispatch('click', {
    target: { closest: (sel) => (sel === '#ag-activity-options-btn' ? makeEl('button', 'ag-activity-options-btn') : null) }
  });
  const optMenu = elementsById.get('ag-activity-options-menu');
  assert.ok(optMenu.innerHTML.includes('全部标为已读'));
  assert.ok(!optMenu.innerHTML.includes('data-av-act="mark-all-read" disabled'), 'Mark all as read must not be disabled when eligible unread chats exist');

  optMenu.dispatch('click', {
    target: {
      closest: (sel) =>
        sel === 'button[data-av-act]'
          ? { disabled: false, getAttribute: (k) => (k === 'data-av-act' ? 'mark-all-read' : null) }
          : null
    }
  });
  assert.ok(!panel.innerHTML.includes('data-unread="true"'), 'Mark all as read must suppress serverUnread locally');

  // 3. If a brand-new message arrives later (lastModifiedTime advances past localReadTimes), serverUnread re-activates!
  fakeStoreState.trajectorySummaries = {
    ...fakeStoreState.trajectorySummaries,
    summaries: {
      ...fakeStoreState.trajectorySummaries.summaries,
      [cidServerUnread]: {
        ...fakeStoreState.trajectorySummaries.summaries[cidServerUnread],
        lastModifiedTime: { seconds: String(nowSec + 60), nanos: 0 }
      }
    }
  };
  for (const sub of storeSubscribers) sub();
  assert.ok(panel.innerHTML.includes('data-unread="true"'), 'New message advancing modSec must re-activate unread state');

  // 4. Instant preview re-fetch when modSec advances on already-cached conversation (including mid-flight updates)!
  assert.equal(previewRequests.length, 1);
  sandbox.__ag_on_activity_previews(previewRequests[0].reqId, {
    ok: true,
    sqliteAvailable: true,
    previews: {
      [cidServerUnread]: { text: 'Old reply', hasError: false, sig: '1:1' },
      [cidSelected]: { text: 'Selected reply', hasError: false, sig: '1:1' }
    }
  });
  // Because cidServerUnread advanced while request 0 was in-flight, request 1 immediately re-fetches cidServerUnread
  assert.equal(previewRequests.length, 2, 'Mid-flight modSec advance on cidServerUnread should immediately re-fetch');
  assert.deepEqual(Array.from(previewRequests[1].cascadeIds), [cidServerUnread]);

  fakeStoreState.trajectorySummaries = {
    ...fakeStoreState.trajectorySummaries,
    summaries: {
      ...fakeStoreState.trajectorySummaries.summaries,
      [cidSelected]: {
        ...fakeStoreState.trajectorySummaries.summaries[cidSelected],
        lastModifiedTime: { seconds: String(nowSec + 120), nanos: 0 }
      }
    }
  };
  for (const sub of storeSubscribers) sub();
  assert.equal(previewRequests.length, 3, 'Advancing modSec on cached cidSelected should trigger immediate preview refresh');
  assert.ok(previewRequests[2].cascadeIds.includes(cidSelected));

  // 5. Tooltip mouseout into a child element of the button must NOT hide the tooltip
  const fakeOptBtn = makeEl('button', 'ag-activity-options-btn');
  fakeOptBtn.setAttribute('data-av-tip', '活动视图选项');
  const fakeSvgChild = makeEl('svg');
  fakeOptBtn.appendChild(fakeSvgChild);
  panel.dispatch('mouseover', {
    target: { closest: (sel) => (sel.includes('#ag-activity-options-btn') ? fakeOptBtn : null) }
  });
  assert.equal(elementsById.get('ag-activity-tooltip')?.getAttribute('data-open'), 'true');
  panel.dispatch('mouseout', {
    target: { closest: (sel) => (sel.includes('#ag-activity-options-btn') ? fakeOptBtn : null) },
    relatedTarget: fakeSvgChild
  });
  assert.equal(elementsById.get('ag-activity-tooltip')?.getAttribute('data-open'), 'true', 'Moving pointer onto child SVG must keep tooltip open');
  panel.dispatch('mouseout', {
    target: { closest: (sel) => (sel.includes('#ag-activity-options-btn') ? fakeOptBtn : null) },
    relatedTarget: panel
  });
  assert.equal(elementsById.get('ag-activity-tooltip')?.getAttribute('data-open'), null, 'Leaving button must hide tooltip');

  // 6. Collapsing sidebar while Activity View is open: toggling expands sidebar instead of closing hidden view
  fakeStoreState.sideBar.isOpen = false;
  sandbox.__ag_toggle_activity_view();
  assert.equal(sidebarToggleClicks, 1, 'Toggling while open & collapsed must expand sidebar');
  assert.equal(fakeStoreState.sideBar.isOpen, true);
  assert.equal(docAttrs.get('data-ag-activity-open'), 'true');

  // 7. Cleanup removes window globals AND makes old captured closure references strict no-ops
  const staleToggle = sandbox.__ag_toggle_activity_view;
  const staleSetOpen = sandbox.__ag_set_activity_view_open;
  for (const fn of sandbox.__ag_cleanup_fns) fn();
  assert.equal(sandbox.__ag_toggle_activity_view, undefined);
  assert.equal(sandbox.__ag_set_activity_view_open, undefined);
  assert.equal(sandbox.__ag_on_activity_previews, undefined);
  assert.equal(sandbox.__ag_on_activity_prefs_sync, undefined);
  assert.equal(sandbox.__ag_get_activity_view_state, undefined);
  staleToggle();
  staleSetOpen(true);
  assert.equal(docAttrs.get('data-ag-activity-open'), undefined, 'Disposed closure must not mutate documentElement');
});

test('Running sessions (agent working / background tasks) render neutral running indicators instead of blue unread dot until finished', () => {
  const h = loadActivityPureHelpers();

  // Active/working takes precedence over unread
  assert.equal(h.classifyConversationAttention({ isActive: true, isUnread: true }), 'active');
  assert.equal(h.classifyConversationAttention({ isActive: false, isUnread: true }), 'unread');
  assert.equal(h.classifyConversationAttention({ hasWaiting: true, isActive: true }), 'waiting');
  assert.equal(h.classifyConversationAttention({ hasError: true, isActive: true }), 'error');

  // Mount runtime with a background-task-running session (status=1, backgroundTaskCount=2, also has newer modSec)
  // and an agent-working session (status=2)
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  const docAttrs = new Map();
  function makeEl(tag, id = '') {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && elementsById.get(prev) === el) elementsById.delete(prev);
        attrs.set('id', String(v));
        if (v) elementsById.set(String(v), el);
      },
      hidden: false,
      scrollTop: 0,
      innerHTML: '',
      textContent: '',
      style: {},
      parentElement: null,
      parentNode: null,
      children,
      setAttribute(k, v) { if (k === 'id') this.id = v; else attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      insertBefore(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      remove() { if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id); },
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    };
    if (id) el.id = id;
    return el;
  }

  const headEl = makeEl('head');
  const bodyEl = makeEl('body');
  const headerRow = makeEl('div');
  const searchBtn = makeEl('button');
  searchBtn.setAttribute('data-testid', 'sidebar-search-button');
  headerRow.appendChild(searchBtn);
  const listParent = makeEl('div');
  const listEl = makeEl('div');
  listEl.setAttribute('data-testid', 'conversation-list-sidebar');
  listParent.appendChild(listEl);

  const nowSec = Math.floor(Date.now() / 1000);
  const cidTasks = '55555555-5555-5555-5555-555555555555';
  const cidWorking = '66666666-6666-6666-6666-666666666666';
  const subscribers = [];
  const storeState = {
    sideBar: { isOpen: true },
    conversation: { convoState: { cascadeId: '' }, localLastViewedTimes: {} },
    sidebarProjects: { projects: [] },
    trajectorySummaries: {
      indexes: {
        topLevel: { [cidTasks]: true, [cidWorking]: true },
        active: { [cidTasks]: true, [cidWorking]: true },
        pinned: {},
        archived: {},
        serverUnread: { [cidTasks]: true },
        hasWaitingSteps: {}
      },
      summaries: {
        [cidTasks]: {
          summary: 'Codex Session Solution Consultation',
          status: 1,
          notFullyIdle: true,
          hasActivity: true,
          backgroundTaskCount: 2,
          lastModifiedTime: { seconds: String(nowSec - 10), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec - 600), nanos: 0 } },
          trajectoryMetadata: { projectId: 'outside-of-project' }
        },
        [cidWorking]: {
          summary: 'Streaming Agent Session',
          status: 2,
          notFullyIdle: true,
          hasActivity: true,
          backgroundTaskCount: 0,
          lastModifiedTime: { seconds: String(nowSec - 5), nanos: 0 },
          annotations: {},
          trajectoryMetadata: { projectId: 'outside-of-project' }
        }
      }
    }
  };
  listEl.__reactFiber$test = {
    memoizedProps: {
      value: {
        store: {
          getState: () => storeState,
          subscribe: (fn) => { subscribers.push(fn); return () => {}; }
        }
      }
    },
    return: null
  };

  const sandbox = {
    location: { pathname: '/', href: 'https://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: {
      head: headEl,
      body: bodyEl,
      hidden: false,
      documentElement: {
        style: { removeProperty() {} },
        setAttribute: (k, v) => docAttrs.set(k, String(v)),
        getAttribute: (k) => docAttrs.get(k) ?? null,
        removeAttribute: (k) => docAttrs.delete(k)
      },
      getElementById: (id) => elementsById.get(id) || null,
      createElement: (t) => makeEl(t),
      getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
      querySelector: (s) =>
        s === '[data-testid="sidebar-search-button"]'
          ? searchBtn
          : s === '[data-testid="conversation-list-sidebar"]'
          ? listEl
          : null,
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    Intl,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    addEventListener() {},
    removeEventListener() {},
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-running-ind',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
      selectors: {},
      userConfig: { modules: { activityView: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  sandbox.__ag_set_activity_view_open(true);
  const panel = elementsById.get('ag-activity-view');
  // Neither running session should render a blue dot (.ag-av-dot) or data-unread="true"
  assert.ok(!panel.innerHTML.includes('ag-av-dot'), 'Running sessions must never render a blue unread dot');
  assert.ok(!panel.innerHTML.includes('data-unread="true"'), 'Running sessions must not be marked data-unread="true"');
  assert.ok(panel.innerHTML.includes('ag-av-indicator-task'), 'Background-task session should render task-running >_ icon');
  assert.ok(panel.innerHTML.includes('2 tasks running'), 'Background-task tooltip should report running task count');
  assert.ok(panel.innerHTML.includes('ag-av-indicator-working'), 'Agent-running session should render neutral working spinner');

  // Once the 2 background tasks finish, the unread session transitions to the blue unread dot!
  storeState.trajectorySummaries = {
    ...storeState.trajectorySummaries,
    indexes: {
      ...storeState.trajectorySummaries.indexes,
      active: { ...storeState.trajectorySummaries.indexes.active, [cidTasks]: false }
    },
    summaries: {
      ...storeState.trajectorySummaries.summaries,
      [cidTasks]: {
        ...storeState.trajectorySummaries.summaries[cidTasks],
        notFullyIdle: false,
        hasActivity: false,
        backgroundTaskCount: 0
      }
    }
  };
  for (const sub of subscribers) sub();
  assert.ok(panel.innerHTML.includes('ag-av-dot" data-state="unread"'), 'Finished unread session must transition to blue unread dot');
  assert.ok(panel.innerHTML.includes('data-unread="true"'));

  for (const fn of sandbox.__ag_cleanup_fns) fn();
});

test('Right-clicking Activity View cards delegates to native conversation context menu, bridges Rename, syncs native Mark Unread, and falls back for unmounted rows', () => {
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  const docAttrs = new Map();
  const observers = [];

  function makeEl(tag, id = '') {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && elementsById.get(prev) === el) elementsById.delete(prev);
        attrs.set('id', String(v));
        if (v) elementsById.set(String(v), el);
      },
      hidden: false,
      scrollTop: 0,
      innerHTML: '',
      textContent: '',
      style: {},
      parentElement: null,
      parentNode: null,
      children,
      setAttribute(k, v) { if (k === 'id') this.id = v; else attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      insertBefore(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      remove() { if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id); },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      dispatch(t, ev = {}) {
        const list = listeners.get(t) || [];
        const full = Object.assign({ preventDefault() {}, stopPropagation() {}, target: el }, ev);
        for (const fn of list) fn(full);
        return full;
      },
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 200, bottom: 50, width: 190, height: 40 }),
      querySelector: () => null,
      querySelectorAll: () => []
    };
    if (id) el.id = id;
    return el;
  }

  const headEl = makeEl('head');
  const bodyEl = makeEl('body');
  const headerRow = makeEl('div');
  const searchBtn = makeEl('button');
  searchBtn.setAttribute('data-testid', 'sidebar-search-button');
  headerRow.appendChild(searchBtn);
  const listParent = makeEl('div');
  const listEl = makeEl('div');
  listEl.setAttribute('data-testid', 'conversation-list-sidebar');
  listParent.appendChild(listEl);

  const nowSec = Math.floor(Date.now() / 1000);
  const cidMounted = '77777777-7777-7777-7777-777777777777';
  const cidUnmounted = '88888888-8888-8888-8888-888888888888';

  const dispatchedEvents = [];
  let renameInput = null;
  let scrolledIntoView = false;
  let focusedRename = false;
  let selectedRename = false;
  const nativeRow = makeEl('div');
  nativeRow.setAttribute('data-testid', 'conversation-row-sidebar');
  nativeRow.setAttribute('data-cascade-id', cidMounted);
  nativeRow.dispatchEvent = (ev) => {
    dispatchedEvents.push(ev);
    return true;
  };
  nativeRow.scrollIntoView = () => {
    scrolledIntoView = true;
  };
  nativeRow.querySelector = (sel) => (sel === 'input' ? renameInput : null);

  const subscribers = [];
  const storeState = {
    sideBar: { isOpen: true },
    conversation: { convoState: { cascadeId: '' }, localLastViewedTimes: { [cidMounted]: nowSec } },
    sidebarProjects: { projects: [] },
    trajectorySummaries: {
      indexes: {
        topLevel: { [cidMounted]: true, [cidUnmounted]: true },
        active: {},
        pinned: {},
        archived: {},
        serverUnread: {},
        hasWaitingSteps: {}
      },
      summaries: {
        [cidMounted]: {
          summary: 'Mounted Conversation',
          status: 1,
          lastModifiedTime: { seconds: String(nowSec - 20), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec), nanos: 0 } },
          trajectoryMetadata: { projectId: 'outside-of-project' }
        },
        [cidUnmounted]: {
          summary: 'Older Unmounted Chat',
          status: 1,
          lastModifiedTime: { seconds: String(nowSec - 120), nanos: 0 },
          annotations: { lastUserViewTime: { seconds: String(nowSec), nanos: 0 } },
          trajectoryMetadata: { projectId: 'outside-of-project' }
        }
      }
    }
  };
  listEl.__reactFiber$test = {
    memoizedProps: {
      value: {
        store: {
          getState: () => storeState,
          subscribe: (fn) => { subscribers.push(fn); return () => {}; }
        }
      }
    },
    return: null
  };

  class FakeMouseEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  const storageMap = new Map([['ag-activity-read-times-v1', JSON.stringify({ [cidMounted]: nowSec + 10 })]]);
  const sandbox = {
    MouseEvent: FakeMouseEvent,
    location: { pathname: '/', href: 'https://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: {
      head: headEl,
      body: bodyEl,
      hidden: false,
      documentElement: {
        style: { removeProperty() {} },
        setAttribute: (k, v) => docAttrs.set(k, String(v)),
        getAttribute: (k) => docAttrs.get(k) ?? null,
        removeAttribute: (k) => docAttrs.delete(k)
      },
      getElementById: (id) => elementsById.get(id) || null,
      createElement: (t) => makeEl(t),
      getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
      querySelector(sel) {
        if (sel === '[data-testid="sidebar-search-button"]') return searchBtn;
        if (sel === '[data-testid="conversation-list-sidebar"]') return listEl;
        if (sel === `[data-testid="conversation-row-sidebar"][data-cascade-id="${cidMounted}"]`) return nativeRow;
        return null;
      },
      querySelectorAll: (sel) => (sel === '[data-testid="conversation-row-sidebar"]' ? [nativeRow] : []),
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.target = null;
        observers.push(this);
      }
      observe(t) {
        this.target = t;
      }
      disconnect() {
        this.target = null;
      }
    },
    Intl,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    addEventListener() {},
    removeEventListener() {},
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.3-ctx',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
      selectors: {},
      userConfig: { modules: { activityView: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  sandbox.__ag_set_activity_view_open(true);
  const panel = elementsById.get('ag-activity-view');

  // 1. Right-click mounted conversation -> forwards MouseEvent('contextmenu') with cursor coords to nativeRow
  let prevented = false;
  const fakeMountedCard = {
    getAttribute: (k) => (k === 'data-cascade-id' ? cidMounted : k === 'data-mod-sec' ? String(nowSec - 20) : null),
    querySelector: () => ({ textContent: 'Mounted Conversation' })
  };
  panel.dispatch('contextmenu', {
    clientX: 140,
    clientY: 220,
    screenX: 540,
    screenY: 320,
    preventDefault() { prevented = true; },
    stopPropagation() {},
    target: { closest: (sel) => (sel === '.ag-av-card[data-cascade-id]' ? fakeMountedCard : null) }
  });
  assert.equal(prevented, true);
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, 'contextmenu');
  assert.equal(dispatchedEvents[0].bubbles, true);
  assert.equal(dispatchedEvents[0].clientX, 140);
  assert.equal(dispatchedEvents[0].clientY, 220);

  // 2. Selecting Rename in native menu mounts <input> in nativeRow -> temporarily reveals native sidebar, focuses input, and restores Activity View on completion
  const rowObs = observers.find((o) => o.target === nativeRow);
  assert.ok(rowObs, 'Rename watcher observer must attach to nativeRow');
  renameInput = {
    focus() { focusedRename = true; },
    select() { selectedRename = true; }
  };
  rowObs.cb();
  assert.equal(docAttrs.get('data-ag-activity-open'), undefined, 'Activity View should temporarily close to expose native Rename input');
  assert.equal(scrolledIntoView, true);
  assert.equal(focusedRename, true);
  assert.equal(selectedRename, true);

  renameInput = null;
  rowObs.cb();
  assert.equal(docAttrs.get('data-ag-activity-open'), 'true', 'Activity View should automatically restore after Rename finishes');

  // 3. Selecting native "Mark Unread" (serverUnread flips false -> true) clears localReadTimes and activates blue unread dot
  storeState.trajectorySummaries = {
    ...storeState.trajectorySummaries,
    indexes: {
      ...storeState.trajectorySummaries.indexes,
      serverUnread: { ...storeState.trajectorySummaries.indexes.serverUnread, [cidMounted]: true }
    }
  };
  for (const sub of subscribers) sub();
  assert.ok(panel.innerHTML.includes('ag-av-dot" data-state="unread"'), 'Native Mark Unread must clear localReadTimes suppression');

  // 4. Right-clicking an unmounted conversation opens fallback context menu with Copy Name / Copy ID / Open / Mark Unread
  const fakeUnmountedCard = {
    getAttribute: (k) => (k === 'data-cascade-id' ? cidUnmounted : k === 'data-mod-sec' ? String(nowSec - 120) : k === 'data-unread' ? 'false' : 'idle'),
    querySelector: () => ({ textContent: 'Older Unmounted Chat' })
  };
  panel.dispatch('contextmenu', {
    clientX: 160,
    clientY: 280,
    preventDefault() {},
    stopPropagation() {},
    target: { closest: (sel) => (sel === '.ag-av-card[data-cascade-id]' ? fakeUnmountedCard : null) }
  });
  const fallbackMenu = elementsById.get('ag-activity-options-menu');
  assert.ok(fallbackMenu && fallbackMenu.hidden === false, 'Fallback context menu should open for unmounted cards');
  assert.ok(fallbackMenu.innerHTML.includes('Copy Conversation Name'));
  assert.ok(fallbackMenu.innerHTML.includes('Copy Conversation ID'));

  // 4b. Cross-window prefs sync while fallback context menu is open MUST NOT overwrite the card context menu!
  sandbox.__ag_on_activity_prefs_sync({ showPriority: true, showPinned: true, showScheduled: false, unreadOnly: false });
  assert.equal(sandbox.__ag_get_activity_view_state().prefs.showPinned, true);
  assert.ok(fallbackMenu.innerHTML.includes('Copy Conversation Name'), 'Fallback context menu must not be overwritten by prefs sync');
  assert.ok(!fallbackMenu.innerHTML.includes('Priority section'), 'Options menu must not replace open card context menu');

  for (const fn of sandbox.__ag_cleanup_fns) fn();
});

test('PR #20 review fixes: Redux slice O(1) skip & closed fast scan, sqliteAvailable=false stop-loop, pending timer/rAF cleanup, Rename session preservation & safe cid navigation', () => {
  // A. activity-previews returns sqliteAvailable: false when DatabaseSync is unavailable (Node < 22.13)
  const noSqliteReader = createActivityPreviewReader({ getDatabaseSync: () => null });
  const noSqlRes = noSqliteReader.getActivityPreviews(['11111111-1111-1111-1111-111111111111'], os.tmpdir());
  assert.deepEqual(noSqlRes, { ok: true, sqliteAvailable: false, previews: {} });

  // B. Runtime checks: slice skip, closed fast scan, sqliteAvailable=false stop-loop, timer/rAF cleanup, Rename state preservation, safe cid selector
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const code = ['00-head.js', '65-activity-view.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  const docAttrs = new Map();
  const observers = [];
  const previewRequests = [];
  const activeTimeouts = new Map();
  const activeRafs = new Map();
  let nextTimerId = 1;
  let nextRafId = 1;
  let rafScheduleCount = 0;

  function makeEl(tag, id = '') {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        const prev = attrs.get('id');
        if (prev && elementsById.get(prev) === el) elementsById.delete(prev);
        attrs.set('id', String(v));
        if (v) elementsById.set(String(v), el);
      },
      hidden: false,
      scrollTop: 0,
      innerHTML: '',
      textContent: '',
      style: {},
      parentElement: null,
      parentNode: null,
      children,
      setAttribute(k, v) { if (k === 'id') this.id = v; else attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      insertBefore(c) { c.parentElement = el; c.parentNode = el; children.push(c); return c; },
      remove() { if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id); },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      dispatch(t, ev = {}) {
        const list = listeners.get(t) || [];
        const full = Object.assign({ preventDefault() {}, stopPropagation() {}, target: el }, ev);
        for (const fn of list) fn(full);
        return full;
      },
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 200, bottom: 50, width: 190, height: 40 }),
      querySelector: () => null,
      querySelectorAll: () => []
    };
    if (id) el.id = id;
    return el;
  }

  const headEl = makeEl('head');
  const bodyEl = makeEl('body');
  const sidebarEl = makeEl('aside');
  sidebarEl.setAttribute('class', 'bg-sidebar');
  const headerRow = makeEl('div');
  const searchBtn = makeEl('button');
  searchBtn.setAttribute('data-testid', 'sidebar-search-button');
  searchBtn.closest = (sel) => (sel.includes('aside') || sel.includes('.bg-sidebar') ? sidebarEl : null);
  headerRow.appendChild(searchBtn);
  sidebarEl.appendChild(headerRow);
  const listParent = makeEl('div');
  const listEl = makeEl('div');
  listEl.setAttribute('data-testid', 'conversation-list-sidebar');
  listEl.closest = (sel) => (sel.includes('aside') || sel.includes('.bg-sidebar') ? sidebarEl : null);
  listParent.appendChild(listEl);
  sidebarEl.appendChild(listParent);

  const nowSec = Math.floor(Date.now() / 1000);
  const cid1 = '11111111-1111-1111-1111-111111111111';
  const cidOdd = 'custom"]unsafe-id';
  let oddLinkClicked = false;
  let renameInput = null;
  const nativeRow1 = makeEl('div');
  nativeRow1.setAttribute('data-testid', 'conversation-row-sidebar');
  nativeRow1.setAttribute('data-cascade-id', cid1);
  nativeRow1.dispatchEvent = () => true;
  nativeRow1.querySelector = (sel) => (sel === 'input' ? renameInput : null);

  const nativeRowOdd = makeEl('div');
  nativeRowOdd.setAttribute('data-testid', 'conversation-row-sidebar');
  nativeRowOdd.setAttribute('data-cascade-id', cidOdd);
  nativeRowOdd.querySelector = (sel) =>
    sel === 'a[href]' ? { click() { oddLinkClicked = true; } } : null;

  const summaries = {
    [cid1]: {
      summary: 'Held Priority Chat',
      status: 1,
      lastModifiedTime: { seconds: String(nowSec - 10), nanos: 0 },
      annotations: { lastUserViewTime: { seconds: String(nowSec - 300), nanos: 0 } },
      trajectoryMetadata: { projectId: 'outside-of-project' }
    }
  };
  const topLevel = { [cid1]: true };
  for (let i = 0; i < 12; i++) {
    const id = `22222222-2222-2222-2222-${String(i).padStart(12, '0')}`;
    topLevel[id] = true;
    summaries[id] = {
      summary: `Recent Chat ${i}`,
      status: 1,
      lastModifiedTime: { seconds: String(nowSec - 100 - i * 10), nanos: 0 },
      annotations: { lastUserViewTime: { seconds: String(nowSec), nanos: 0 } },
      trajectoryMetadata: { projectId: 'outside-of-project' }
    };
  }
  const subscribers = [];
  const storeState = {
    inputDrafts: { text: '' },
    sideBar: { isOpen: true },
    conversation: { convoState: { cascadeId: '' }, localLastViewedTimes: {} },
    sidebarProjects: { projects: [] },
    trajectorySummaries: {
      indexes: { topLevel, active: {}, pinned: {}, archived: {}, serverUnread: { [cid1]: true }, hasWaitingSteps: {} },
      summaries
    }
  };
  listEl.__reactFiber$test = {
    memoizedProps: {
      value: {
        store: {
          getState: () => storeState,
          subscribe: (fn) => { subscribers.push(fn); return () => {}; }
        }
      }
    },
    return: null
  };

  class FakeMouseEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  let autoFlushRaf = true;
  const sandbox = {
    MouseEvent: FakeMouseEvent,
    location: { pathname: '/', href: 'https://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: {
      head: headEl,
      body: bodyEl,
      hidden: false,
      documentElement: {
        style: { removeProperty() {} },
        setAttribute: (k, v) => docAttrs.set(k, String(v)),
        getAttribute: (k) => docAttrs.get(k) ?? null,
        removeAttribute: (k) => docAttrs.delete(k)
      },
      getElementById: (id) => elementsById.get(id) || null,
      createElement: (t) => makeEl(t),
      getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
      querySelector(sel) {
        if (sel.includes('unsafe-id')) throw new Error('DOMException: invalid selector');
        if (sel === '[data-testid="sidebar-search-button"]') return searchBtn;
        if (sel === '[data-testid="conversation-list-sidebar"]') return listEl;
        if (sel === `[data-testid="conversation-row-sidebar"][data-cascade-id="${cid1}"]`) return nativeRow1;
        return null;
      },
      querySelectorAll: (sel) => (sel === '[data-testid="conversation-row-sidebar"]' ? [nativeRow1, nativeRowOdd] : []),
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.target = null; observers.push(this); }
      observe(t) { this.target = t; }
      disconnect() { this.target = null; }
    },
    Intl,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      activeTimeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { activeTimeouts.delete(id); },
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame(fn) {
      rafScheduleCount += 1;
      const id = nextRafId++;
      activeRafs.set(id, fn);
      if (autoFlushRaf) {
        activeRafs.delete(id);
        fn();
      }
      return id;
    },
    cancelAnimationFrame(id) { activeRafs.delete(id); },
    addEventListener() {},
    removeEventListener() {},
    __agRequestActivityPreviews(raw) { previewRequests.push(JSON.parse(raw)); },
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.4-pr20',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
      selectors: {},
      userConfig: { modules: { activityView: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  // 1. Closed fast scan sets attention dot WITHOUT creating #ag-activity-view panel
  const toggleBtn = elementsById.get('ag-activity-toggle-btn');
  assert.ok(toggleBtn && toggleBtn.innerHTML.includes('ag-av-toggle-dot'));
  assert.equal(elementsById.get('ag-activity-view'), undefined, 'Closed fast scan should not mount panel DOM');

  // 2. Unrelated Redux dispatches (e.g. typing in inputDrafts) skip scheduleRender in O(1)
  const rafBefore = rafScheduleCount;
  for (let i = 0; i < 20; i++) {
    storeState.inputDrafts = { text: 'typing ' + i };
    for (const sub of subscribers) sub();
  }
  assert.equal(rafScheduleCount, rafBefore, 'Unrelated Redux slices must not schedule any render');

  // 3. Open Activity View, click Show more (visibleLimit -> 20), click cid1 (held read in Priority), then trigger Rename -> state preserved!
  sandbox.__ag_set_activity_view_open(true);
  const panel = elementsById.get('ag-activity-view');
  assert.equal(previewRequests.length, 1);

  // Deliver sqliteAvailable: false -> stops ALL future preview RPC requests!
  sandbox.__ag_on_activity_previews(previewRequests[0].reqId, { ok: true, sqliteAvailable: false, previews: {} });
  panel.dispatch('click', { target: { closest: (s) => (s === '.ag-av-more-btn' ? {} : null) } });
  assert.equal(sandbox.__ag_get_activity_view_state().visibleLimit, 20);
  assert.equal(previewRequests.length, 1, 'No further preview RPCs may fire after sqliteAvailable === false');

  // Click cid1 to mark read & keep held in Priority (revealing Clear read chats)
  panel.dispatch('click', {
    target: {
      closest: (s) =>
        s === '.ag-av-card[data-cascade-id]'
          ? { getAttribute: (k) => (k === 'data-cascade-id' ? cid1 : k === 'data-mod-sec' ? String(nowSec - 10) : null) }
          : null
    }
  });
  assert.ok(panel.innerHTML.includes('ag-activity-clear-read-btn'));

  // Trigger right-click -> Rename -> finish Rename: visibleLimit (20) AND held Priority card MUST be preserved!
  panel.dispatch('contextmenu', {
    clientX: 100,
    clientY: 200,
    preventDefault() {},
    stopPropagation() {},
    target: { closest: (s) => (s === '.ag-av-card[data-cascade-id]' ? { getAttribute: (k) => (k === 'data-cascade-id' ? cid1 : null) } : null) }
  });
  const rowObs = observers.find((o) => o.target === nativeRow1);
  renameInput = { focus() {}, select() {} };
  rowObs.cb();
  assert.equal(docAttrs.get('data-ag-activity-open'), undefined);
  renameInput = null;
  rowObs.cb();
  assert.equal(docAttrs.get('data-ag-activity-open'), 'true');
  assert.equal(sandbox.__ag_get_activity_view_state().visibleLimit, 20, 'Rename must preserve visibleLimit pagination');
  assert.ok(panel.innerHTML.includes('ag-activity-clear-read-btn'), 'Rename must preserve held-read Priority state');

  // 4. Safe non-UUID cid navigation does not throw invalid selector error and clicks matching native row link
  panel.dispatch('click', {
    target: {
      closest: (s) =>
        s === '.ag-av-card[data-cascade-id]'
          ? { getAttribute: (k) => (k === 'data-cascade-id' ? cidOdd : k === 'data-mod-sec' ? '0' : null) }
          : null
    }
  });
  assert.equal(oddLinkClicked, true, 'Non-UUID cid navigation must safely traverse rows instead of interpolating raw selector');

  // 5. Cleanup cancels pending rAF cleanly
  autoFlushRaf = false;
  storeState.trajectorySummaries = { ...storeState.trajectorySummaries };
  for (const sub of subscribers) sub();
  assert.equal(activeRafs.size, 1, 'Pending rAF should be queued before cleanup');
  for (const fn of sandbox.__ag_cleanup_fns) fn();
  assert.equal(activeRafs.size, 0, 'Cleanup must cancel pending requestAnimationFrame');
  assert.equal(activeTimeouts.size, 0, 'Cleanup must clear all pending timeouts');

  // 6. Cleanup also explicitly clears active 6s preview request timeouts while in-flight
  const inflightTimeouts = new Map();
  let inflightTimerSeq = 1;
  const sb2Elements = new Map();
  const makeMiniEl = (tag, id = '') => {
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) sb2Elements.set(String(v), el); },
      hidden: false, scrollTop: 0, innerHTML: '', textContent: '', style: {}, parentElement: null, parentNode: null, children: [],
      setAttribute(k, v) { if (k === 'id') this.id = v; else attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = el; c.parentNode = el; el.children.push(c); return c; },
      insertBefore(c) { c.parentElement = el; c.parentNode = el; el.children.push(c); return c; },
      remove() { if (this.id) sb2Elements.delete(this.id); },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
    };
    if (id) el.id = id;
    return el;
  };
  const h2 = makeMiniEl('head');
  const b2 = makeMiniEl('body');
  const hdr2 = makeMiniEl('div');
  const sBtn2 = makeMiniEl('button');
  sBtn2.setAttribute('data-testid', 'sidebar-search-button');
  hdr2.appendChild(sBtn2);
  const lp2 = makeMiniEl('div');
  const l2 = makeMiniEl('div');
  l2.setAttribute('data-testid', 'conversation-list-sidebar');
  l2.__reactFiber$test = { memoizedProps: { value: { store: { getState: () => storeState, subscribe: () => () => {} } } }, return: null };
  lp2.appendChild(l2);
  const sb2 = {
    location: { pathname: '/', href: 'https://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: {
      head: h2, body: b2, hidden: false,
      documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
      getElementById: (id) => sb2Elements.get(id) || null,
      createElement: (t) => makeMiniEl(t),
      getElementsByTagName: (t) => (t === 'head' ? [h2] : []),
      querySelector: (s) => (s === '[data-testid="sidebar-search-button"]' ? sBtn2 : s === '[data-testid="conversation-list-sidebar"]' ? l2 : null),
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener() {}, removeEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    Intl,
    setTimeout(fn, ms) {
      const id = inflightTimerSeq++;
      inflightTimeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { inflightTimeouts.delete(id); },
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    __agRequestActivityPreviews() {},
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.4-pr20-inflight',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-dark',
      cssText: '', customCss: '', themeVars: {}, i18nDict: {},
      modules: { theme: false, i18n: false, metrics: false, quota: false, quotaSidebar: false, activityView: true },
      activityView: { showPriority: true, showPinned: false, showScheduled: false, unreadOnly: false },
      selectors: {},
      userConfig: { modules: { activityView: true } },
      customJs: ''
    }
  };
  sb2.window = sb2;
  sb2.top = sb2;
  vm.createContext(sb2);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sb2);
  sb2.__ag_set_activity_view_open(true);
  assert.ok(
    Array.from(inflightTimeouts.values()).some((t) => t.ms === 6000),
    'Opening Activity View must register a 6000ms pending preview timeout while RPC is in-flight'
  );
  for (const fn of sb2.__ag_cleanup_fns) fn();
  assert.equal(inflightTimeouts.size, 0, 'Cleanup must clear every pending 6000ms preview timeout');
});

test('cdp-bridge __agRequestActivityPreviews guard replies immediately when reader missing or module disabled, and forwards sqliteAvailable=false', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cdp-av-guard-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');
  let targetList = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targetList));
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
      this.evalExpressions = [];
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
      if (req.method === 'Runtime.evaluate') {
        this.evalExpressions.push(String(req.params?.expression || ''));
      }
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        let result = {};
        if (req.method === 'Runtime.evaluate') {
          const expr = String(req.params?.expression || '');
          if (expr.includes('window.__APP_CONFIG__')) result = { result: { value: true } };
          else if (expr.includes('data-ag-theme-mode')) result = { result: { value: 'dark' } };
          else result = { result: { value: true } };
        } else if (req.method === 'Page.addScriptToEvaluateOnNewDocument') {
          result = { identifier: `doc-${req.id}` };
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

  let manager1 = null;
  let manager2 = null;
  try {
    globalThis.WebSocket = FakeWebSocket;
    const hostWsUrl = `ws://127.0.0.1:${port}/devtools/page/HOST_AV_1`;
    targetList = [
      {
        id: 'HOST_AV_1',
        type: 'page',
        title: 'Antigravity',
        url: `https://127.0.0.1:${port}/c/conv-1`,
        webSocketDebuggerUrl: hostWsUrl
      }
    ];

    let activityViewEnabled = false;
    const makeBundleCtrl = () => ({
      rebuildBundleIfNeeded: () => false,
      getState: () => ({
        cachedInjectScript: 'window.__ag_test = 1;',
        cachedPatchVersion: '1.4.4-test',
        activeConfig: {
          enabled: true,
          allowedOrigins: ['http://127.0.0.1', 'https://127.0.0.1'],
          modules: { metrics: false, sshRemote: false, promptSuggestions: false, activityView: activityViewEnabled },
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
    });

    // 1. No activityPreviewReader -> immediate guard reply with ok:false, sqliteAvailable:false
    manager1 = createCdpManager({
      bundleCtrl: makeBundleCtrl(),
      metricsReader: { parseConversationMetrics: () => null },
      activityPreviewReader: null,
      hasSqlite: () => false,
      runOnce: false,
      safeMode: true
    });
    await manager1.sync();
    const ws1 = socketsByUrl.get(hostWsUrl);
    assert.ok(ws1);
    ws1.emitCdpEvent({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agRequestActivityPreviews',
        payload: JSON.stringify({ reqId: 'req-no-reader', cascadeIds: ['11111111-1111-1111-1111-111111111111'] })
      }
    });
    await waitUntil(() => ws1.evalExpressions.some((e) => e.includes('"req-no-reader"')));
    const reply1 = ws1.evalExpressions.find((e) => e.includes('"req-no-reader"'));
    assert.ok(reply1.includes('"ok":false'));
    assert.ok(reply1.includes('"sqliteAvailable":false'));
    assert.ok(reply1.includes('"previews":{}'));
    manager1.closeAll();
    manager1 = null;

    // 2. Reader present (Node < 22.13, getDatabaseSync -> null):
    //    (a) when module disabled -> guard replies ok:false, sqliteAvailable:true
    //    (b) when module enabled -> reader replies ok:true, sqliteAvailable:false
    socketsByUrl.clear();
    const noSqliteReader = createActivityPreviewReader({ getDatabaseSync: () => null });
    manager2 = createCdpManager({
      bundleCtrl: makeBundleCtrl(),
      metricsReader: { parseConversationMetrics: () => null },
      activityPreviewReader: noSqliteReader,
      hasSqlite: () => false,
      runOnce: false,
      safeMode: true
    });
    await manager2.sync();
    const ws2 = socketsByUrl.get(hostWsUrl);
    assert.ok(ws2);

    ws2.emitCdpEvent({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agRequestActivityPreviews',
        payload: JSON.stringify({ reqId: 'req-disabled', cascadeIds: ['11111111-1111-1111-1111-111111111111'] })
      }
    });
    await waitUntil(() => ws2.evalExpressions.some((e) => e.includes('"req-disabled"')));
    const replyDisabled = ws2.evalExpressions.find((e) => e.includes('"req-disabled"'));
    assert.ok(replyDisabled.includes('"ok":false'));
    assert.ok(replyDisabled.includes('"previews":{}'));

    activityViewEnabled = true;
    ws2.emitCdpEvent({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agRequestActivityPreviews',
        payload: JSON.stringify({ reqId: 'req-no-sqlite', cascadeIds: ['11111111-1111-1111-1111-111111111111'] })
      }
    });
    await waitUntil(() => ws2.evalExpressions.some((e) => e.includes('"req-no-sqlite"')));
    const replyNoSqlite = ws2.evalExpressions.find((e) => e.includes('"req-no-sqlite"'));
    assert.ok(replyNoSqlite.includes('"ok":true'));
    assert.ok(replyNoSqlite.includes('"sqliteAvailable":false'));
    assert.ok(replyNoSqlite.includes('"previews":{}'));
  } finally {
    if (manager1) manager1.closeAll();
    if (manager2) manager2.closeAll();
    globalThis.WebSocket = OrigWebSocket;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * tests/i18n-audit.test.mjs — P0 + P1 Localization Engine, Hygiene, Anti-Mistranslation & Swarm Board Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const I18N_DICT = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'core', 'i18n.json'), 'utf8'));
const RUNTIME_CODE = ['00-head.js', '60-i18n-engine.js', '90-tail.js']
  .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
  .join('\n');

function mkEl({ tagName = 'SPAN', attrs = {}, closestMatchers = [], textContent = '', parentElement = null } = {}) {
  const attrMap = new Map(Object.entries(attrs));
  const matchList = Array.isArray(closestMatchers) ? closestMatchers : [closestMatchers];
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    textContent,
    parentElement,
    parentNode: parentElement,
    isConnected: true,
    closest(sel) {
      const s = String(sel || '');
      for (const m of matchList) {
        if (typeof m === 'function' && m(s, el)) return el;
        if (typeof m === 'string' && s.includes(m)) return el;
      }
      return parentElement && parentElement.closest ? parentElement.closest(sel) : null;
    },
    matches(sel) {
      const s = String(sel || '');
      for (const m of matchList) {
        if (typeof m === 'function' && m(s, el)) return true;
      }
      return false;
    },
    getAttribute(k) {
      return attrMap.has(k) ? attrMap.get(k) : null;
    },
    setAttribute(k, v) {
      attrMap.set(k, String(v));
    },
    removeAttribute(k) {
      attrMap.delete(k);
    },
    hasAttribute(k) {
      return attrMap.has(k);
    },
    querySelectorAll() {
      return [];
    }
  };
  return el;
}

function runI18nHarness({
  nodes = [],
  attrEls = [],
  swarmFrame = false,
  bodyInitiallyNull = false,
  modules = { theme: false, i18n: true, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false }
} = {}) {
  const allNodes = [...attrEls, ...nodes];
  let treeWalkerCalls = 0;
  let observeCalls = 0;
  let disconnectCalls = 0;
  const observerInstances = [];
  const headChildren = [];
  const headEl = {
    appendChild(el) {
      el.parentNode = headEl;
      headChildren.push(el);
    }
  };
  const bodyEl = {
    nodeType: 1,
    tagName: 'BODY',
    isConnected: true,
    classList: { contains: () => false },
    style: { removeProperty() {} },
    closest: () => null,
    matches: () => false,
    hasAttribute: () => false,
    getAttribute: () => null,
    querySelectorAll: () => attrEls
  };

  let nextRafId = 1;
  const pendingRafs = new Map();
  const canceledRafs = [];
  let nextTimerId = 1;
  const pendingTimers = new Map();
  const clearedTimers = [];
  const winListeners = new Map();

  const fakeDoc = {
    head: headEl,
    body: bodyInitiallyNull ? null : bodyEl,
    hidden: false,
    documentElement: {
      style: { removeProperty() {} },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {}
    },
    getElementById: (id) => headChildren.find((e) => e.id === id) || null,
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      setAttribute() {},
      removeAttribute() {},
      remove() {}
    }),
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    createTreeWalker: (root, whatToShow, filter) => {
      treeWalkerCalls += 1;
      const walkList = root === bodyEl ? allNodes : [root];
      let idx = -1;
      return {
        currentNode: null,
        nextNode() {
          while (idx + 1 < walkList.length) {
            idx += 1;
            const n = walkList[idx];
            if (whatToShow === 4 && n.nodeType !== 3) continue;
            const verdict = filter && filter.acceptNode ? filter.acceptNode(n) : 1;
            if (verdict === 1) {
              this.currentNode = n;
              return true;
            }
          }
          return false;
        }
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe() {
      observeCalls += 1;
    }
    disconnect() {
      this.disconnected = true;
      disconnectCalls += 1;
    }
    trigger(mutations) {
      this.cb(mutations);
    }
  }

  const sandbox = {
    location: swarmFrame
      ? { protocol: 'plugin:', hostname: 'swarm--swarm_board-123', pathname: '/', href: 'plugin://swarm--swarm_board-123/', search: '' }
      : { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', href: 'http://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      pendingTimers.set(id, { id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      if (pendingTimers.has(id)) {
        clearedTimers.push(id);
        pendingTimers.delete(id);
      }
    },
    requestAnimationFrame(fn) {
      const id = nextRafId++;
      pendingRafs.set(id, { id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      if (pendingRafs.has(id)) {
        canceledRafs.push(id);
        pendingRafs.delete(id);
      }
    },
    document: fakeDoc,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: MockMutationObserver,
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-audit',
      platform: 'darwin',
      enabled: true,
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: I18N_DICT,
      modules,
      selectors: {},
      userConfig: { modules },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = swarmFrame ? {} : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`(() => { const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${RUNTIME_CODE}\n})();`, sandbox);

  return {
    sandbox,
    bodyEl,
    fakeDoc,
    observerInstances,
    pendingRafs,
    canceledRafs,
    pendingTimers,
    clearedTimers,
    winListeners,
    getTreeWalkerCalls: () => treeWalkerCalls,
    getObserveCalls: () => observeCalls,
    getDisconnectCalls: () => disconnectCalls,
    reinject(overrideBoot) {
      sandbox.__AG_BOOT_PAYLOAD__ = Object.assign({}, sandbox.__AG_BOOT_PAYLOAD__, overrideBoot);
      vm.runInContext(`(() => { const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${RUNTIME_CODE}\n})();`, sandbox);
    },
    cleanup() {
      const fns = (sandbox.__ag_cleanup_fns || []).splice(0);
      for (const fn of fns) fn();
    }
  };
}

test('core/i18n.json has zero case-insensitive duplicates, zero identity keys, and unified terminology', () => {
  const keys = Object.keys(I18N_DICT);
  assert.ok(keys.length >= 800, `Expected >= 800 i18n entries, found ${keys.length}`);

  const lowerSeen = new Map();
  const lowerCollisions = [];
  const identityKeys = [];
  for (const k of keys) {
    const low = k.toLowerCase();
    if (lowerSeen.has(low)) {
      lowerCollisions.push([lowerSeen.get(low), k]);
    } else {
      lowerSeen.set(low, k);
    }
    if (I18N_DICT[k] === k) {
      identityKeys.push(k);
    }
  }
  assert.deepEqual(lowerCollisions, [], `Case-insensitive duplicate keys found: ${JSON.stringify(lowerCollisions)}`);
  assert.deepEqual(identityKeys, [], `Identity key-value entries found: ${JSON.stringify(identityKeys)}`);
  assert.equal(Object.prototype.hasOwnProperty.call(I18N_DICT, 'Worktree'), false);

  // Reconciled duplicate & punctuation conflicts
  assert.equal(I18N_DICT['Enable Sandbox Mode'], '启用沙盒模式');
  assert.equal(I18N_DICT['Custom Context Menus'], '自定义右键菜单');
  assert.equal(I18N_DICT['Delete All Remote Agents Data'], '删除所有远程智能体数据');
  assert.equal(I18N_DICT['Delete All Remote Agents Data?'], '删除所有远程智能体数据？');
  assert.equal(I18N_DICT['Your Plan'], '当前套餐');
  assert.equal(I18N_DICT['Your Plan:'], '当前套餐：');
  assert.equal(I18N_DICT['Side Question'], '旁路提问');
  assert.equal(I18N_DICT['Side Question:'], '旁路提问：');
  assert.equal(I18N_DICT['Worktree Name'], 'Worktree 名称');
  assert.equal(I18N_DICT['AI Credits Used to Generate Response'], '生成此回复消耗的 AI 点数');

  // Terminology uniformity checks across all values
  for (const [k, v] of Object.entries(I18N_DICT)) {
    assert.equal(v.includes('支线提问'), false, `Legacy term 支线提问 in "${k}": "${v}"`);
    assert.equal(v.includes('沙箱'), false, `Legacy term 沙箱 in "${k}": "${v}"`);
    assert.equal(v.includes('工作树'), false, `Legacy term 工作树 in "${k}": "${v}"`);
    assert.equal(v.includes('子代理'), false, `Legacy term 子代理 in "${k}": "${v}"`);
    assert.equal(/子\s*Agent/i.test(v), false, `Legacy term 子 Agent in "${k}": "${v}"`);
    assert.equal(/AI\s*(?:积分|额度)/i.test(v), false, `Legacy AI Credits term in "${k}": "${v}"`);
    assert.equal(/\bArtifact\b/i.test(v), false, `Untranslated Artifact in "${k}": "${v}"`);
  }
});

test('60-i18n-engine translates all dynamic regexes reliably with leading and trailing whitespace', () => {
  const cases = [
    ['  50% left  ', '  50% 剩余  '],
    ['\n 3 updates \n', '\n 3 条进展 \n'],
    ['  2/5 steps  ', '  2/5 步  '],
    ['  7 days ', '  7 天 '],
    [' 15 seconds  ', ' 15 秒  '],
    ['  4 files changed ', '  4 个文件变更 '],
    ['  12 tools  ', '  12 个工具  '],
    ['  2 demoted ', '  2 项已降级 '],
    ['  3 excluded ', '  3 项已排除 '],
    ['  4 tools excluded ', '  4 个工具已排除 '],
    ['  5 active conversations  ', '  5 个进行中的会话  '],
    ['  6 projects ', '  6 个项目 '],
    ['  3 calls · 1.2 MB  ', '  3 次通话 · 1.2 MB  '],
    ['  See all (9) ', '  查看全部 (9) '],
    ['  Show 4 breakdowns  ', '  展开明细 (4 项)  '],
    ['  Show 2 more subagents  ', '  显示另外 2 个子智能体  '],
    ['  Search Google for "antigravity $1"  ', '  使用 Google 搜索“antigravity $1”  '],
    ['  Permanently delete demo including 2 active conversations.  ', '  永久删除 demo 及 2 个进行中的会话。  '],
    ['  Worked for 2m · 3 updates  ', '  已工作 2m · 3 条进展  '],
    ['  Worked for 5s  ', '  已工作 5s  '],
    ['  Thought for 3s  ', '  已思考 3s  '],
    ['  Thinking for 4s  ', '  正在思考 4s  '],
    [
      "  This deletes 2 call recordings (1.5 MB) from your machine. You can't undo this.  ",
      '  这将从您的设备中删除 2 条通话录音（1.5 MB），此操作无法撤销。  '
    ],
    ['  Running for 10s  ', '  已运行 10s  '],
    ['  Running npm test  ', '  正在运行 npm test  '],
    ['  Deleted 3 recordings (2.1 MB)  ', '  已删除 3 条录音 (2.1 MB)  '],
    ['  Zipping src...  ', '  正在打包 src…  '],
    ['  Available AI Credits: 250  ', '  可用 AI 点数：250  '],
    [
      '  You can upgrade to a Google AI Pro plan to receive higher rate limits.  ',
      '  您可以升级到 Google AI Pro 方案以获得更高的配额速率限制。  '
    ],
    [
      '  You have used some of your weekly limit, it will fully refresh in 2 days.  ',
      '  您已消耗部分每周额度，将在 2 天 后完全重置。  '
    ],
    [
      '  You have not used any of your daily limit.  ',
      '  您尚未消耗任何每日额度。  '
    ],
    ['  Side Panel (default)  ', '  右侧边栏（默认）  '],
    ['  Side Panel (Default)  ', '  右侧边栏（默认）  '],
    ['  Beta Mode (Experimental)  ', '  Beta Mode（实验性）  '],
    ['  Beta Mode (experimental)  ', '  Beta Mode（实验性）  ']
  ];

  const nodes = cases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const h = runI18nHarness({ nodes });
  try {
    for (let i = 0; i < cases.length; i++) {
      assert.equal(nodes[i].nodeValue, cases[i][1], `Whitespace regex mismatch for input ${JSON.stringify(cases[i][0])}`);
    }
  } finally {
    h.cleanup();
  }
});

test('60-i18n-engine cancels pending rAF and fallbackTimer on disable/hot-reload and ignores stale flushes', () => {
  const initialNode = { nodeType: 3, nodeValue: 'Settings', parentElement: mkEl() };
  const h = runI18nHarness({ nodes: [initialNode] });
  assert.equal(initialNode.nodeValue, '系统设置');

  // Queue a dirty mutation via MutationObserver
  const dynamicNode = { nodeType: 3, nodeValue: 'New Conversation', isConnected: true, parentNode: h.bodyEl, parentElement: mkEl() };
  assert.equal(h.observerInstances.length, 1);
  h.observerInstances[0].trigger([{ type: 'childList', target: h.bodyEl, addedNodes: [dynamicNode] }]);

  assert.equal(h.pendingRafs.size, 1, 'Mutation must schedule requestAnimationFrame');
  assert.equal(h.pendingTimers.size, 1, 'Mutation must schedule fallback setTimeout');
  const staleRafCb = Array.from(h.pendingRafs.values())[0].fn;
  const staleTimerCb = Array.from(h.pendingTimers.values())[0].fn;

  // Disable plugin (runs cleanup_fns + restoreAllTranslations)
  h.reinject({ enabled: false });
  assert.equal(initialNode.nodeValue, 'Settings', 'Disabling must restore original English text');
  assert.equal(h.pendingRafs.size, 0, 'Cleanup must cancel pending rAF');
  assert.equal(h.canceledRafs.length, 1, 'cancelAnimationFrame must be called');
  assert.equal(h.pendingTimers.size, 0, 'Cleanup must clear pending fallbackTimer');
  assert.equal(h.clearedTimers.length, 1, 'clearTimeout must be called');
  assert.equal(h.observerInstances[0].disconnected, true, 'Cleanup must disconnect observer');

  // Even if stale callbacks still fire after disposal, they must be no-ops
  staleRafCb();
  staleTimerCb();
  assert.equal(initialNode.nodeValue, 'Settings', 'Stale rAF/timer callback must not re-translate restored node');
  assert.equal(dynamicNode.nodeValue, 'New Conversation', 'Stale rAF/timer callback must not translate queued dirty node');
});

test('60-i18n-engine translates dual-count ephemeral summaries and guards RE_EPHEMERAL_ACTIVE against half-translated prose', () => {
  const cases = [
    ['Explored 3 files, edited 2 files and 1 artifact', '已探索 3 个文件、已编辑 2 个文件和 1 个交付工件'],
    ['  Explored 2 files and 3 artifacts, ran 1 command  ', '  已探索 2 个文件和 3 个交付工件、已运行 1 条命令  '],
    ['Edited 1 file and 1 artifact', '已编辑 1 个文件和 1 个交付工件'],
    ['Reading Browser Page in Browser', '正在浏览器中读取网页'],
    ['Reading page', '正在读取页面'],
    ['Searching older messages', '正在搜索更早的消息'],
    ['Editing src/app.tsx', '正在编辑 src/app.tsx'],
    ['Reading package.json', '正在读取 package.json'],
    ['Listing core/runtime/', '正在列出 core/runtime/'],
    ['Searching handleAuth', '正在搜索 handleAuth'],
    ['Searching "quota limit"', '正在搜索 "quota limit"'],
    ['Reading files', '正在读取文件'],
    // Arbitrary English UI phrases must NOT be half-translated by RE_EPHEMERAL_ACTIVE
    ['Reading high-level overview', 'Reading high-level overview'],
    ['Searching available workspaces', 'Searching available workspaces'],
    ['Editing permission rules for team.', 'Editing permission rules for team.'],
    ['Listing active connections', 'Listing active connections']
  ];

  const nodes = cases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const h = runI18nHarness({ nodes });
  try {
    for (let i = 0; i < cases.length; i++) {
      assert.equal(nodes[i].nodeValue, cases[i][1], `Ephemeral mismatch for ${JSON.stringify(cases[i][0])}`);
    }
  } finally {
    h.cleanup();
  }
});

test('60-i18n-engine applies contextual guards to withoutDot, multi-word project/group/breadcrumb names, and removes dead PR #11 selectors', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '60-i18n-engine.js'), 'utf8');
  assert.equal(engineSrc.includes('[data-testid="workspace-name"]'), false, 'Dead selector workspace-name must be removed');
  assert.equal(engineSrc.includes('[data-testid="sidebar-project-title"]'), false, 'Dead selector sidebar-project-title must be removed');

  const projHeaderEl = mkEl({ tagName: 'DIV', closestMatchers: ['[data-testid="project-header"]:not([data-project-icon="archived"])'] });
  const projTitleSpan = mkEl({ tagName: 'SPAN', parentElement: projHeaderEl, textContent: 'New Project', attrs: { title: 'New Project' } });
  const projNewConvBtn = mkEl({ tagName: 'BUTTON', parentElement: projHeaderEl, attrs: { 'aria-label': 'New conversation' } });
  const archivedHeaderEl = mkEl({
    tagName: 'DIV',
    closestMatchers: [(s) => s.includes('project-header') && !s.includes(':not([data-project-icon="archived"])')]
  });
  const groupHeaderEl = mkEl({ tagName: 'DIV', closestMatchers: ['[data-testid="conversation-group-header"]'] });
  const groupBtn = mkEl({ tagName: 'BUTTON', parentElement: groupHeaderEl, attrs: { 'aria-label': 'Rename' } });
  const spanBreadcrumbEl = mkEl({ tagName: 'SPAN', closestMatchers: ['span[data-testid="breadcrumb-segment"]'] });
  const linkProjectBreadcrumbEl = mkEl({ tagName: 'A', closestMatchers: ['a[data-testid="breadcrumb-segment"][href*="project="]'] });
  const branchPillEl = mkEl({ tagName: 'BUTTON', closestMatchers: ['[data-testid="branch-pill-trigger"]'] });
  const dialogEl = mkEl({ tagName: 'DIV', closestMatchers: ['[role="dialog"]'] });

  const nodes = [
    // withoutDot context guard
    { nodeType: 3, nodeValue: 'Active.', parentElement: branchPillEl },
    { nodeType: 3, nodeValue: 'Plan.', parentElement: dialogEl },
    { nodeType: 3, nodeValue: 'Settings.', parentElement: mkEl() },
    // project-header multi-word protection + built-in exemptions
    { nodeType: 3, nodeValue: 'New Project', parentElement: projTitleSpan },
    { nodeType: 3, nodeValue: 'Running app', parentElement: projTitleSpan },
    { nodeType: 3, nodeValue: 'Standalone', parentElement: projHeaderEl },
    { nodeType: 3, nodeValue: 'Archived', parentElement: archivedHeaderEl },
    // conversation-group-header custom group names
    { nodeType: 3, nodeValue: 'New Project', parentElement: groupHeaderEl },
    { nodeType: 3, nodeValue: 'Active', parentElement: groupHeaderEl },
    // non-link span[data-testid="breadcrumb-segment"] & project link breadcrumb
    { nodeType: 3, nodeValue: 'New Project', parentElement: spanBreadcrumbEl },
    { nodeType: 3, nodeValue: 'Share', parentElement: spanBreadcrumbEl },
    { nodeType: 3, nodeValue: 'Standalone', parentElement: spanBreadcrumbEl },
    { nodeType: 3, nodeValue: 'Code Review', parentElement: linkProjectBreadcrumbEl }
  ];

  const attrEls = [projTitleSpan, projNewConvBtn, groupBtn];
  const h = runI18nHarness({ nodes, attrEls });
  try {
    assert.equal(nodes[0].nodeValue, 'Active.', 'Active. in branch pill must not bypass contextual guard via withoutDot');
    assert.equal(nodes[1].nodeValue, '方案套餐。', 'Plan. inside dialog must use dialog contextual translation');
    assert.equal(nodes[2].nodeValue, '系统设置。', 'Settings. in regular DOM should translate via withoutDot');

    assert.equal(nodes[3].nodeValue, 'New Project', 'Multi-word custom project name inside project-header must stay untranslated');
    assert.equal(nodes[4].nodeValue, 'Running app', 'Dynamic-like custom project name inside project-header must stay untranslated');
    assert.equal(nodes[5].nodeValue, '独立会话', 'Built-in Standalone inside project-header must still translate');
    assert.equal(nodes[6].nodeValue, '已归档', 'Built-in Archived inside archived project-header must still translate');
    assert.equal(projTitleSpan.getAttribute('title'), 'New Project', 'Truncated project title tooltip must not be mistranslated');
    assert.equal(projNewConvBtn.getAttribute('aria-label'), '新建对话', 'Action button aria-label inside project-header must still translate');

    assert.equal(nodes[7].nodeValue, 'New Project', 'Multi-word custom group name must stay untranslated');
    assert.equal(nodes[8].nodeValue, 'Active', 'Single-word custom group name must stay untranslated');
    assert.equal(groupBtn.getAttribute('aria-label'), '重命名', 'Action button aria-label inside group-header must still translate');

    assert.equal(nodes[9].nodeValue, 'New Project', 'Multi-word name in span breadcrumb must stay untranslated');
    assert.equal(nodes[10].nodeValue, 'Share', 'Single-word name in span breadcrumb must stay untranslated');
    assert.equal(nodes[11].nodeValue, '独立会话', 'Built-in Standalone in span breadcrumb must still translate');
    assert.equal(nodes[12].nodeValue, 'Code Review', 'Multi-word project name in project link breadcrumb must stay untranslated');
  } finally {
    h.cleanup();
  }
});

test('60-i18n-engine translates PR #11 Worktree/Media menus and Antigravity 2.35.2 UI entries', () => {
  const uiCases = [
    ['Pin Project', '置顶项目'],
    ['Pin Workspace', '置顶工作区'],
    ['Copy Project Name', '复制项目名称'],
    ['Copy Workspace Name', '复制工作区名称'],
    ['Pin Worktree', '置顶 Worktree'],
    ['Unpin Worktree', '取消置顶 Worktree'],
    ['Copy Worktree Name', '复制 Worktree 名称'],
    ['Worktree Settings', 'Worktree 设置'],
    ['Archive Worktree', '归档 Worktree'],
    ['Delete Worktree', '删除 Worktree'],
    ['Save Image', '保存图片'],
    ['Save Video', '保存视频'],
    ['Back 5s (←)', '快退 5 秒 (←)'],
    ['Forward 5s (→)', '快进 5 秒 (→)'],
    ['Previous (←)', '上一个 (←)'],
    ['Next (→)', '下一个 (→)'],
    ['Previous', '上一个'],
    ['Next', '下一个'],
    ['Unsent draft', '未发送草稿'],
    ['Pinned', '已置顶'],
    ['Last Activity', '最近活跃'],
    ['Alphabetical', '按字母排序'],
    ['Customize Sidebar', '自定义侧边栏'],
    ['Inbox Mode', '收件箱模式'],
    ['Continue as a new conversation', '作为新对话继续'],
    ['Group name', '分组名称'],
    ['Clear Browsing Data?', '清除浏览数据？'],
    ['SSH Host', 'SSH 远程主机'],
    ['Clone from Remote', '从远程克隆'],
    ['Clone from This Computer', '从本机克隆'],
    ['Auto-Resolve', '自动解决'],
    ['Preview unavailable', '无法预览'],
    ['Loading...', '正在加载...'],
    ['Creating...', '正在创建...'],
    ['Timeout:', '超时：'],
    ['Command:', '命令：'],
    ['Matcher:', '匹配器：'],
    ['Create a project first.', '请先创建一个项目。'],
    ['Something went wrong', '出了点问题'],
    ['View could not be opened', '无法打开该视图'],
    ["This chat's environment is paused", '此对话的运行环境已暂停'],
    ['Your connection is not private', '您的连接不是私密连接'],
    ['Back to safety', '返回安全页面'],
    ['Having trouble signing in?', '登录遇到问题？'],
    ['Terms of Service & Data Use', '服务条款与数据使用'],
    ['Google Privacy Policy', 'Google 隐私权政策'],
    ['Choose Region', '选择区域'],
    ['Unknown Notebook', '未知笔记本'],
    ['For Turn', '针对此轮'],
    ['Runs as', '运行身份']
  ];

  const placeholderCases = [
    ['Search Hosts…', '搜索主机…'],
    ['Search Repositories…', '搜索仓库…'],
    ['Search filters…', '搜索筛选条件…'],
    ['Search triggers…', '搜索触发器…'],
    ['Search flags', '搜索标志'],
    ['Type your own answer', '输入您自己的回答'],
    ['Search languages to add (e.g. English, Spanish, 中文, yue)...', '搜索要添加的语言（例如 English、Spanish、中文、yue）...']
  ];

  const nodes = uiCases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const attrEls = placeholderCases.map(([ph]) => mkEl({ tagName: 'INPUT', attrs: { placeholder: ph } }));
  const h = runI18nHarness({ nodes, attrEls });
  try {
    for (let i = 0; i < uiCases.length; i++) {
      assert.equal(nodes[i].nodeValue, uiCases[i][1], `UI translation mismatch for ${uiCases[i][0]}`);
    }
    for (let i = 0; i < placeholderCases.length; i++) {
      assert.equal(attrEls[i].getAttribute('placeholder'), placeholderCases[i][1], `Placeholder mismatch for ${placeholderCases[i][0]}`);
    }

    // Native Electron context menu translation for PR #11 Worktree & Media items
    const menuRes = vm.runInContext(
      `[
        { id: 'pin-wt', label: 'Pin Worktree', accelerator: '', checked: false, disabled: false },
        { id: 'save-img', label: 'Save Image', accelerator: '', checked: false, disabled: false },
        { id: 'worktree-user1', label: 'Active', accelerator: '', checked: true, disabled: false }
      ].map((x) => Object.assign({}, x))`,
      h.sandbox
    );
    assert.equal(menuRes[0].label, '置顶 Worktree');
    assert.equal(menuRes[1].label, '保存图片');
    assert.equal(menuRes[2].label, 'Active', 'User worktree entry in submenu must stay untranslated');
  } finally {
    h.cleanup();
  }
});

test('60-i18n-engine translates Swarm Board static & dynamic templates and guards From/To outside Swarm frames', () => {
  const swarmCases = [
    ['Narrator\u2019s page', '纪要员页面'],
    ['overview · from the narrator\u2019s notes', '概览 · 来自纪要员记录'],
    ['Goal', '目标'],
    ['Threads', '话题'],
    ['Tasks done', '已完成任务'],
    ['Coordinator', '协调器'],
    ['All', '全部'],
    ['Moving', '进行中'],
    ['Now', '当前'],
    ['Retired', '已退役'],
    ['Waiting', '等待中'],
    ['Waiting on', '正在等待'],
    ['Hive', '蜂巢'],
    ['Graph view', '关系图视图'],
    ['Export GIF', '导出 GIF'],
    ['Export graph replay as an animated GIF', '将关系图回放导出为 GIF 动图'],
    ['Exporting…', '正在导出…'],
    ['Close preview', '关闭预览'],
    ['Fit the whole swarm', '适配整个蜂群'],
    ['Show or hide each member', '显示或隐藏各成员'],
    ['Threads as cells, with each worker where it works', '以蜂房呈现各话题，展示每位协作者所在位置'],
    ['Where each worker is, by thread', '按话题查看每位协作者所在位置'],
    ['Swarm stalled — no agents working', '蜂群已停滞 — 当前无智能体工作'],
    ['No loaded posts match', '已加载发言中无匹配项'],
    ['No one is on this thread yet.', '此话题中暂无成员。'],
    ['Retry loading earlier posts', '重试加载更早发言'],
    ['Right-click image to save, or open in a new tab.', '右键点击图片即可保存，或在新标签页中打开。'],
    ['Message just sent', '消息已发送'],
    // Dynamic Swarm Board patterns (including leading/trailing whitespace)
    ['  From coordinator  ', '  来自 coordinator  '],
    ['To qa-verifier', '发给 qa-verifier'],
    ['From @i18n-audit', '来自 @i18n-audit'],
    ['To @qa-verifier', '发给 @qa-verifier'],
    [' 3 of 5 done ', ' 已完成 3 / 5 '],
    [' 4 of 7 tasks done ', ' 已完成 4 / 7 项任务 '],
    [' 2 threads open ', ' 2 个进行中的话题 '],
    ['Waiting on @i18n-audit', '等待 @i18n-audit'],
    ['Working for @coordinator', '正在为 @coordinator 工作'],
    ['Up next · qa-verifier', '接下来 · qa-verifier'],
    ['Exporting 42%', '正在导出 42%'],
    ['Rendering swarm-replay.gif…', '正在渲染 swarm-replay.gif…'],
    ['Download swarm-replay.gif', '下载 swarm-replay.gif'],
    ['Show 10 earlier posts (25 older)', '显示更早的 10 条发言（还有 25 条更早）'],
    ['Loading earlier posts… (25 older)', '正在加载更早的发言…（还有 25 条更早）'],
    ['Open @qa-verifier', '打开 @qa-verifier'],
    ['Go to #16 on the Board', '跳转到看板中的 #16'],
    // Prose starting with From/To inside Swarm frame must stay untouched
    ['From the board history', 'From the board history'],
    ['To continue working on this', 'To continue working on this']
  ];

  const swarmNodes = swarmCases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const hSwarm = runI18nHarness({ nodes: swarmNodes, swarmFrame: true });
  try {
    for (let i = 0; i < swarmCases.length; i++) {
      assert.equal(swarmNodes[i].nodeValue, swarmCases[i][1], `Swarm frame mismatch for ${JSON.stringify(swarmCases[i][0])}`);
    }
  } finally {
    hSwarm.cleanup();
  }

  // Outside Swarm iframe: bare From/To without @ and non-filename Download must NOT break main UI prose
  const mainCases = [
    ['From GitHub', 'From GitHub'],
    ['To clipboard', 'To clipboard'],
    ['Download updates', 'Download updates'],
    ['From @i18n-audit', '来自 @i18n-audit'],
    ['To @qa-verifier', '发给 @qa-verifier']
  ];
  const mainNodes = mainCases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const hMain = runI18nHarness({ nodes: mainNodes, swarmFrame: false });
  try {
    for (let i = 0; i < mainCases.length; i++) {
      assert.equal(mainNodes[i].nodeValue, mainCases[i][1], `Main frame guard mismatch for ${JSON.stringify(mainCases[i][0])}`);
    }
  } finally {
    hMain.cleanup();
  }
});

test('startup performs a single synchronous scan when document.body exists and defers cleanly when document.body is null', () => {
  const n1 = { nodeType: 3, nodeValue: 'Settings', parentElement: mkEl() };
  const hReady = runI18nHarness({ nodes: [n1], bodyInitiallyNull: false });
  try {
    assert.equal(n1.nodeValue, '系统设置');
    assert.equal(hReady.getTreeWalkerCalls(), 1, 'Startup must scan document.body exactly once (no redundant second scan in 90-tail.js)');
    assert.equal(hReady.getObserveCalls(), 1, 'Startup must observe document.body once');
  } finally {
    hReady.cleanup();
  }

  const n2 = { nodeType: 3, nodeValue: 'Settings', parentElement: mkEl() };
  const hDeferred = runI18nHarness({ nodes: [n2], bodyInitiallyNull: true });
  try {
    assert.equal(hDeferred.getTreeWalkerCalls(), 0, 'Must not scan before document.body exists');
    assert.equal(n2.nodeValue, 'Settings');
    hDeferred.fakeDoc.body = hDeferred.bodyEl;
    const dclFns = hDeferred.winListeners.get('DOMContentLoaded') || [];
    assert.equal(dclFns.length, 1, 'Must register DOMContentLoaded listener when document.body is null');
    dclFns[0]();
    assert.equal(n2.nodeValue, '系统设置', 'Deferred DOMContentLoaded must scan and translate document.body');
    assert.equal(hDeferred.getTreeWalkerCalls(), 1, 'Deferred startup must scan document.body exactly once');
    assert.equal(hDeferred.getObserveCalls(), 1, 'Deferred startup must observe document.body once');
  } finally {
    hDeferred.cleanup();
  }
});

test('60-i18n-engine translates Antigravity 2.36.0 UI strings, native menu items, and period-separated model aria-label notes', () => {
  const uiCases = [
    ['Hide from Sidebar', '从侧边栏隐藏'],
    ['Reply in Thread', '在话题中回复'],
    ['Applies to /btw and messages sent after this turn', '适用于 /btw 及本轮之后发送的消息'],
    ['Applies to messages sent after this turn', '适用于本轮之后发送的消息'],
    ['Default Cog repository', '默认 Cog 仓库'],
    ['Default Cog branch / ref', '默认 Cog 分支 / 引用'],
    ['e.g., chromium/chromium/src', '例如：chromium/chromium/src'],
    ['e.g., main or refs/heads/main', '例如：main 或 refs/heads/main'],
    ['Download location', '下载位置'],
    ['Context and quota indicator', '上下文与配额指示器'],
    ['Queued messages', '排队消息'],
    ['Conversation steps', '对话执行步骤'],
    [
      'Let the agent open URLs, read web pages, and interact with browser content. This gives the agent access to important (and often critical) knowledge and methods of validation, but any browser integration does increase exposure to external malicious parties for security exploits.',
      '允许智能体打开网址、阅读网页并与浏览器内容交互。这能让智能体获取关键知识与验证手段，但任何浏览器集成都会增加暴露于外部恶意安全攻击的风险。'
    ],
    [
      'Give each Best of N fork a full clone of your workspace, including its local commit history. Choosing a winner then gives your workspace that fork\'s state, so the commits it made are kept. Forks take longer to create than the default CitC clone.',
      '为每个多方案择优 (Best of N) 分支提供工作区的完整克隆（含本地提交历史）。选定胜出方案后，工作区将直接采用该分支状态并保留其提交。相比默认 CitC 克隆，创建分支耗时更长。'
    ],
    [
      'Give each Best of N fork its own clone of your Git repository instead of a copy-on-write overlay. Each fork is then a real repository, so commits it makes are kept when you choose it as the winner. Forks take longer to create, and the wait grows with the size of your repository.',
      '为每个多方案择优 (Best of N) 分支创建独立的 Git 仓库克隆，而非写时复制叠层。每个分支都是真实仓库，选定为胜出方案后其提交将被保留。分支创建耗时更长，且等待时间会随仓库体积增大而增加。'
    ]
  ];

  const modelBtnBtw = mkEl({
    tagName: 'BUTTON',
    attrs: {
      'data-testid': 'model-selector-trigger',
      'data-model-label': 'Gemini 4 Neon Extra High',
      'aria-label': 'Select model, current: Gemini 4 Neon Extra High. Applies to /btw and messages sent after this turn'
    }
  });
  const modelBtnAfter = mkEl({
    tagName: 'BUTTON',
    attrs: {
      'data-testid': 'model-selector-trigger',
      'data-model-label': 'Gemini 3.8 Flash',
      'aria-label': 'Select model, current: Gemini 3.8 Flash. Applies to messages sent after this turn.'
    }
  });
  const modelBtnLocked = mkEl({
    tagName: 'BUTTON',
    attrs: {
      'data-testid': 'model-selector-trigger',
      'data-model-label': 'Gemini 4 Carbon Medium',
      'aria-label': 'Model: Gemini 4 Carbon Medium. Model cannot be changed while the agent is running'
    }
  });

  const nodes = uiCases.map(([input]) => ({ nodeType: 3, nodeValue: input, parentElement: mkEl() }));
  const attrEls = [modelBtnBtw, modelBtnAfter, modelBtnLocked];
  const h = runI18nHarness({ nodes, attrEls });
  try {
    for (let i = 0; i < uiCases.length; i++) {
      assert.equal(nodes[i].nodeValue, uiCases[i][1], `2.36.0 UI translation mismatch for ${uiCases[i][0]}`);
    }
    assert.equal(
      modelBtnBtw.getAttribute('aria-label'),
      '模型，当前：Gemini 4 Neon Extra High（适用于 /btw 及本轮之后发送的消息）'
    );
    assert.equal(
      modelBtnAfter.getAttribute('aria-label'),
      '模型，当前：Gemini 3.8 Flash（适用于本轮之后发送的消息）'
    );
    assert.equal(
      modelBtnLocked.getAttribute('aria-label'),
      '模型，当前：Gemini 4 Carbon Medium（智能体运行期间无法切换模型）'
    );

    const menuRes = vm.runInContext(
      `[
        { id: 'hide-sidebar', label: 'Hide from Sidebar', accelerator: '', checked: false, disabled: false },
        { id: 'reply-thread', label: 'Reply in Thread', accelerator: '', checked: false, disabled: false }
      ].map((x) => Object.assign({}, x))`,
      h.sandbox
    );
    assert.equal(menuRes[0].label, '从侧边栏隐藏');
    assert.equal(menuRes[1].label, '在话题中回复');
  } finally {
    h.cleanup();
  }
});

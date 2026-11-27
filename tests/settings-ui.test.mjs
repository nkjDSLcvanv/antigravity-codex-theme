/**
 * tests/settings-ui.test.mjs — Settings UI Model Grouping & Config Patch Sanitization Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  deriveEffortFromModelId,
  parseAgyModelsOutput
} from '../core/daemon/prompt-suggest.mjs';
import {
  DAEMON_BOOT_ID,
  createBundleController,
  sanitizeConfigPatch
} from '../core/daemon/paths.mjs';
import {
  ALLOWED_EXTERNAL_LINKS,
  createCdpManager,
  openAllowlistedExternalLink
} from '../core/daemon/cdp-bridge.mjs';
import {
  compareSemver,
  isSafeManifestRelPath,
  checkForUpdates,
  applyPluginUpdate
} from '../core/daemon/updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const SAMPLE_AGY_MODELS_RAW = [
  '\x1b[?25l⠋ Loading models...\r⠙ Loading models...\r\x1b[2K\x1b[?25h',
  'gemini-4-neon-low              Gemini 4 Neon (Low)',
  'gemini-4-neon-medium           Gemini 4 Neon (Medium)',
  'gemini-4-neon-high             Gemini 4 Neon (High)',
  'gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)',
  'gemini-pro-orchestrator-neon   Orchestrator (Neon)',
  'gemini-3.8-flash-high          Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-low           Gemini 3.8 Flash (Low)',
  'gemini-3.8-flash-medium        Gemini 3.8 Flash (Medium)',
  'gpt-oss-120b-medium            GPT-OSS 120B (Medium)',
  'claude-sonnet-5-5-medium       Claude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-low          Claude Sonnet 5.5 (Low)'
].join('\n');

test('parseAgyModelsOutput strips ANSI/spinner frames, groups by base model, sorts efforts, and pins Gemini 3.8 Flash', () => {
  const families = parseAgyModelsOutput(SAMPLE_AGY_MODELS_RAW);
  assert.equal(families.length, 4, 'Orchestrator should be filtered out, leaving 4 model families');

  // Gemini 3.8 Flash pinned first as recommended with sorted efforts
  assert.equal(families[0].name, 'Gemini 3.8 Flash');
  assert.equal(families[0].recommended, true);
  assert.equal(families[0].defaultEffort, 'Low');
  assert.deepEqual(
    families[0].efforts.map((e) => [e.label, e.id]),
    [
      ['Low', 'gemini-3.8-flash-low'],
      ['Medium', 'gemini-3.8-flash-medium'],
      ['High', 'gemini-3.8-flash-high']
    ]
  );

  // XHigh maps cleanly to Extra High
  const neon = families.find((f) => f.name === 'Gemini 4 Neon');
  assert.ok(neon);
  assert.deepEqual(
    neon.efforts.map((e) => e.label),
    ['Low', 'Medium', 'High', 'Extra High']
  );

  // Single-tier model collapses to singleId
  const oss = families.find((f) => f.key === 'gpt-oss-120b');
  assert.ok(oss);
  assert.equal(oss.singleId, 'gpt-oss-120b-medium');
  assert.equal(oss.name, 'GPT-OSS 120B (Medium)');
  assert.deepEqual(oss.efforts, []);

  assert.deepEqual(parseAgyModelsOutput(''), []);
});

test('deriveEffortFromModelId maps model ID suffixes to valid agy --effort flags', () => {
  assert.equal(deriveEffortFromModelId('gemini-3.8-flash-low'), 'low');
  assert.equal(deriveEffortFromModelId('gemini-4-neon-medium'), 'medium');
  assert.equal(deriveEffortFromModelId('claude-opus-5-5-high'), 'high');
  assert.equal(deriveEffortFromModelId('gemini-4-neon-xhigh'), 'xhigh');
  assert.equal(deriveEffortFromModelId('custom-model-max'), 'max');
  assert.equal(deriveEffortFromModelId('unknown-model'), 'low');
});

test('sanitizeConfigPatch validates whitelisted fields and preserves untouched config keys', () => {
  const baseCfg = {
    enabled: true,
    preset: 'codex-pure-white',
    telemetryLayout: 'compact',
    telemetryCacheMode: 'session',
    promptSuggestionModel: 'gemini-3.8-flash-low',
    sshHosts: ['existing-node'],
    themeVars: { '--ag-chat-font-size': '14px' },
    modules: {
      theme: true,
      i18n: true,
      metrics: true,
      promptSuggestions: false,
      sshRemote: false
    }
  };

  const next = sanitizeConfigPatch(baseCfg, {
    telemetryLayout: 'detailed',
    telemetryCacheMode: 'invalid-mode',
    promptSuggestionModel: 'gemini-4-neon-xhigh',
    sshHosts: ['node032', '  node032  ', '-oProxyCommand=evil', 'bad host', 'gpu@10.0.0.1'],
    modules: {
      promptSuggestions: true,
      sshRemote: true,
      theme: 0,
      injectedUnknownModule: true
    }
  });

  assert.equal(next.preset, 'codex-pure-white');
  assert.deepEqual(next.themeVars, { '--ag-chat-font-size': '14px' });
  assert.equal(next.telemetryLayout, 'detailed');
  assert.equal(next.telemetryCacheMode, 'session', 'invalid cache mode should be ignored');
  assert.equal(next.promptSuggestionModel, 'gemini-4-neon-xhigh');
  assert.deepEqual(next.sshHosts, ['node032', 'gpu@10.0.0.1']);
  assert.equal(next.modules.promptSuggestions, true);
  assert.equal(next.modules.sshRemote, true);
  assert.equal(next.modules.theme, true, 'non-boolean module values should be ignored');
  assert.equal(next.modules.injectedUnknownModule, undefined);

  // Reject unsafe model IDs
  const rejected = sanitizeConfigPatch(next, {
    promptSuggestionModel: '--evil; rm -rf /'
  });
  assert.equal(rejected.promptSuggestionModel, 'gemini-4-neon-xhigh');
});

test('openAllowlistedExternalLink only opens hardcoded github and feedback URLs', () => {
  const calls = [];
  const fakeExec = (cmd, args) => calls.push({ cmd, args });

  const gh = openAllowlistedExternalLink('github', { execFileFn: fakeExec, platform: 'darwin' });
  assert.equal(gh.ok, true);
  assert.equal(gh.url, ALLOWED_EXTERNAL_LINKS.github);
  assert.deepEqual(calls[0], { cmd: 'open', args: [ALLOWED_EXTERNAL_LINKS.github] });

  const fb = openAllowlistedExternalLink('feedback', { execFileFn: fakeExec, platform: 'win32' });
  assert.equal(fb.ok, true);
  assert.equal(fb.url, ALLOWED_EXTERNAL_LINKS.feedback);
  assert.deepEqual(calls[1], {
    cmd: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', ALLOWED_EXTERNAL_LINKS.feedback]
  });

  for (const bad of ['https://evil.example', 'toString', '__proto__', '']) {
    const res = openAllowlistedExternalLink(bad, { execFileFn: fakeExec, platform: 'darwin' });
    assert.equal(res.ok, false);
  }
  assert.equal(calls.length, 2, 'non-allowlisted keys must never invoke OS launcher');
});

test('60-i18n-engine translates dynamic quota-exhausted banners while preserving model names', () => {
  const i18nDict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'core', 'i18n.json'), 'utf8'));
  const code = ['00-head.js', '60-i18n-engine.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
    .join('\n');

  const textNodes = [
    "Your plan's baseline quota will refresh on 11/23/2026, 3:00:00 PM. To continue using this model now, enable AI Credit overages.",
    "You need at least 50 AI Credits to send messages. To continue using Gemini 4 Neon now, purchase more AI Credits. Your plan's baseline quota will refresh on 23.11.2026, 15:00:00.",
    'Your quota for Gemini 4 Neon will reset on 11/23/2026, 3:00:00 PM. Switch to another available model to continue.',
    'Your quota for this model has been reached. Switch to another available model to continue.',
    'Too many requests, please try again in a bit!',
    'See plans'
  ].map((s) => ({
    nodeType: 3,
    nodeValue: s,
    parentElement: {
      tagName: 'SPAN',
      closest: () => null,
      getAttribute: () => null,
      hasAttribute: () => false,
      querySelectorAll: () => []
    }
  }));

  let walkIdx = -1;
  const headChildren = [];
  const headEl = { appendChild(el) { el.parentNode = headEl; headChildren.push(el); } };
  const fakeDoc = {
    head: headEl,
    body: {
      nodeType: 1,
      tagName: 'BODY',
      classList: { contains: () => false },
      style: { removeProperty() {} },
      closest: () => null,
      matches: () => false,
      hasAttribute: () => false,
      getAttribute: () => null,
      querySelectorAll: () => []
    },
    hidden: false,
    documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
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
    createTreeWalker: () => ({
      currentNode: null,
      nextNode() {
        walkIdx += 1;
        if (walkIdx >= textNodes.length) return false;
        this.currentNode = textNodes[walkIdx];
        return true;
      }
    }),
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    location: { pathname: '/', href: 'http://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    document: fakeDoc,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    __AG_BOOT_PAYLOAD__: {
      version: '1.2.1-test',
      platform: 'darwin',
      enabled: true,
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict,
      modules: { theme: false, i18n: true, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false },
      selectors: {},
      userConfig: { modules: { i18n: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  assert.equal(
    textNodes[0].nodeValue,
    '当前方案的基础配额将于 11/23/2026, 3:00:00 PM 刷新。如需立即继续使用该模型，请开启 AI 点数超额抵扣。'
  );
  assert.equal(
    textNodes[1].nodeValue,
    '发送消息需要至少 50 AI 点数。如需立即继续使用 Gemini 4 Neon，请购买更多 AI 点数。当前方案的基础配额将于 23.11.2026, 15:00:00 刷新。'
  );
  assert.equal(
    textNodes[2].nodeValue,
    'Gemini 4 Neon 的配额将于 11/23/2026, 3:00:00 PM 重置。请切换至其他可用模型继续。'
  );
  assert.equal(
    textNodes[3].nodeValue,
    '该模型的配额已用尽。请切换至其他可用模型继续。'
  );
  assert.equal(textNodes[4].nodeValue, '请求过于频繁，请稍后再试！');
  assert.equal(textNodes[5].nodeValue, '查看套餐');
});

test('60-i18n-engine handles Antigravity 2.35.1 sentence-case labels, Thinking for Ns, Your plan, and running-state aria labels', () => {
  const i18nDict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'core', 'i18n.json'), 'utf8'));
  const code = ['00-head.js', '60-i18n-engine.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
    .join('\n');

  const mkEl = (attrs = {}, closestHit = null) => {
    const map = new Map(Object.entries(attrs));
    return {
      nodeType: 1,
      tagName: 'BUTTON',
      closest: (sel) => (closestHit && String(sel).includes(closestHit) ? {} : null),
      matches: () => false,
      getAttribute: (k) => (map.has(k) ? map.get(k) : null),
      setAttribute: (k, v) => map.set(k, String(v)),
      removeAttribute: (k) => map.delete(k),
      hasAttribute: (k) => map.has(k),
      querySelectorAll: () => []
    };
  };

  const textNodes = [
    'Prevent sleep',
    'Keep in menu bar',
    'Enable notifications for agent',
    'Enable AI credit overages',
    'Open links in',
    'Delete all Remote Agents data',
    'This computer',
    'Thinking for 3s',
    'Your plan: Google AI Ultra',
    'Input Box',
    'Choose which key sends a message in the chat composer.',
    'Quote',
    'Low',
    'Extra High'
  ].map((s) => ({
    nodeType: 3,
    nodeValue: s,
    parentElement: mkEl()
  }));
  textNodes.push(
    { nodeType: 3, nodeValue: 'Active', parentElement: mkEl({}, 'branch-pill-trigger') },
    { nodeType: 3, nodeValue: 'Commit', parentElement: mkEl({}, 'project-selector-trigger') },
    { nodeType: 3, nodeValue: 'Select branch', parentElement: mkEl({}, 'branch-pill-trigger') },
    { nodeType: 3, nodeValue: 'Ready', parentElement: mkEl({}, 'project-header') },
    { nodeType: 3, nodeValue: 'Standalone', parentElement: mkEl({}, 'project-header') },
    { nodeType: 3, nodeValue: 'Share', parentElement: mkEl({}, 'breadcrumb-segment') }
  );

  const attrEls = [
    mkEl({ 'aria-label': 'Model, current: Gemini 4 Neon Extra High, Model cannot be changed while the agent is running' }),
    mkEl({ 'aria-label': 'Permission mode: Turbo (Permissions cannot be changed while the agent is running)' }),
    mkEl({ placeholder: 'Search shortcuts...' }),
    mkEl({ 'aria-label': 'Where the agent runs, current: This computer' })
  ];
  const allWalkNodes = [...attrEls, ...textNodes];

  let walkIdx = -1;
  const headChildren = [];
  const headEl = { appendChild(el) { el.parentNode = headEl; headChildren.push(el); } };
  const fakeDoc = {
    head: headEl,
    body: {
      nodeType: 1,
      tagName: 'BODY',
      classList: { contains: () => false },
      style: { removeProperty() {} },
      closest: () => null,
      matches: () => false,
      hasAttribute: () => false,
      getAttribute: () => null,
      querySelectorAll: () => []
    },
    hidden: false,
    documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
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
    createTreeWalker: (_root, _what, filter) => ({
      currentNode: null,
      nextNode() {
        while (walkIdx + 1 < allWalkNodes.length) {
          walkIdx += 1;
          const n = allWalkNodes[walkIdx];
          const verdict = filter && filter.acceptNode ? filter.acceptNode(n) : 1;
          if (verdict === 1) {
            this.currentNode = n;
            return true;
          }
        }
        return false;
      }
    }),
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    location: { pathname: '/', href: 'http://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    document: fakeDoc,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.0-test',
      platform: 'darwin',
      enabled: true,
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict,
      modules: { theme: false, i18n: true, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false },
      selectors: {},
      userConfig: { modules: { i18n: true } },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  assert.equal(textNodes[0].nodeValue, '防止电脑休眠');
  assert.equal(textNodes[1].nodeValue, '保持在系统菜单栏');
  assert.equal(textNodes[2].nodeValue, '启用智能体系统通知');
  assert.equal(textNodes[3].nodeValue, '启用 AI 点数超额抵扣');
  assert.equal(textNodes[4].nodeValue, '默认打开链接方式');
  assert.equal(textNodes[5].nodeValue, '删除所有远程智能体数据');
  assert.equal(textNodes[6].nodeValue, '本机');
  assert.equal(textNodes[7].nodeValue, '正在思考 3s');
  assert.equal(textNodes[8].nodeValue, '当前套餐：Google AI Ultra');
  assert.equal(textNodes[9].nodeValue, '输入框');
  assert.equal(textNodes[10].nodeValue, '选择在聊天输入框中发送消息的快捷键。');
  assert.equal(textNodes[11].nodeValue, '引用');
  assert.equal(textNodes[12].nodeValue, 'Low');
  assert.equal(textNodes[13].nodeValue, 'Extra High');

  assert.equal(
    attrEls[0].getAttribute('aria-label'),
    '模型，当前：Gemini 4 Neon Extra High（智能体运行期间无法切换模型）'
  );
  assert.equal(
    attrEls[1].getAttribute('aria-label'),
    '权限模式：全自动放行 (Turbo)（智能体运行期间无法更改权限）'
  );
  assert.equal(attrEls[2].getAttribute('placeholder'), '搜索快捷键...');
  assert.equal(attrEls[3].getAttribute('aria-label'), '智能体运行位置，当前：本机');

  // Verify Electron native right-click context menu (ogb/showContextMenu) translation & safe scoping
  const desc = vm.runInContext('Object.getOwnPropertyDescriptor(Array.prototype, "map")', sandbox);
  assert.equal(desc.enumerable, false, 'Array.prototype.map must stay non-enumerable');
  assert.equal(vm.runInContext('Array.prototype.map.length', sandbox), 1, 'Array.prototype.map.length must stay 1 per ECMAScript spec');

  const nativeMenuResult = vm.runInContext(
    `(() => {
      function ogb(items, mapObj, prefix = 'cmi') {
        return items.map((d, idx) => {
          const id = d.id || prefix + '-' + idx;
          if (d.onClick) mapObj.set(id, d.onClick);
          const out = {
            id,
            label: d.label,
            type: d.type && d.type !== 'item' && d.type !== 'label' ? d.type : 'normal',
            checked: d.checked,
            disabled: d.type === 'label' ? true : d.disabled,
            accelerator: d.accelerator
          };
          if (d.items && d.items.length > 0) out.submenu = ogb(d.items, mapObj, id + '-sub');
          return out;
        });
      }
      const handlers = new Map();
      return ogb([
        { id: 'rename', label: 'Rename', onClick: () => {} },
        { id: 'pin', label: 'Pin', accelerator: 'Alt+Shift+P', onClick: () => {} },
        { id: 'mark-read', label: 'Mark Unread', onClick: () => {} },
        { type: 'separator' },
        {
          id: 'copy',
          type: 'submenu',
          label: 'Copy',
          items: [
            { id: 'copy-0', label: 'Conversation Name', onClick: () => {} },
            { id: 'copy-1', label: 'Workspace Name', onClick: () => {} }
          ]
        },
        {
          id: 'split',
          type: 'submenu',
          label: 'Split',
          items: [
            { id: 'split-0', label: 'Split Right', onClick: () => {} },
            { id: 'split-1', label: 'Split Down', onClick: () => {} }
          ]
        },
        {
          id: 'move-to-project',
          type: 'submenu',
          label: 'Move to Project',
          items: [
            { id: 'project-user123', label: 'Code', type: 'checkbox', checked: true, onClick: () => {} },
            { id: 'workspace-user456', label: 'Active', type: 'checkbox', checked: false, onClick: () => {} },
            { id: 'project-new', label: 'New Project...', onClick: () => {} },
            { id: 'project-remove', label: 'Remove from Project', onClick: () => {} }
          ]
        },
        { type: 'separator' },
        { id: 'archive', label: 'Archive', accelerator: 'Alt+Ctrl+A', onClick: () => {} },
        { id: 'delete', label: 'Delete', onClick: () => {} },
        { id: 'open-def', label: 'Side Panel (Default)', onClick: () => {} }
      ], handlers);
    })()`,
    sandbox
  );

  assert.equal(nativeMenuResult[0].label, '重命名');
  assert.equal(nativeMenuResult[1].label, '置顶');
  assert.equal(nativeMenuResult[1].accelerator, 'Alt+Shift+P');
  assert.equal(nativeMenuResult[2].label, '标为未读');
  assert.equal(nativeMenuResult[4].label, '复制');
  assert.equal(nativeMenuResult[4].submenu[0].label, '对话名称');
  assert.equal(nativeMenuResult[4].submenu[1].label, '工作区名称');
  assert.equal(nativeMenuResult[5].label, '分屏');
  assert.equal(nativeMenuResult[5].submenu[0].label, '向右分屏');
  assert.equal(nativeMenuResult[5].submenu[1].label, '向下分屏');
  assert.equal(nativeMenuResult[6].label, '移至项目');
  assert.equal(nativeMenuResult[6].submenu[0].label, 'Code', 'User project names must never be translated');
  assert.equal(nativeMenuResult[6].submenu[1].label, 'Active', 'User workspace names must never be translated');
  assert.equal(nativeMenuResult[6].submenu[2].label, '新建项目...');
  assert.equal(nativeMenuResult[6].submenu[3].label, '从项目移除');
  assert.equal(nativeMenuResult[8].label, '归档');
  assert.equal(nativeMenuResult[9].label, '删除');
  assert.equal(nativeMenuResult[10].label, '右侧边栏（默认）');

  // Verify branch/project pills, project headers, and project breadcrumbs preserve single-word names while translating built-ins
  assert.equal(textNodes[14].nodeValue, 'Active', 'Single-word Git branch name must not be mistranslated');
  assert.equal(textNodes[15].nodeValue, 'Commit', 'Single-word project name must not be mistranslated');
  assert.equal(textNodes[16].nodeValue, '选择分支', 'Multi-word branch placeholder should still translate');
  assert.equal(textNodes[17].nodeValue, 'Ready', 'Single-word sidebar project-header name must not be mistranslated');
  assert.equal(textNodes[18].nodeValue, '独立会话', 'Built-in Standalone project-header must still translate');
  assert.equal(textNodes[19].nodeValue, 'Share', 'Single-word project breadcrumb must not be mistranslated');

  // Verify patchedArrayMap fast-exits on class instances, frozen entries & custom Symbol.species non-Array results
  const edgeCases = vm.runInContext(
    `(() => {
      class CustomModel {
        constructor() {
          this.label = 'Rename';
          this.accelerator = '';
          this.checked = false;
          this.disabled = false;
        }
      }
      const clsMapped = [1].map(() => new CustomModel());
      const frozenMapped = [1].map(() => Object.freeze({ id: 'rename', label: 'Rename', accelerator: '', checked: false, disabled: false }));
      class NonArraySpecies extends Array {
        static get [Symbol.species]() {
          return function () { return { custom: true }; };
        }
      }
      const sp = new NonArraySpecies(1);
      sp[0] = { label: 'Rename', accelerator: '', checked: false, disabled: false };
      const spMapped = sp.map((x) => x);
      return { clsLabel: clsMapped[0].label, frozenLabel: frozenMapped[0].label, spCustom: spMapped.custom === true };
    })()`,
    sandbox
  );
  assert.equal(edgeCases.clsLabel, 'Rename', 'Class instances must bypass native menu translation');
  assert.equal(edgeCases.frozenLabel, 'Rename', 'Frozen matching entries must not throw inside patchedArrayMap');
  assert.equal(edgeCases.spCustom, true, 'Custom Symbol.species returning non-Array must not throw');

  // Cleanup must restore original Array.prototype.map
  for (const fn of sandbox.__ag_cleanup_fns) fn();
  assert.equal(
    vm.runInContext('Boolean(Array.prototype.map.__agPatchedArrayMap)', sandbox),
    false,
    'Cleanup must restore original native Array.prototype.map'
  );
});

test('updater validates semver/paths, verifies SHA-256, backs up core/, and preserves user/', async () => {
  assert.equal(compareSemver('1.2.2', '1.2.1'), 1);
  assert.equal(compareSemver('v1.2.1', '1.2.1'), 0);
  assert.equal(compareSemver('1.2.0', '1.2.1'), -1);
  assert.equal(isSafeManifestRelPath('daemon/updater.mjs'), true);
  assert.equal(isSafeManifestRelPath('../evil.mjs'), false);
  assert.equal(isSafeManifestRelPath('/etc/passwd'), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-updater-test-'));
  try {
    const coreDir = path.join(tmpDir, 'core');
    const userDir = path.join(tmpDir, 'user');
    fs.mkdirSync(path.join(coreDir, 'daemon'), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const oldContent = Buffer.from('// old daemon v1.2.1\n', 'utf8');
    const oldHash = crypto.createHash('sha256').update(oldContent).digest('hex');
    fs.writeFileSync(path.join(coreDir, 'daemon.mjs'), oldContent);
    fs.writeFileSync(
      path.join(coreDir, 'manifest.json'),
      JSON.stringify({ version: '1.2.1', files: { 'daemon.mjs': { sha256: oldHash, bytes: oldContent.length } } })
    );
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'antigravity-codex-theme', version: '1.2.1' }));
    fs.writeFileSync(path.join(userDir, 'config.json'), JSON.stringify({ preset: 'codex-dark', customFlag: 42 }));

    const newContent = Buffer.from('// new daemon v1.2.2\n', 'utf8');
    const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
    const remoteManifest = {
      name: 'antigravity-codex-theme',
      version: '1.2.2',
      files: { 'daemon.mjs': { sha256: newHash, bytes: newContent.length } }
    };

    const chk = await checkForUpdates({
      targetDir: tmpDir,
      fetchJson: async (url) => {
        if (url.includes('manifest.json')) return remoteManifest;
        return { tag_name: 'v1.2.2', html_url: 'https://github.com/nkjDSLcvanv/antigravity-codex-theme/releases/tag/v1.2.2' };
      }
    });
    assert.equal(chk.ok, true);
    assert.equal(chk.status, 'update_available');
    assert.equal(chk.updateAvailable, true);
    assert.equal(chk.latestVersion, '1.2.2');

    // Tampered SHA-256 must abort without touching existing core/
    const badApply = await applyPluginUpdate({
      targetDir: tmpDir,
      ref: 'v1.2.2',
      scheduleRestart: false,
      fetchJson: async () => remoteManifest,
      fetchBuffer: async () => Buffer.from('// tampered bytes\n', 'utf8')
    });
    assert.equal(badApply.ok, false);
    assert.match(badApply.error, /SHA-256 mismatch/);
    assert.equal(fs.readFileSync(path.join(coreDir, 'daemon.mjs'), 'utf8'), '// old daemon v1.2.1\n');

    // Valid SHA-256 updates core/, creates core.prev + backups/, and preserves user/config.json
    const goodApply = await applyPluginUpdate({
      targetDir: tmpDir,
      ref: 'v1.2.2',
      scheduleRestart: false,
      fetchJson: async () => remoteManifest,
      fetchBuffer: async (url) => {
        if (url.endsWith('core/daemon.mjs')) return newContent;
        if (url.endsWith('package.json')) return Buffer.from(JSON.stringify({ name: 'antigravity-codex-theme', version: '1.2.2' }));
        throw new Error('optional doc omitted');
      }
    });
    assert.equal(goodApply.ok, true);
    assert.equal(goodApply.version, '1.2.2');
    assert.equal(fs.readFileSync(path.join(coreDir, 'daemon.mjs'), 'utf8'), '// new daemon v1.2.2\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'core.prev', 'daemon.mjs'), 'utf8'), '// old daemon v1.2.1\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf8')).customFlag, 42);

    // Stale raw.githubusercontent.com CDN cache serving an older manifest version must not offer main_diff downgrade
    const staleCdnChk = await checkForUpdates({
      targetDir: tmpDir,
      fetchJson: async (url) => {
        if (url.includes('manifest.json')) {
          return {
            name: 'antigravity-codex-theme',
            version: '1.2.1',
            files: { 'daemon.mjs': { sha256: oldHash, bytes: oldContent.length } }
          };
        }
        return { tag_name: 'v1.2.2', html_url: 'https://github.com/nkjDSLcvanv/antigravity-codex-theme/releases/tag/v1.2.2' };
      }
    });
    assert.equal(staleCdnChk.ok, true);
    assert.equal(staleCdnChk.status, 'up_to_date');
    assert.equal(staleCdnChk.canSyncMain, false);

    // If package.json fetch fails transiently during applyPluginUpdate, local package.json version still syncs to remoteManifest.version
    const remoteV123 = {
      name: 'antigravity-codex-theme',
      version: '1.2.3',
      files: { 'daemon.mjs': { sha256: newHash, bytes: newContent.length } }
    };
    const fallbackPkgApply = await applyPluginUpdate({
      targetDir: tmpDir,
      ref: 'v1.2.3',
      scheduleRestart: false,
      fetchJson: async () => remoteV123,
      fetchBuffer: async (url) => {
        if (url.endsWith('core/daemon.mjs')) return newContent;
        throw new Error('simulated transient error for top-level files');
      }
    });
    assert.equal(fallbackPkgApply.ok, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')).version,
      '1.2.3',
      'Local package.json version must stay synced with remoteManifest.version to prevent manifest downgrade loops'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('75-settings-ui clears stale status=applied update cache after hot-reloading to updated bundle (Issue #14)', () => {
  const code = ['00-head.js', '75-settings-ui.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
    .join('\n');

  const runSettingsMount = (bootVersion, initialCache, existingBootSeq = 0) => {
    const headEl = { appendChild() {} };
    const fakeDoc = {
      head: headEl,
      body: {
        nodeType: 1,
        tagName: 'BODY',
        classList: { contains: () => false },
        style: { removeProperty() {} },
        closest: () => null,
        querySelectorAll: () => []
      },
      hidden: false,
      documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
      getElementById: () => null,
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
      addEventListener() {},
      removeEventListener() {}
    };

    const sandbox = {
      location: { pathname: '/', href: 'http://127.0.0.1/', search: '' },
      navigator: { platform: 'MacIntel', onLine: true },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      requestAnimationFrame: () => 1,
      document: fakeDoc,
      MutationObserver: class { observe() {} disconnect() {} },
      __ag_bundle_boot_seq: existingBootSeq,
      __ag_settings_update_cache: initialCache,
      __AG_BOOT_PAYLOAD__: {
        version: bootVersion,
        platform: 'darwin',
        enabled: true,
        cssText: '',
        customCss: '',
        themeVars: {},
        i18nDict: {},
        modules: { theme: false, i18n: false, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false },
        selectors: {},
        userConfig: { modules: { theme: false, i18n: false } },
        customJs: ''
      }
    };
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);
    for (const fn of sandbox.__ag_cleanup_fns || []) fn();
    return sandbox.__ag_settings_update_cache;
  };

  // Case 1: Hot-reloaded to new bundle (v1.4.0 -> v1.4.2): stale "applied" must transition to "up_to_date"
  const afterReload = runSettingsMount('1.4.2-stable-new', {
    phase: 'applied',
    status: 'applied',
    currentVersion: '1.4.2',
    latestVersion: '1.4.2',
    appliedFromPatchVersion: '1.4.0-stable-old',
    appliedAtBootSeq: 1
  }, 1);
  assert.equal(afterReload.status, 'up_to_date');
  assert.equal(afterReload.phase, 'done');
  assert.equal(afterReload.currentVersion, '1.4.2');

  // Case 2: Hot-reloaded from older 1.4.0 bundle without appliedAtBootSeq/appliedFromPatchVersion: matching live semver still resolves
  const afterLegacyReload = runSettingsMount('1.4.2-stable-new', {
    phase: 'applied',
    status: 'applied',
    currentVersion: '1.4.2',
    latestVersion: '1.4.2'
  });
  assert.equal(afterLegacyReload.status, 'up_to_date');
  assert.equal(afterLegacyReload.phase, 'done');

  // Case 3: Still on old bundle (hot-reload hasn't arrived yet): keep status=applied
  const beforeReload = runSettingsMount('1.4.0-stable-old', {
    phase: 'applied',
    status: 'applied',
    currentVersion: '1.4.2',
    latestVersion: '1.4.2',
    appliedFromPatchVersion: '1.4.0-stable-old',
    appliedAtBootSeq: 2
  }, 1);
  assert.equal(beforeReload.status, 'applied');
  assert.equal(beforeReload.phase, 'applied');

  // Case 4: Same-version main_diff sync BEFORE hot-reload must NOT prematurely flip to up_to_date
  const sameVerBeforeReload = runSettingsMount('1.4.2-stable-same', {
    phase: 'applied',
    status: 'applied',
    currentVersion: '1.4.2',
    latestVersion: '1.4.2',
    appliedFromPatchVersion: '1.4.2-stable-same',
    appliedAtBootSeq: 3
  }, 2);
  assert.equal(sameVerBeforeReload.status, 'applied', 'Same-version main_diff must wait until a newer bundle actually injects');

  // Case 5: Daemon-only same-version main_diff AFTER re-injection (identical PATCH_VERSION, higher boot seq) MUST resolve to up_to_date
  const daemonOnlyAfterReload = runSettingsMount('1.4.2-stable-same', {
    phase: 'applied',
    status: 'applied',
    currentVersion: '1.4.2',
    latestVersion: '1.4.2',
    appliedFromPatchVersion: '1.4.2-stable-same',
    appliedAtBootSeq: 3
  }, 3);
  assert.equal(daemonOnlyAfterReload.status, 'up_to_date', 'Daemon-only re-injection increments boot seq and must resolve applied state');
  assert.equal(daemonOnlyAfterReload.phase, 'done');
});

function createSettingsUiHarness({ initialCache, existingBootSeq = 0 } = {}) {
  const code = ['00-head.js', '75-settings-ui.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
    .join('\n');

  const elementsById = new Map();
  let nextTimerId = 1;
  const activeTimers = new Map();
  const clearedTimers = [];
  const bindingCalls = [];

  const mkEl = (tag) => {
    const attrs = new Map();
    const listeners = new Map();
    let _id = '';
    let _innerHTML = '';
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      className: '',
      textContent: '',
      style: { removeProperty() {} },
      children: [],
      parentElement: null,
      parentNode: null,
      isConnected: true,
      scrollTop: 0,
      hidden: false,
      get id() {
        return _id;
      },
      set id(val) {
        if (_id && elementsById.get(_id) === el) elementsById.delete(_id);
        _id = String(val || '');
        if (_id) elementsById.set(_id, el);
      },
      get innerHTML() {
        return _innerHTML;
      },
      set innerHTML(val) {
        _innerHTML = String(val || '');
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      appendChild(child) {
        if (child.parentElement && child.parentElement.children) {
          const i = child.parentElement.children.indexOf(child);
          if (i >= 0) child.parentElement.children.splice(i, 1);
        }
        child.parentElement = el;
        child.parentNode = el;
        child.isConnected = el.isConnected;
        el.children.push(child);
        if (child.id) elementsById.set(child.id, child);
        return child;
      },
      remove() {
        if (el.parentElement && el.parentElement.children) {
          const i = el.parentElement.children.indexOf(el);
          if (i >= 0) el.parentElement.children.splice(i, 1);
        }
        el.parentElement = null;
        el.parentNode = null;
        el.isConnected = false;
        if (_id && elementsById.get(_id) === el) elementsById.delete(_id);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type);
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch(type, ev) {
        for (const fn of (listeners.get(type) || []).slice()) fn(ev);
      },
      closest(sel) {
        if (sel === '.settings-modal-container' || sel === '[role="dialog"]') return dlg;
        if (sel === '.relative.flex.w-full.h-full') return splitRow;
        return null;
      },
      querySelector(sel) {
        if (sel === '.ag-s-nav-label') return navLabelStub;
        if (sel === '.ag-s-nav-ver') return navVerStub;
        if (sel === '[data-testid^="settings-nav-item-"]') return existingNavItem;
        if (sel === '.relative.flex.w-full.h-full') return splitRow;
        return null;
      },
      querySelectorAll: () => [],
      classList: { contains: () => false, toggle() {} }
    };
    return el;
  };

  const navLabelStub = { textContent: '' };
  const navVerStub = { textContent: '' };
  const existingNavItem = mkEl('button');
  const firstNavGroup = mkEl('div');
  firstNavGroup.appendChild(existingNavItem);
  const listRoot = mkEl('div');
  listRoot.appendChild(firstNavGroup);
  const sidebar = mkEl('div');
  sidebar.firstElementChild = listRoot;
  const rightPane = mkEl('div');
  const splitRow = mkEl('div');
  splitRow.appendChild(sidebar);
  splitRow.appendChild(rightPane);
  const dlg = mkEl('div');
  dlg.appendChild(splitRow);
  const headEl = mkEl('head');
  const bodyEl = mkEl('body');
  bodyEl.appendChild(dlg);

  const fakeDoc = {
    head: headEl,
    body: bodyEl,
    hidden: false,
    documentElement: { style: { removeProperty() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
    getElementById: (id) => elementsById.get(id) || null,
    createElement: (tag) => mkEl(tag),
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector: (sel) => (sel === '[data-testid="settings-sidebar"]' ? sidebar : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    location: { pathname: '/', href: 'http://127.0.0.1/', search: '?settingsOpen=true' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      activeTimers.set(id, { id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      if (activeTimers.has(id)) {
        clearedTimers.push({ id, ms: activeTimers.get(id).ms });
        activeTimers.delete(id);
      }
    },
    requestAnimationFrame: () => 1,
    document: fakeDoc,
    MutationObserver: class { observe() {} disconnect() {} },
    __ag_bundle_boot_seq: existingBootSeq,
    __ag_settings_tab_open: true,
    __ag_settings_update_cache: initialCache,
    __agCheckPluginUpdate: (raw) => {
      bindingCalls.push({ name: '__agCheckPluginUpdate', payload: JSON.parse(raw) });
    },
    __agApplyPluginUpdate: (raw) => {
      bindingCalls.push({ name: '__agApplyPluginUpdate', payload: JSON.parse(raw) });
    },
    __agGetSettingsState: (raw) => {
      bindingCalls.push({ name: '__agGetSettingsState', payload: JSON.parse(raw) });
    },
    __agUpdateSettings: (raw) => {
      bindingCalls.push({ name: '__agUpdateSettings', payload: JSON.parse(raw) });
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);

  const mount = (bootVersion, opts = {}) => {
    const { coreHash = '', daemonBootId = '', enabled = true, modules = {} } = opts;
    const mergedMods = Object.assign(
      { theme: false, i18n: false, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false },
      modules
    );
    sandbox.__AG_BOOT_PAYLOAD__ = {
      version: bootVersion,
      coreHash,
      daemonBootId,
      platform: 'darwin',
      enabled,
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: mergedMods,
      selectors: {},
      userConfig: { modules: mergedMods },
      customJs: ''
    };
    vm.runInContext(`(() => { const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}\n})();`, sandbox);
  };

  const clickInPane = (selector) => {
    const pane = elementsById.get('ag-settings-pane');
    assert.ok(pane, 'settings pane must be mounted');
    pane.dispatch('click', {
      preventDefault() {},
      stopPropagation() {},
      detail: 1,
      target: { closest: (sel) => (sel === selector ? {} : null) }
    });
  };

  const changeInPane = (target) => {
    const pane = elementsById.get('ag-settings-pane');
    assert.ok(pane, 'settings pane must be mounted');
    pane.dispatch('change', { target });
  };

  const cleanup = () => {
    const fns = (sandbox.__ag_cleanup_fns || []).splice(0);
    for (const fn of fns) fn();
  };

  const getPaneHtml = () => {
    const pane = elementsById.get('ag-settings-pane');
    return pane ? pane.innerHTML : '';
  };

  return {
    sandbox,
    mount,
    clickInPane,
    changeInPane,
    cleanup,
    getPaneHtml,
    getNavVersion: () => navVerStub.textContent,
    activeTimers,
    clearedTimers,
    bindingCalls
  };
}

test('Wallpaper selected before a hot reload is saved by the remounted settings UI', async (t) => {
  const harness = createSettingsUiHarness();
  t.after(harness.cleanup);
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const decode = Promise.withResolvers();
  let decoding;
  harness.sandbox.crypto = { getRandomValues: (values) => values.fill(7) };
  harness.sandbox.FileReader = class {
    readAsDataURL() {
      this.result = dataUrl;
      this.onload();
    }
  };
  harness.sandbox.Image = class {
    decode() {
      decoding = this.src;
      return decode.promise;
    }
  };

  harness.mount('1.4.3-before', { modules: { theme: true } });
  harness.changeInPane({ id: 'ag-s-appearance-wallpaper-file', files: [{ type: 'image/png', size: 8 }] });
  await Promise.resolve();
  assert.equal(decoding, dataUrl);

  harness.mount('1.4.3-after', { modules: { theme: true } });
  decode.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const writes = harness.bindingCalls.filter((call) => call.name === '__agUpdateSettings');
  assert.equal(writes.length, 2);
  const token = writes[0].payload.wallpaperImportStart;
  assert.equal(token, '7-7-7-7');
  assert.equal(writes[1].payload.wallpaperImportToken, token);
  assert.deepEqual(writes[1].payload.patch, { appearance: { wallpaper: dataUrl } });
});

test('75-settings-ui recovers from hot-reload during phase=checking without deadlocking buttons (Issue #17)', () => {
  // Case A: Pre-existing transient cache with status=idle -> resets cleanly to idle and enables check button
  const hIdle = createSettingsUiHarness({
    initialCache: {
      phase: 'checking',
      status: 'idle',
      currentVersion: '1.4.2',
      latestVersion: '',
      cachedPatchVersion: '1.4.2-stable-aaa'
    }
  });
  hIdle.mount('1.4.2-stable-aaa');
  assert.equal(hIdle.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hIdle.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.equal(hIdle.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  assert.equal(hIdle.sandbox.__ag_settings_update_cache.cachedPatchVersion, '1.4.2-stable-aaa');
  assert.doesNotMatch(hIdle.getPaneHtml(), /id="ag-s-check-update"[^>]*disabled/, 'Check button must not stay disabled after hot-reload');
  hIdle.cleanup();

  // Case B: Pre-existing transient cache with prior status=update_available -> restores phase=done & enables both buttons
  const hAvail = createSettingsUiHarness({
    initialCache: {
      phase: 'checking',
      status: 'update_available',
      currentVersion: '1.4.2',
      latestVersion: '1.4.3',
      updateAvailable: true,
      targetRef: 'v1.4.3',
      cachedPatchVersion: '1.4.2-stable-aaa'
    }
  });
  hAvail.mount('1.4.2-stable-aaa');
  assert.equal(hAvail.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hAvail.sandbox.__ag_settings_update_cache.status, 'update_available');
  assert.equal(hAvail.sandbox.__ag_settings_update_cache.latestVersion, '1.4.3');
  assert.doesNotMatch(hAvail.getPaneHtml(), /id="ag-s-check-update"[^>]*disabled/);
  assert.doesNotMatch(hAvail.getPaneHtml(), /id="ag-s-apply-update"[^>]*disabled/);
  hAvail.cleanup();
});

test('75-settings-ui recovers from hot-reload during phase=updating on same and upgraded versions (Issue #17)', () => {
  // Case A: Same-version hot-reload during updating -> clears busy phase and restores update_available
  const hSame = createSettingsUiHarness({
    initialCache: {
      phase: 'updating',
      status: 'update_available',
      currentVersion: '1.4.2',
      latestVersion: '1.4.3',
      updateAvailable: true,
      targetRef: 'v1.4.3',
      cachedPatchVersion: '1.4.2-stable-same'
    }
  });
  hSame.mount('1.4.2-stable-same');
  assert.equal(hSame.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hSame.sandbox.__ag_settings_update_cache.status, 'update_available');
  assert.equal(hSame.sandbox.__ag_settings_update_cache.interruptedPhase, undefined);
  assert.doesNotMatch(hSame.getPaneHtml(), /id="ag-s-check-update"[^>]*disabled/);
  assert.doesNotMatch(hSame.getPaneHtml(), /id="ag-s-apply-update"[^>]*disabled/);
  hSame.cleanup();

  // Case B: Pre-fix 1.4.1 cache mid-updating hot-reloads to upgraded 1.4.2 -> converges cleanly to up_to_date
  const hUpgradedPreFix = createSettingsUiHarness({
    initialCache: {
      phase: 'updating',
      status: 'update_available',
      currentVersion: '1.4.1',
      latestVersion: '1.4.2',
      updateAvailable: true,
      targetRef: 'v1.4.2'
    }
  });
  hUpgradedPreFix.mount('1.4.2-stable-new');
  assert.equal(hUpgradedPreFix.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hUpgradedPreFix.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  assert.equal(hUpgradedPreFix.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  assert.equal(hUpgradedPreFix.sandbox.__ag_settings_update_cache.latestVersion, '1.4.2');
  assert.equal(hUpgradedPreFix.sandbox.__ag_settings_update_cache.cachedPatchVersion, '1.4.2-stable-new');
  assert.match(hUpgradedPreFix.getPaneHtml(), />v1\.4\.2</);
  assert.doesNotMatch(hUpgradedPreFix.getPaneHtml(), />v1\.4\.1</);
  hUpgradedPreFix.cleanup();

  // Case C: Live end-to-end upgrade mid-updating (1.4.1 clicks Update Now -> 1.4.2 hot-reloads before RPC replies)
  const hLiveUpgrade = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'update_available',
      currentVersion: '1.4.1',
      latestVersion: '1.4.2',
      updateAvailable: true,
      targetRef: 'v1.4.2',
      cachedPatchVersion: '1.4.1-stable-old'
    }
  });
  hLiveUpgrade.mount('1.4.1-stable-old');
  hLiveUpgrade.clickInPane('#ag-s-apply-update');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.phase, 'updating');
  assert.match(hLiveUpgrade.getPaneHtml(), /id="ag-s-apply-update"[^>]*disabled/);
  const applyCall = hLiveUpgrade.bindingCalls.find((c) => c.name === '__agApplyPluginUpdate');
  assert.ok(applyCall, 'Clicking apply must invoke __agApplyPluginUpdate');

  // Hot-reload new 1.4.2 bundle before RPC returns (00-head.js runs old cleanup, then 75 mounts fresh)
  hLiveUpgrade.mount('1.4.2-stable-new');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.latestVersion, '1.4.2');
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.interruptedPhase, undefined);
  assert.equal(hLiveUpgrade.getNavVersion(), 'v1.4.2');
  assert.match(hLiveUpgrade.getPaneHtml(), />v1\.4\.2</);
  assert.doesNotMatch(hLiveUpgrade.getPaneHtml(), />v1\.4\.1</);
  assert.doesNotMatch(hLiveUpgrade.getPaneHtml(), /id="ag-s-check-update"[^>]*disabled/);
  // Late reply from old apply request must be ignored
  hLiveUpgrade.sandbox.__ag_on_settings_state(applyCall.payload.reqId, { ok: false, error: 'stale failure' });
  assert.equal(hLiveUpgrade.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  hLiveUpgrade.cleanup();

  // Case D: Cross-version reload during updating where landed version != target latestVersion resets to idle instead of up_to_date
  const hMismatchTarget = createSettingsUiHarness({
    initialCache: {
      phase: 'updating',
      status: 'update_available',
      currentVersion: '1.4.1',
      latestVersion: '1.4.3',
      updateAvailable: true,
      targetRef: 'v1.4.3',
      cachedPatchVersion: '1.4.1-stable-old'
    }
  });
  hMismatchTarget.mount('1.4.2-stable-mid');
  assert.equal(hMismatchTarget.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hMismatchTarget.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.equal(hMismatchTarget.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  hMismatchTarget.cleanup();
});

test('75-settings-ui invalidates cross-version stale caches and always aligns bottom version badge with live bundle (Issue #17)', () => {
  // Case A: 1.4.1 up_to_date cache (legacy without cachedPatchVersion) reloaded onto 1.4.2
  const hUpToDate = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'up_to_date',
      currentVersion: '1.4.1',
      latestVersion: '1.4.1'
    }
  });
  hUpToDate.mount('1.4.2-stable-new');
  assert.equal(hUpToDate.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hUpToDate.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.equal(hUpToDate.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  assert.equal(hUpToDate.getNavVersion(), 'v1.4.2');
  assert.match(hUpToDate.getPaneHtml(), /<span class="ag-s-upd-pill">v1\.4\.2<\/span>/);
  assert.doesNotMatch(hUpToDate.getPaneHtml(), /v1\.4\.1/);
  hUpToDate.cleanup();

  // Case B: 1.4.1 update_available cache reloaded onto 1.4.2
  const hUpdateAvail = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'update_available',
      currentVersion: '1.4.1',
      latestVersion: '1.4.2',
      updateAvailable: true,
      targetRef: 'v1.4.2',
      cachedPatchVersion: '1.4.1-stable-old'
    }
  });
  hUpdateAvail.mount('1.4.2-stable-new');
  assert.equal(hUpdateAvail.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hUpdateAvail.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.equal(hUpdateAvail.sandbox.__ag_settings_update_cache.updateAvailable, false);
  assert.equal(hUpdateAvail.sandbox.__ag_settings_update_cache.currentVersion, '1.4.2');
  assert.match(hUpdateAvail.getPaneHtml(), /<span class="ag-s-upd-pill">v1\.4\.2<\/span>/);
  assert.doesNotMatch(hUpdateAvail.getPaneHtml(), /v1\.4\.1/);
  assert.doesNotMatch(hUpdateAvail.getPaneHtml(), /id="ag-s-apply-update"/);
  hUpdateAvail.cleanup();

  // Case C: Same-semver hotfix (different PATCH_VERSION hash) invalidates stale main_diff cache
  const hHotfix = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'main_diff',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      canSyncMain: true,
      changedCount: 2,
      cachedPatchVersion: '1.4.2-stable-hash1'
    }
  });
  hHotfix.mount('1.4.2-stable-hash2');
  assert.equal(hHotfix.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hHotfix.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.equal(hHotfix.sandbox.__ag_settings_update_cache.cachedPatchVersion, '1.4.2-stable-hash2');
  hHotfix.cleanup();

  // Case D: Status=applied (before hot-reload) still displays target currentVersion in bottom pill
  const hApplied = createSettingsUiHarness({
    initialCache: {
      phase: 'applied',
      status: 'applied',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      appliedFromPatchVersion: '1.4.0-stable-old',
      appliedAtBootSeq: 2
    },
    existingBootSeq: 1
  });
  hApplied.mount('1.4.0-stable-old');
  assert.equal(hApplied.sandbox.__ag_settings_update_cache.status, 'applied');
  assert.match(hApplied.getPaneHtml(), /<span class="ag-s-upd-pill">v1\.4\.2<\/span>/);
  hApplied.cleanup();
});

test('75-settings-ui cleanup sanitizes transient checking/updating cache and cancels pending RPC timers (Issue #17)', () => {
  // Case A: Disposing mid-checking cancels 20s RPC timeout and reverts phase from checking
  const hCheck = createSettingsUiHarness();
  hCheck.mount('1.4.2-stable-clean');
  hCheck.clickInPane('#ag-s-check-update');
  assert.equal(hCheck.sandbox.__ag_settings_update_cache.phase, 'checking');
  assert.equal(hCheck.sandbox.__ag_settings_update_cache.cachedPatchVersion, '1.4.2-stable-clean');
  assert.ok(
    Array.from(hCheck.activeTimers.values()).some((t) => t.ms === 20000),
    'In-flight checkPluginUpdate must register a 20s timeout timer'
  );

  hCheck.cleanup();
  assert.equal(hCheck.activeTimers.size, 0, 'All pending RPC timers must be cleared on cleanup');
  assert.ok(
    hCheck.clearedTimers.some((t) => t.ms === 20000),
    'Cleanup must explicitly clearTimeout the 20s checkPluginUpdate timer'
  );
  assert.notEqual(hCheck.sandbox.__ag_settings_update_cache.phase, 'checking');
  assert.equal(hCheck.sandbox.__ag_settings_update_cache.phase, 'idle');

  // Case B: Disposing mid-updating cancels 60s RPC timeout and reverts phase from updating
  const hApply = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'update_available',
      currentVersion: '1.4.2',
      latestVersion: '1.4.3',
      updateAvailable: true,
      targetRef: 'v1.4.3',
      cachedPatchVersion: '1.4.2-stable-clean'
    }
  });
  hApply.mount('1.4.2-stable-clean');
  hApply.clickInPane('#ag-s-apply-update');
  assert.equal(hApply.sandbox.__ag_settings_update_cache.phase, 'updating');
  assert.ok(
    Array.from(hApply.activeTimers.values()).some((t) => t.ms === 60000),
    'In-flight applyPluginUpdateAction must register a 60s timeout timer'
  );

  hApply.cleanup();
  assert.equal(hApply.activeTimers.size, 0, 'All pending RPC timers must be cleared on cleanup');
  assert.ok(
    hApply.clearedTimers.some((t) => t.ms === 60000),
    'Cleanup must explicitly clearTimeout the 60s applyPluginUpdateAction timer'
  );
  assert.equal(hApply.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hApply.sandbox.__ag_settings_update_cache.status, 'update_available');
});

test('paths.mjs decouples coreHash and daemonBootId from user config in bootPayload (Issue #17-A/D)', () => {
  assert.ok(typeof DAEMON_BOOT_ID === 'string' && DAEMON_BOOT_ID.length >= 8, 'DAEMON_BOOT_ID must be non-empty');

  const ctrlSafe = createBundleController({ safeMode: true, daemonBootId: 'boot-test-1' });
  ctrlSafe.rebuildBundleIfNeeded(true);
  const stSafe = ctrlSafe.getState();

  const ctrlNormal = createBundleController({ safeMode: false, daemonBootId: 'boot-test-1' });
  ctrlNormal.rebuildBundleIfNeeded(true);
  const stNormal = ctrlNormal.getState();

  assert.ok(stSafe.cachedCoreHash && stSafe.cachedCoreHash.length === 12);
  assert.equal(stSafe.daemonBootId, 'boot-test-1');
  assert.equal(
    stSafe.cachedCoreHash,
    stNormal.cachedCoreHash,
    'coreHash must remain identical regardless of user config (safeMode vs user/config.json)'
  );
  assert.ok(
    stSafe.cachedInjectScript.includes(`"coreHash":${JSON.stringify(stSafe.cachedCoreHash)}`),
    'bootPayload embedded in injected script must include coreHash'
  );
  assert.ok(
    stSafe.cachedInjectScript.includes('"daemonBootId":"boot-test-1"'),
    'bootPayload embedded in injected script must include daemonBootId'
  );

  // Separate daemon process gets a distinct daemonBootId while sharing deterministic coreHash
  const ctrlOther = createBundleController({ safeMode: true, daemonBootId: 'boot-test-2' });
  ctrlOther.rebuildBundleIfNeeded(true);
  assert.equal(ctrlOther.getState().cachedCoreHash, stSafe.cachedCoreHash);
  assert.notEqual(ctrlOther.getState().daemonBootId, stSafe.daemonBootId);
});

test('75-settings-ui preserves check results across user config toggles when coreHash & daemonBootId stay unchanged (Issue #17-A)', () => {
  for (const status of ['update_available', 'main_diff', 'up_to_date', 'ahead']) {
    const h = createSettingsUiHarness({
      initialCache: {
        phase: 'done',
        status,
        currentVersion: '1.4.2',
        latestVersion: status === 'update_available' ? '1.4.3' : '1.4.2',
        updateAvailable: status === 'update_available',
        canSyncMain: status === 'main_diff',
        changedCount: status === 'main_diff' ? 3 : 0,
        targetRef: status === 'update_available' ? 'v1.4.3' : 'main',
        cachedCoreHash: 'corehashaaaa',
        cachedDaemonBootId: 'boot-proc-1',
        cachedPatchVersion: '1.4.2-stable-cfg1'
      }
    });
    // User toggles a setting -> PATCH_VERSION changes (cfg1 -> cfg2) while coreHash & daemonBootId stay identical
    h.mount('1.4.2-stable-cfg2', { coreHash: 'corehashaaaa', daemonBootId: 'boot-proc-1' });
    assert.equal(h.sandbox.__ag_settings_update_cache.status, status, `${status} must survive config-only hot-reload`);
    assert.equal(h.sandbox.__ag_settings_update_cache.phase, 'done');
    assert.equal(h.sandbox.__ag_settings_update_cache.cachedCoreHash, 'corehashaaaa');
    assert.equal(h.sandbox.__ag_settings_update_cache.cachedDaemonBootId, 'boot-proc-1');
    assert.equal(h.sandbox.__ag_settings_update_cache.cachedPatchVersion, '1.4.2-stable-cfg2');
    h.cleanup();
  }
});

test('75-settings-ui does not falsely converge main_diff updating on user config toggle (Issue #17-B)', () => {
  const h = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'main_diff',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      canSyncMain: true,
      changedCount: 2,
      targetRef: 'main',
      cachedCoreHash: 'corehashaaaa',
      cachedDaemonBootId: 'boot-proc-1',
      cachedPatchVersion: '1.4.2-stable-cfg1'
    }
  });
  h.mount('1.4.2-stable-cfg1', { coreHash: 'corehashaaaa', daemonBootId: 'boot-proc-1' });
  h.clickInPane('#ag-s-apply-update');
  assert.equal(h.sandbox.__ag_settings_update_cache.phase, 'updating');

  // User toggles a setting switch mid-updating -> PATCH_VERSION changes, coreHash & daemonBootId stay unchanged
  h.mount('1.4.2-stable-cfg2', { coreHash: 'corehashaaaa', daemonBootId: 'boot-proc-1' });
  assert.equal(
    h.sandbox.__ag_settings_update_cache.status,
    'main_diff',
    'Config-only hot-reload mid-updating must NOT falsely converge to up_to_date'
  );
  assert.equal(h.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.doesNotMatch(h.getPaneHtml(), /id="ag-s-apply-update"[^>]*disabled/);
  h.cleanup();
});

test('75-settings-ui status=applied ignores same-daemon config/refresh reloads and converges only on real upgrade (Issue #17-C)', () => {
  // Case A: Semver upgrade 1.4.2 -> 1.4.3 waiting for restart; user toggles setting on old 1.4.2 daemon (bootSeq increments)
  const hSemver = createSettingsUiHarness({
    initialCache: {
      phase: 'applied',
      status: 'applied',
      currentVersion: '1.4.3',
      latestVersion: '1.4.3',
      appliedFromVersion: '1.4.2',
      appliedFromCoreHash: 'core-old',
      appliedFromDaemonBootId: 'boot-old',
      appliedFromPatchVersion: '1.4.2-stable-cfg1',
      appliedAtBootSeq: 2,
      appliedAt: Date.now() - 1000
    },
    existingBootSeq: 2
  });
  // Hot-reload still on old 1.4.2 daemon (bootSeq becomes 3, PATCH_VERSION changes cfg1 -> cfg2)
  hSemver.mount('1.4.2-stable-cfg2', { coreHash: 'core-old', daemonBootId: 'boot-old' });
  assert.equal(
    hSemver.sandbox.__ag_settings_update_cache.status,
    'applied',
    'Semver upgrade must NEVER converge while still running old 1.4.2 bundle'
  );
  assert.ok(
    Array.from(hSemver.activeTimers.values()).some((t) => t.ms >= 500 && t.ms <= 20000),
    'Re-mounting while still applied with appliedAt must re-arm reload timeout'
  );

  // Now real 1.4.3 daemon restarts & injects -> converges cleanly to up_to_date
  hSemver.mount('1.4.3-stable-new', { coreHash: 'core-new', daemonBootId: 'boot-new' });
  assert.equal(hSemver.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  assert.equal(hSemver.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hSemver.sandbox.__ag_settings_update_cache.currentVersion, '1.4.3');
  hSemver.cleanup();

  // Case B: Same-semver main_diff applied (1.4.2 -> 1.4.2); user toggles setting on SAME daemon (bootSeq increments, coreHash & daemonBootId unchanged)
  const hSameVer = createSettingsUiHarness({
    initialCache: {
      phase: 'applied',
      status: 'applied',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      appliedFromVersion: '1.4.2',
      appliedFromCoreHash: 'core-old',
      appliedFromDaemonBootId: 'boot-old',
      appliedFromPatchVersion: '1.4.2-stable-cfg1',
      appliedAtBootSeq: 2
    },
    existingBootSeq: 2
  });
  hSameVer.mount('1.4.2-stable-cfg2', { coreHash: 'core-old', daemonBootId: 'boot-old' });
  assert.equal(
    hSameVer.sandbox.__ag_settings_update_cache.status,
    'applied',
    'Same-semver applied state must NOT converge on same-daemon config toggle'
  );
  hSameVer.cleanup();
});

test('75-settings-ui converges daemon-only main_diff updates via coreHash or daemonBootId change (Issue #17-D)', () => {
  // Case A: Mid-updating daemon-only main_diff (same semver 1.4.2, new coreHash from manifest.json + new daemonBootId)
  const hUpdating = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'main_diff',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      canSyncMain: true,
      changedCount: 1,
      targetRef: 'main',
      cachedCoreHash: 'core-before',
      cachedDaemonBootId: 'boot-before',
      cachedPatchVersion: '1.4.2-stable-same'
    }
  });
  hUpdating.mount('1.4.2-stable-same', { coreHash: 'core-before', daemonBootId: 'boot-before' });
  hUpdating.clickInPane('#ag-s-apply-update');
  assert.equal(hUpdating.sandbox.__ag_settings_update_cache.phase, 'updating');

  // New daemon injects with updated manifest coreHash and new daemonBootId (even with same semver & patch version)
  hUpdating.mount('1.4.2-stable-same', { coreHash: 'core-after', daemonBootId: 'boot-after' });
  assert.equal(hUpdating.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  assert.equal(hUpdating.sandbox.__ag_settings_update_cache.phase, 'done');
  assert.equal(hUpdating.sandbox.__ag_settings_update_cache.cachedCoreHash, 'core-after');
  assert.equal(hUpdating.sandbox.__ag_settings_update_cache.cachedDaemonBootId, 'boot-after');
  hUpdating.cleanup();

  // Case B: Mid-applied daemon-only main_diff (even if coreHash unchanged in sparse install, daemonBootId change converges)
  const hAppliedDaemonOnly = createSettingsUiHarness({
    initialCache: {
      phase: 'applied',
      status: 'applied',
      currentVersion: '1.4.2',
      latestVersion: '1.4.2',
      appliedFromVersion: '1.4.2',
      appliedFromCoreHash: 'core-sparse',
      appliedFromDaemonBootId: 'boot-before',
      appliedFromPatchVersion: '1.4.2-stable-same',
      appliedAtBootSeq: 2
    },
    existingBootSeq: 2
  });
  hAppliedDaemonOnly.mount('1.4.2-stable-same', { coreHash: 'core-sparse', daemonBootId: 'boot-after' });
  assert.equal(hAppliedDaemonOnly.sandbox.__ag_settings_update_cache.status, 'up_to_date');
  assert.equal(hAppliedDaemonOnly.sandbox.__ag_settings_update_cache.phase, 'done');
  hAppliedDaemonOnly.cleanup();
});

test('75-settings-ui never leaves empty status=error when hot-reloading mid-recheck and aligns apply timeout + Zh/En quota labels (Issue #17-E & P1)', async () => {
  // Case A: Starting re-check from prior status=error resets status to idle; hot-reload mid-checking never renders empty error
  const hRecheck = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'error',
      currentVersion: '1.4.2',
      error: 'Network error',
      cachedCoreHash: 'core-1',
      cachedDaemonBootId: 'boot-1',
      cachedPatchVersion: '1.4.2-stable-cfg1'
    }
  });
  hRecheck.mount('1.4.2-stable-cfg1', { coreHash: 'core-1', daemonBootId: 'boot-1', modules: { i18n: true } });
  // Also verify Zh bilingual symmetry for Model Quota labels
  assert.match(hRecheck.getPaneHtml(), /模型额度（状态栏面板）/);
  assert.match(hRecheck.getPaneHtml(), /模型额度（侧边栏）/);

  hRecheck.clickInPane('#ag-s-check-update');
  assert.equal(hRecheck.sandbox.__ag_settings_update_cache.phase, 'checking');
  assert.equal(hRecheck.sandbox.__ag_settings_update_cache.status, 'idle');

  // Hot-reload mid-recheck (same coreHash & daemonBootId)
  hRecheck.mount('1.4.2-stable-cfg2', { coreHash: 'core-1', daemonBootId: 'boot-1', modules: { i18n: true } });
  assert.equal(hRecheck.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hRecheck.sandbox.__ag_settings_update_cache.status, 'idle');
  assert.doesNotMatch(hRecheck.getPaneHtml(), /检查失败/);
  hRecheck.cleanup();

  // Case B: Sanitizer also recovers pre-existing corrupted { phase: 'checking', status: 'error', error: '' }
  const hCorrupt = createSettingsUiHarness({
    initialCache: {
      phase: 'checking',
      status: 'error',
      currentVersion: '1.4.2',
      error: '',
      cachedCoreHash: 'core-1',
      cachedDaemonBootId: 'boot-1',
      cachedPatchVersion: '1.4.2-stable-cfg1'
    }
  });
  hCorrupt.mount('1.4.2-stable-cfg1', { coreHash: 'core-1', daemonBootId: 'boot-1' });
  assert.equal(hCorrupt.sandbox.__ag_settings_update_cache.phase, 'idle');
  assert.equal(hCorrupt.sandbox.__ag_settings_update_cache.status, 'idle');
  // En bilingual symmetry check
  assert.match(hCorrupt.getPaneHtml(), /Model Quota \(Panel\)/);
  assert.match(hCorrupt.getPaneHtml(), /Model Quota \(Sidebar\)/);
  hCorrupt.cleanup();

  // Case C: Apply timeout timer is 20000ms (aligned above backend 18000ms lock release)
  const hTimeout = createSettingsUiHarness({
    initialCache: {
      phase: 'done',
      status: 'update_available',
      currentVersion: '1.4.2',
      latestVersion: '1.4.3',
      updateAvailable: true,
      targetRef: 'v1.4.3',
      cachedCoreHash: 'core-1',
      cachedDaemonBootId: 'boot-1',
      cachedPatchVersion: '1.4.2-stable-cfg1'
    }
  });
  hTimeout.mount('1.4.2-stable-cfg1', { coreHash: 'core-1', daemonBootId: 'boot-1' });
  hTimeout.clickInPane('#ag-s-apply-update');
  const applyCall = hTimeout.bindingCalls.find((c) => c.name === '__agApplyPluginUpdate');
  assert.ok(applyCall);
  hTimeout.sandbox.__ag_on_settings_state(applyCall.payload.reqId, { ok: true, version: '1.4.3', restarting: true });
  await Promise.resolve();
  assert.equal(hTimeout.sandbox.__ag_settings_update_cache.status, 'applied');
  assert.equal(hTimeout.sandbox.__ag_settings_update_cache.appliedFromCoreHash, 'core-1');
  assert.equal(hTimeout.sandbox.__ag_settings_update_cache.appliedFromDaemonBootId, 'boot-1');
  assert.equal(hTimeout.sandbox.__ag_settings_update_cache.appliedFromVersion, '1.4.2');
  assert.ok(
    Array.from(hTimeout.activeTimers.values()).some((t) => t.ms === 20000),
    'Frontend apply reload timeout must be 20000ms to outlast backend 18000ms lock release'
  );
  hTimeout.cleanup();
});

test('00-head.js enabled:false sets exact PATCH_VERSION (no -disabled loop) and clears __ag_on_route_change (Global-A)', () => {
  const code = ['00-head.js', '90-tail.js']
    .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', f), 'utf8'))
    .join('\n');

  const headEl = { appendChild() {} };
  const fakeDoc = {
    head: headEl,
    body: {
      classList: { contains: () => false },
      style: { removeProperty() {} },
      querySelectorAll: () => []
    },
    hidden: false,
    documentElement: {
      style: { removeProperty() {} },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {}
    },
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, removeAttribute() {}, remove() {} }),
    getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => false }),
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    location: { pathname: '/', href: 'http://127.0.0.1/', search: '' },
    navigator: { platform: 'MacIntel', onLine: true },
    history: { pushState() {}, replaceState() {} },
    document: fakeDoc,
    NodeFilter: { SHOW_TEXT: 4 },
    addEventListener() {},
    removeEventListener() {},
    clearInterval() {},
    __ag_on_route_change: () => 'stale-handler',
    __AG_BOOT_PAYLOAD__: {
      version: '1.4.2-stable-disabledhash',
      coreHash: 'core12345678',
      daemonBootId: 'boot-1',
      platform: 'darwin',
      enabled: false,
      cssText: '',
      customCss: '',
      themeVars: {},
      i18nDict: {},
      modules: {},
      selectors: {},
      userConfig: { enabled: false },
      customJs: ''
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);

  assert.equal(
    sandbox.__ag_patch_version,
    '1.4.2-stable-disabledhash',
    'Disabled teardown must set window.__ag_patch_version === PATCH_VERSION so cdp-bridge heartbeat converges without re-injection loop'
  );
  assert.equal(sandbox.__ag_on_route_change, null, 'Disabled teardown must clear window.__ag_on_route_change');
  assert.equal(sandbox.__ag_body_ready, false);

  // Verify cdp-bridge heartbeat check expression evaluates to true when enabled:false
  const cachedPatchVersion = '1.4.2-stable-disabledhash';
  const activeEnabled = false;
  const hbExpr =
    '((window.__ag_last_daemon_hb = Date.now()), window.__ag_refresh_wait_ui && window.__ag_refresh_wait_ui(), window.__ag_patch_version === ' +
    JSON.stringify(cachedPatchVersion) +
    ' && (' +
    JSON.stringify(!activeEnabled) +
    ' || (window.__ag_body_ready === true && !!document.getElementById("ag-codex-theme"))))';
  assert.equal(vm.runInContext(hbExpr, sandbox), true, 'Heartbeat check must return true once disabled teardown ran');
});

test('cdp-bridge.mjs __agRequestPromptSuggestion forwards suggestWithMeta completed flag and replies on guard reject (Issue #16-B)', async () => {
  const OrigWebSocket = globalThis.WebSocket;
  const deliveredPayloads = [];
  let activeMockWs = null;

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.OPEN;
      this._listeners = new Map();
      activeMockWs = this;
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    _emit(type, ev) {
      for (const fn of (this._listeners.get(type) || []).slice()) fn(ev);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate' && typeof msg.params?.expression === 'string') {
        const m = msg.params.expression.match(/window\.__ag_on_prompt_suggestion\(([^,]+),\s*(\{[\s\S]*\})\)/);
        if (m) {
          deliveredPayloads.push({ reqId: JSON.parse(m[1]), payload: JSON.parse(m[2]) });
        }
        if (msg.params.expression.includes('const isHost = Boolean(')) {
          queueMicrotask(() =>
            this._emit('message', { data: JSON.stringify({ id: msg.id, result: { result: { value: true } } }) })
          );
          return;
        }
      }
      queueMicrotask(() => this._emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) }));
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this._emit('close', {});
    }
  }

  let serverPort = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          id: 'target-1',
          type: 'page',
          title: 'Antigravity',
          url: 'http://127.0.0.1/c/11111111-1111-1111-1111-111111111111',
          webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/devtools/page/target-1`
        }
      ])
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;

  let promptSuggestionsEnabled = true;
  let suggestImpl = {
    suggestWithMeta: async () => ({ completed: false, suggestion: '' })
  };
  const promptSuggesterObj = {
    suggestWithMeta: (args) => suggestImpl.suggestWithMeta(args),
    suggest: (args) => suggestImpl.suggest(args),
    syncState: () => {},
    stop: () => {}
  };
  const bundleCtrl = {
    rebuildBundleIfNeeded: () => false,
    getState: () => ({
      activeConfig: {
        enabled: true,
        modules: { metrics: false, promptSuggestions: promptSuggestionsEnabled, sshRemote: false },
        allowedOrigins: ['http://127.0.0.1'],
        endpoints: [
          { channel: 'stable', portFile: '', fallbackPort: serverPort, channelInstalled: true, conversationsDir: '' }
        ]
      },
      cachedInjectScript: 'void 0;',
      cachedPatchVersion: '1.4.2-test'
    })
  };

  globalThis.WebSocket = MockWebSocket;

  const mgr = createCdpManager({
    bundleCtrl,
    metricsReader: { parseConversationMetrics: () => null },
    promptSuggester: promptSuggesterObj,
    hasSqlite: () => false,
    runOnce: true
  });

  try {
    await mgr.sync();
    assert.ok(activeMockWs, 'MockWebSocket should be attached');

    const fireBinding = (reqId) => {
      activeMockWs._emit('message', {
        data: JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: {
            name: '__agRequestPromptSuggestion',
            payload: JSON.stringify({
              reqId,
              fingerprint: 'fp-1',
              conversationId: '11111111-1111-1111-1111-111111111111',
              lastUser: 'hi',
              lastAssistant: 'hello'
            })
          }
        })
      });
    };

    // 1. suggestWithMeta returns completed: false
    fireBinding('req-incomplete');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deliveredPayloads.at(-1), {
      reqId: 'req-incomplete',
      payload: { ok: true, completed: false, suggestion: '' }
    });

    // 2. suggestWithMeta returns completed: true with suggestion
    suggestImpl = { suggestWithMeta: async () => ({ completed: true, suggestion: 'Run the test suite' }) };
    fireBinding('req-complete');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deliveredPayloads.at(-1), {
      reqId: 'req-complete',
      payload: { ok: true, completed: true, suggestion: 'Run the test suite' }
    });

    // 3. suggestWithMeta throws -> ok: false, completed: false
    suggestImpl = {
      suggestWithMeta: async () => {
        throw new Error('worker crashed');
      }
    };
    fireBinding('req-error');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deliveredPayloads.at(-1), {
      reqId: 'req-error',
      payload: { ok: false, completed: false, suggestion: '', error: 'worker crashed' }
    });

    // 4. Fallback to legacy suggest() when suggestWithMeta is absent -> completed: true
    delete promptSuggesterObj.suggestWithMeta;
    suggestImpl = { suggest: async () => 'Legacy suggestion' };
    fireBinding('req-legacy');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deliveredPayloads.at(-1), {
      reqId: 'req-legacy',
      payload: { ok: true, completed: true, suggestion: 'Legacy suggestion' }
    });

    // 5. Guard rejection (promptSuggestions disabled) while WS open & reqId present -> immediate negative reply
    promptSuggestionsEnabled = false;
    fireBinding('req-guard-reject');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deliveredPayloads.at(-1), {
      reqId: 'req-guard-reject',
      payload: { ok: false, completed: false, suggestion: '' }
    });
  } finally {
    mgr.closeAll();
    globalThis.WebSocket = OrigWebSocket;
    await new Promise((resolve) => server.close(resolve));
  }
});

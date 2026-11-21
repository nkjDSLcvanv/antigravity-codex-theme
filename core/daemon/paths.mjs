/**
 * core/daemon/paths.mjs — Cross-Platform Channel Discovery & Dynamic Bundle Builder
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_ORIGINS, extractJsoncNumberProperty, stripUtf8Bom } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '../..');
export const CORE_DIR = path.join(ROOT_DIR, 'core');
export const STYLES_DIR = path.join(CORE_DIR, 'styles');
export const RUNTIME_DIR = path.join(CORE_DIR, 'runtime');
export const USER_DIR = path.join(ROOT_DIR, 'user');
export const BASE_VERSION = '1.2.0';

export function parseDaemonCliArgs(argv = process.argv.slice(2)) {
  const hasFlag = (f) => argv.some((a) => a === f || a.startsWith(f + '='));
  const getArg = (flag, fallback = null) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
    }
    return fallback;
  };
  return {
    safeMode: hasFlag('--safe-mode'),
    runOnce: hasFlag('--once'),
    cliChannel: getArg('--channel', null),
    portFile: getArg('--port-file', ''),
    conversationsDir: getArg('--conversations-dir', '')
  };
}

export function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(stripUtf8Bom(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return fallback;
  }
}

export function readTextSafe(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function getFileMtimeSig(filePath) {
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    return st ? `${st.mtimeMs}:${st.size}` : '0:0';
  } catch {
    return '0:0';
  }
}

export function listSortedFiles(dirPath, ext) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath)
      .filter((name) => name.endsWith(ext))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}

export function normalizeOverrideDict(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return {};
  const source = rawObj.exact && typeof rawObj.exact === 'object' ? rawObj.exact : rawObj;
  const clean = {};
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') {
      clean[k] = v;
    }
  }
  return clean;
}

export function resolveChannelPaths(singleChannel = 'stable', userCfg = {}, cliOpts = {}) {
  const home = os.homedir();
  const isInsiders = singleChannel === 'insiders';
  const appDirName = isInsiders ? 'Antigravity - Insiders' : 'Antigravity';
  const geminiSubDir = isInsiders ? '.gemini/antigravity-insiders' : '.gemini/antigravity';

  let defaultPortFile;
  if (process.platform === 'darwin') {
    defaultPortFile = path.join(home, 'Library', 'Application Support', appDirName, 'DevToolsActivePort');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    defaultPortFile = path.join(appData, appDirName, 'DevToolsActivePort');
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    defaultPortFile = path.join(xdgConfig, appDirName, 'DevToolsActivePort');
  }

  const defaultConvDir = path.join(home, geminiSubDir, 'conversations');
  const dotDir = path.join(home, isInsiders ? '.antigravity-insiders' : '.antigravity');
  const argvPath = path.join(dotDir, 'argv.json');
  let fallbackPort = isInsiders ? 9223 : 9222;
  try {
    if (fs.existsSync(argvPath)) {
      const parsedPort = extractJsoncNumberProperty(fs.readFileSync(argvPath, 'utf8'), 'remote-debugging-port');
      if (parsedPort && parsedPort > 0) fallbackPort = parsedPort;
    }
  } catch {}

  const portFile = cliOpts.portFile || userCfg.portFile || defaultPortFile;
  const lsLogFile =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', appDirName, 'language_server.log')
      : path.join(path.dirname(defaultPortFile), 'logs', 'language_server.log');
  const channelInstalled =
    fs.existsSync(portFile) || fs.existsSync(path.dirname(defaultPortFile)) || fs.existsSync(dotDir);

  return {
    channel: singleChannel,
    portFile,
    lsLogFile,
    fallbackPort: Number(userCfg.fallbackPort) > 0 ? Number(userCfg.fallbackPort) : fallbackPort,
    channelInstalled,
    conversationsDir: cliOpts.conversationsDir || userCfg.conversationsDir || defaultConvDir
  };
}

export function resolveActiveChannelEndpoints(channelMode = 'auto', userCfg = {}, cliOpts = {}) {
  const explicitPortFile = cliOpts.portFile || userCfg.portFile || '';
  if (explicitPortFile) {
    const ch = channelMode === 'insiders' ? 'insiders' : 'stable';
    return [resolveChannelPaths(ch, userCfg, cliOpts)];
  }
  if (channelMode === 'stable' || channelMode === 'insiders') {
    return [resolveChannelPaths(channelMode, userCfg, cliOpts)];
  }
  return [
    resolveChannelPaths('stable', userCfg, cliOpts),
    resolveChannelPaths('insiders', userCfg, cliOpts)
  ];
}

export function createBundleController({ safeMode = false, cliChannel = null, hasSqlite = false, cliOpts = {} } = {}) {
  let cachedBundleSig = '';
  let cachedInjectScript = '';
  let cachedPatchVersion = '';
  let activeConfig = {
    enabled: true,
    channel: 'auto',
    preset: 'codex-pure-white',
    telemetryLayout: 'compact',
    telemetryCacheMode: 'session',
    contextLimit: 'auto',
    manualContextLimit: 0,
    fallbackContextLimit: 256000,
    promptSuggestionModel: 'gemini-3.8-flash-low',
    modules: {
      theme: true,
      i18n: true,
      metrics: Boolean(hasSqlite),
      promptSuggestions: false,
      deadlockHealer: true,
      zoomShortcuts: true,
      cdpAutoRelaunch: true,
      customCss: true,
      customJs: true
    },
    themeVars: {},
    selectors: {},
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    endpoints: []
  };

  function rebuildBundleIfNeeded() {
    const styleFiles = listSortedFiles(STYLES_DIR, '.css');
    const runtimeFiles = listSortedFiles(RUNTIME_DIR, '.js');
    const coreFiles = [...styleFiles, path.join(CORE_DIR, 'i18n.json'), ...runtimeFiles];
    const userFiles = safeMode
      ? []
      : [
          path.join(USER_DIR, 'config.json'),
          path.join(USER_DIR, 'custom.css'),
          path.join(USER_DIR, 'i18n.override.json'),
          path.join(USER_DIR, 'custom.js')
        ];

    const sig =
      coreFiles.map(getFileMtimeSig).join('|') +
      '|' +
      userFiles.map(getFileMtimeSig).join('|') +
      `|safe:${safeMode}|cli:${cliChannel || ''}|sqlite:${hasSqlite}`;

    if (sig === cachedBundleSig && cachedInjectScript) {
      return false;
    }

    const userCfg = safeMode ? {} : readJsonSafe(path.join(USER_DIR, 'config.json'), {});
    const enabled = safeMode ? true : userCfg.enabled !== false;
    const channel = cliChannel || userCfg.channel || 'auto';
    const presetRaw = String(userCfg.preset || 'codex-pure-white').trim();
    const preset = presetRaw === 'codex-dark' || presetRaw === 'onyx-dark' ? 'codex-dark' : 'codex-pure-white';
    const telemetryLayout = userCfg.telemetryLayout === 'detailed' ? 'detailed' : 'compact';
    const telemetryCacheMode = userCfg.telemetryCacheMode === 'step' ? 'step' : 'session';

    const rawContextLimit = userCfg.contextLimit;
    const isAutoLimit =
      rawContextLimit === undefined ||
      rawContextLimit === null ||
      String(rawContextLimit).trim() === '' ||
      String(rawContextLimit).trim().toLowerCase() === 'auto';
    const manualContextLimit = !isAutoLimit && Number(rawContextLimit) > 0 ? Number(rawContextLimit) : 0;
    const fallbackContextLimit =
      Number(userCfg.fallbackContextLimit) > 0 ? Number(userCfg.fallbackContextLimit) : 256000;
    const contextLimit = manualContextLimit > 0 ? manualContextLimit : 'auto';

    const rawModules = Object.assign({}, userCfg.features || {}, userCfg.modules || {});
    if (typeof rawModules.metricsCapsule === 'boolean' && typeof rawModules.metrics !== 'boolean') {
      rawModules.metrics = rawModules.metricsCapsule;
    }
    const modules = Object.assign(
      {
        theme: true,
        i18n: true,
        metrics: true,
        promptSuggestions: false,
        deadlockHealer: true,
        zoomShortcuts: true,
        cdpAutoRelaunch: true,
        customCss: true,
        customJs: true
      },
      rawModules
    );
    const hasThemeFiles =
      fs.existsSync(path.join(STYLES_DIR, '10-light-codex.css')) ||
      fs.existsSync(path.join(STYLES_DIR, '00-base.css'));
    const hasI18nFiles =
      fs.existsSync(path.join(CORE_DIR, 'i18n.json')) &&
      fs.existsSync(path.join(RUNTIME_DIR, '60-i18n-engine.js'));
    const hasMetricsFiles =
      fs.existsSync(path.join(RUNTIME_DIR, '50-telemetry-ui.js')) &&
      fs.existsSync(path.join(CORE_DIR, 'daemon', 'sqlite-metrics.mjs'));
    const hasGuardsFile = fs.existsSync(path.join(RUNTIME_DIR, '10-guards.js'));
    if (!hasThemeFiles) modules.theme = false;
    if (!hasI18nFiles) modules.i18n = false;
    if (!hasSqlite || !hasMetricsFiles) modules.metrics = false;
    if (!hasGuardsFile) {
      modules.deadlockHealer = false;
      modules.zoomShortcuts = false;
    }

    const themeVars = !safeMode && userCfg.themeVars && typeof userCfg.themeVars === 'object' ? userCfg.themeVars : {};
    const endpoints = resolveActiveChannelEndpoints(channel, userCfg, cliOpts);

    const normalizedSelectors = Object.assign({}, userCfg.selectors || {});
    if (
      normalizedSelectors.branchPillInBox &&
      !String(normalizedSelectors.branchPillInBox).includes('project-branch-picker')
    ) {
      delete normalizedSelectors.branchPillInBox;
    }
    if (normalizedSelectors.homeGreeting && !String(normalizedSelectors.homeGreeting).includes('home-splash-content')) {
      delete normalizedSelectors.homeGreeting;
    }
    if (
      typeof normalizedSelectors.excludeI18n === 'string' &&
      normalizedSelectors.excludeI18n.trim() &&
      !normalizedSelectors.excludeI18n.includes('.monaco-editor')
    ) {
      normalizedSelectors.excludeI18n +=
        ', .monaco-editor, .monaco-diff-editor, .xterm, [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, [class*="onyx-key"]';
    }

    const promptSuggestionModel =
      typeof userCfg.promptSuggestionModel === 'string' && userCfg.promptSuggestionModel.trim()
        ? userCfg.promptSuggestionModel.trim()
        : 'gemini-3.8-flash-low';

    activeConfig = {
      enabled,
      channel,
      preset,
      telemetryLayout,
      telemetryCacheMode,
      contextLimit,
      manualContextLimit,
      fallbackContextLimit,
      promptSuggestionModel,
      modules,
      themeVars,
      selectors: normalizedSelectors,
      allowedOrigins: Array.isArray(userCfg.allowedOrigins) ? userCfg.allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
      endpoints
    };

    const activeStyleFiles = styleFiles.filter((filePath) => {
      const base = path.basename(filePath);
      if (base === '30-telemetry.css') return Boolean(modules.metrics);
      if (base === '40-prompt-suggestions.css') return Boolean(modules.promptSuggestions);
      return modules.theme !== false;
    });
    const baseCss = activeStyleFiles.map((f) => readTextSafe(f, '')).join('\n\n');
    const customCss = !safeMode && modules.customCss ? readTextSafe(path.join(USER_DIR, 'custom.css'), '') : '';
    const baseDict = modules.i18n ? readJsonSafe(path.join(CORE_DIR, 'i18n.json'), {}) : {};
    const rawOverrideDict =
      modules.i18n && !safeMode ? readJsonSafe(path.join(USER_DIR, 'i18n.override.json'), {}) : {};
    const mergedDict = modules.i18n ? Object.assign({}, baseDict, normalizeOverrideDict(rawOverrideDict)) : {};
    const customJs = !safeMode && modules.customJs ? readTextSafe(path.join(USER_DIR, 'custom.js'), '') : '';
    const runtimeTemplate = runtimeFiles.map((f) => readTextSafe(f, '')).join('\n');

    const hash = crypto
      .createHash('sha256')
      .update(String(enabled))
      .update(runtimeTemplate)
      .update(baseCss)
      .update(customCss)
      .update(JSON.stringify(mergedDict))
      .update(customJs)
      .update(
        JSON.stringify({
          preset,
          telemetryLayout,
          telemetryCacheMode,
          modules,
          themeVars,
          selectors: activeConfig.selectors
        })
      )
      .digest('hex')
      .slice(0, 8);

    const channelTag = channel === 'insiders' ? 'insiders' : 'stable';
    cachedPatchVersion = `${BASE_VERSION}-${channelTag}-${hash}`;

    const bootPayload = {
      version: cachedPatchVersion,
      platform: process.platform,
      enabled,
      preset,
      telemetryLayout,
      telemetryCacheMode,
      cssText: baseCss,
      customCss,
      themeVars,
      i18nDict: mergedDict,
      modules,
      selectors: activeConfig.selectors,
      userConfig: {
        enabled,
        channel,
        preset,
        telemetryLayout,
        telemetryCacheMode,
        contextLimit,
        modules,
        themeVars
      },
      customJs
    };

    cachedInjectScript = runtimeTemplate.replace(
      '})(__AG_BOOT_PAYLOAD__);',
      () => `})(${JSON.stringify(bootPayload)});`
    );
    cachedBundleSig = sig;
    return true;
  }

  return {
    rebuildBundleIfNeeded,
    getState: () => ({
      activeConfig,
      cachedInjectScript,
      cachedPatchVersion
    })
  };
}

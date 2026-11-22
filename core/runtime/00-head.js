/**
 * antigravity-codex-theme · Browser Runtime Bundle
 * Part 00: Bootstrap, Lifecycle Cleanup, Theme Variables & Stylesheet Injection
 */
((boot) => {
  const IS_SWARM_PLUGIN_FRAME = Boolean(
    window.top !== window &&
      window.location &&
      window.location.protocol === 'plugin:' &&
      /^swarm--/i.test(window.location.hostname || '')
  );
  if (window.top !== window && !IS_SWARM_PLUGIN_FRAME) return;
  if (!boot || typeof boot !== 'object') return;

  const PATCH_VERSION = boot.version || '1.2.1';
  const ENABLED = boot.enabled !== false;
  const CSS_TEXT = boot.cssText || '';
  const CUSTOM_CSS_TEXT = boot.customCss || '';
  const THEME_VARS = boot.themeVars && typeof boot.themeVars === 'object' ? boot.themeVars : {};
  const MODULES = Object.assign(
    {
      theme: true,
      i18n: true,
      metrics: true,
      quota: true,
      deadlockHealer: true,
      zoomShortcuts: true,
      cdpAutoRelaunch: true,
      customCss: true,
      customJs: true
    },
    boot.modules || {}
  );

  const DEFAULT_PRESET = boot.preset || 'codex-pure-white';
  const DEFAULT_EXCLUDE_I18N =
    'code, pre, kbd, samp, textarea, input, style, script, noscript, [contenteditable="true"], [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, .monaco-editor, .monaco-diff-editor, .xterm, [class*="onyx-key"], .prose, .markdown, [class*="chat-message"], [class*="group/file-title"], [data-testid="conversation-row-sidebar"] a[href^="/c/"], [data-testid="conversation-row-sidebar"] span.truncate, [data-testid="conversation-row-history"] a[href^="/c/"], [data-testid="conversation-row-history"] span.truncate, [data-testid="conversation-navigator-turn"], #ag-live-metrics-pill, .ag-live-metrics-pill, #ag-live-metrics-tooltip, #ag-turn-metrics-tooltip, .ag-turn-metrics, #ag-quota-card, #ag-quota-tooltip';

  const SELECTORS = Object.assign(
    {
      inputBoxId: 'antigravity.agentSidePanelInputBox',
      branchPillInBox:
        '[data-testid="branch-pill-trigger"], [data-testid="project-branch-picker"], [data-testid="project-selector-trigger"], [data-testid="location-selector-trigger"], [aria-label^="Select project"], [aria-label^="选择项目"]',
      homeGreeting: '[data-testid="home-greeting"], [data-testid="home-splash-content"]',
      excludeI18n: DEFAULT_EXCLUDE_I18N
    },
    boot.selectors || {}
  );

  if (Array.isArray(window.__ag_cleanup_fns) && window.__ag_cleanup_fns.length > 0) {
    const prevCleanups = window.__ag_cleanup_fns.splice(0, window.__ag_cleanup_fns.length);
    for (let i = 0; i < prevCleanups.length; i++) {
      try {
        if (typeof prevCleanups[i] === 'function') prevCleanups[i]();
      } catch (e) {}
    }
  }
  window.__ag_cleanup_fns = [];
  if (window.__ag_dcl_handler) {
    try {
      window.removeEventListener('DOMContentLoaded', window.__ag_dcl_handler);
    } catch (e) {}
    window.__ag_dcl_handler = null;
  }
  if (window.__ag_turn_metrics_observer) {
    try {
      window.__ag_turn_metrics_observer.disconnect();
    } catch (e) {}
    window.__ag_turn_metrics_observer = null;
  }

  if (!window.__ag_orig_text_map) {
    window.__ag_orig_text_map = new WeakMap();
  }
  const origTextMap = window.__ag_orig_text_map;

  function restoreAllTranslations(root = document.body) {
    if (!root) return;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const rec = origTextMap.get(node);
        if (rec) {
          if (node.nodeValue === rec.lastVal) {
            node.nodeValue = rec.origRaw;
          }
          origTextMap.delete(node);
        }
      }
      const attrNames = ['title', 'placeholder', 'aria-label'];
      const attrEls = root.querySelectorAll
        ? root.querySelectorAll(
            '[data-ag-orig-title], [data-ag-orig-title-last], [data-ag-orig-placeholder], [data-ag-orig-placeholder-last], [data-ag-orig-aria-label], [data-ag-orig-aria-label-last]'
          )
        : [];
      for (let i = 0; i < attrEls.length; i++) {
        const el = attrEls[i];
        for (let j = 0; j < attrNames.length; j++) {
          const attr = attrNames[j];
          const origAttr = 'data-ag-orig-' + attr;
          const lastAttr = origAttr + '-last';
          if (el.hasAttribute(origAttr) || el.hasAttribute(lastAttr)) {
            const savedOrig = el.getAttribute(origAttr);
            const savedLast = el.getAttribute(lastAttr);
            const cur = el.getAttribute(attr);
            if (savedOrig !== null && (savedLast === null || cur === savedLast)) {
              el.setAttribute(attr, savedOrig);
            }
            el.removeAttribute(origAttr);
            el.removeAttribute(lastAttr);
            delete el['__ag_attr_ver_' + attr];
          }
        }
        delete el.__ag_attr_ver;
      }
    } catch (e) {}
  }

  function applyThemeVars(varsObj) {
    const prevKeys = Array.isArray(window.__ag_applied_theme_vars) ? window.__ag_applied_theme_vars : [];
    for (let i = 0; i < prevKeys.length; i++) {
      const k = prevKeys[i];
      document.documentElement.style.removeProperty(k);
      if (document.body) document.body.style.removeProperty(k);
    }
    window.__ag_applied_theme_vars = [];

    const keys = Object.keys(varsObj || {});
    const globalDecls = [];
    const lightDecls = [];
    const darkDecls = [];

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = varsObj[k];
      if (!k.startsWith('--') || v === null || v === undefined || String(v).trim() === '') continue;
      const cleanVal = String(v).trim().replace(/[;{}]/g, '');
      if (k.startsWith('--ag-dark-')) {
        darkDecls.push(`${k}: ${cleanVal} !important;`);
      } else if (k.startsWith('--ag-')) {
        globalDecls.push(`${k}: ${cleanVal} !important;`);
      } else {
        lightDecls.push(`${k}: ${cleanVal} !important;`);
      }
    }

    let varStyle = document.getElementById('ag-user-theme-vars');
    if (globalDecls.length === 0 && lightDecls.length === 0 && darkDecls.length === 0) {
      if (varStyle) varStyle.remove();
    } else {
      const head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
      if (!varStyle) {
        varStyle = document.createElement('style');
        varStyle.id = 'ag-user-theme-vars';
      }
      if (head) {
        const customStyleEl = document.getElementById('ag-user-custom-style');
        if (customStyleEl && customStyleEl.parentNode === head) {
          head.insertBefore(varStyle, customStyleEl);
        } else if (varStyle.parentNode !== head) {
          head.appendChild(varStyle);
        }
      }
      const blocks = [];
      if (globalDecls.length > 0) {
        blocks.push(
          `:root, html[data-ag-os]:not([data-ag-disabled]), html[data-ag-os]:not([data-ag-disabled]) body { ${globalDecls.join(' ')} }`
        );
      }
      if (lightDecls.length > 0) {
        blocks.push(
          `html[data-ag-os]:not([data-ag-theme-mode="dark"]):not(:has(> body.dark)), html[data-ag-os]:not([data-ag-theme-mode="dark"]) body:not(.dark) { ${lightDecls.join(' ')} }`
        );
      }
      if (darkDecls.length > 0) {
        blocks.push(
          `html[data-ag-os]:not([data-ag-disabled])[data-ag-theme-mode="dark"], html[data-ag-os]:not([data-ag-disabled])[data-ag-theme-mode="dark"] body, html[data-ag-os]:not([data-ag-disabled]):has(> body.dark), html[data-ag-os]:not([data-ag-disabled]) body.dark { ${darkDecls.join(' ')} }`
        );
      }
      const nextCss = blocks.join('\n');
      if (varStyle.textContent !== nextCss) {
        varStyle.textContent = nextCss;
      }
    }

    if (varsObj && varsObj['--ag-chat-font-size']) {
      document.documentElement.setAttribute('data-ag-custom-font-size', 'true');
    } else {
      document.documentElement.removeAttribute('data-ag-custom-font-size');
    }
  }

  if (!ENABLED) {
    for (const id of ['ag-codex-theme', 'ag-user-theme-vars', 'ag-user-custom-style', 'ag-live-metrics-pill', 'ag-side-metrics-pill', 'ag-live-metrics-tooltip', 'ag-turn-metrics-tooltip', 'ag-quota-card', 'ag-quota-tooltip']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    document.querySelectorAll('.ag-turn-metrics, .ag-live-metrics-pill').forEach((el) => el.remove());
    if (window.__ag_i18n_observer) {
      try { window.__ag_i18n_observer.disconnect(); } catch (e) {}
      window.__ag_i18n_observer = null;
    }
    if (window.__ag_metrics_ro) {
      try { window.__ag_metrics_ro.disconnect(); } catch (e) {}
      window.__ag_metrics_ro = null;
      window.__ag_metrics_ro_target = null;
      window.__ag_metrics_ro_observed = null;
      window.__ag_last_metrics_layout_sig = '';
    }
    if (window.__ag_metrics_route_watcher) {
      try { clearInterval(window.__ag_metrics_route_watcher); } catch (e) {}
      window.__ag_metrics_route_watcher = null;
    }
    if (window.__ag_pending_wait_timer) {
      try { clearInterval(window.__ag_pending_wait_timer); } catch (e) {}
      window.__ag_pending_wait_timer = null;
    }
    if (window.__ag_live_probe_timer) {
      try { clearInterval(window.__ag_live_probe_timer); } catch (e) {}
      window.__ag_live_probe_timer = null;
    }
    if (window.__ag_theme_mode_observer) {
      try { window.__ag_theme_mode_observer.disconnect(); } catch (e) {}
      window.__ag_theme_mode_observer = null;
    }
    window.__ag_zoom_keydown_fn = null;
    window.__ag_settings_click_fn = null;
    window.__ag_body_ready = false;
    applyThemeVars({});
    for (const attr of ['data-ag-preset', 'data-ag-theme-mode', 'data-ag-page-type', 'data-ag-os', 'data-ag-custom-font-size']) {
      document.documentElement.removeAttribute(attr);
    }
    restoreAllTranslations(document.body);
    window.__ag_patch_version = PATCH_VERSION + '-disabled';
    return;
  }

  const headTarget = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
  let style = document.getElementById('ag-codex-theme');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ag-codex-theme';
    if (headTarget) headTarget.appendChild(style);
  }
  const nextCssText = CSS_TEXT || '/* antigravity-codex-theme active */';
  if (style && style.textContent !== nextCssText) {
    style.textContent = nextCssText;
  }

  const detectedOs =
    boot.platform || (/Win/i.test(navigator.platform || '') ? 'win32' : /Mac/i.test(navigator.platform || '') ? 'darwin' : 'linux');
  document.documentElement.setAttribute('data-ag-os', detectedOs);
  if (IS_SWARM_PLUGIN_FRAME) {
    document.documentElement.setAttribute('data-ag-page-type', 'plugin');
  }
  if (MODULES.theme !== false) {
    applyThemeVars(THEME_VARS);
  } else {
    applyThemeVars({});
    for (const attr of ['data-ag-preset', 'data-ag-theme-mode', 'data-ag-custom-font-size']) {
      document.documentElement.removeAttribute(attr);
    }
  }

  let userStyle = document.getElementById('ag-user-custom-style');
  if (MODULES.customCss && CUSTOM_CSS_TEXT.trim()) {
    if (!userStyle) {
      userStyle = document.createElement('style');
      userStyle.id = 'ag-user-custom-style';
      if (headTarget) headTarget.appendChild(userStyle);
    }
    if (userStyle.textContent !== CUSTOM_CSS_TEXT) {
      userStyle.textContent = CUSTOM_CSS_TEXT;
    }
  } else if (userStyle) {
    userStyle.remove();
  }

  function ensureStylesAtEndOfHead() {
    const h = document.head || document.getElementsByTagName('head')[0];
    if (!h) return;
    const base = document.getElementById('ag-codex-theme');
    if (!base) return;
    let needsMove = base.parentNode !== h;
    if (!needsMove) {
      for (let sib = base.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (
          sib.id !== 'ag-user-theme-vars' &&
          sib.id !== 'ag-user-custom-style' &&
          (sib.tagName === 'LINK' || sib.tagName === 'STYLE')
        ) {
          needsMove = true;
          break;
        }
      }
    }
    if (needsMove) {
      for (const id of ['ag-codex-theme', 'ag-user-theme-vars', 'ag-user-custom-style']) {
        const el = document.getElementById(id);
        if (el) h.appendChild(el);
      }
    }
  }
  ensureStylesAtEndOfHead();

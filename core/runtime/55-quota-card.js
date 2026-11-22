/**
 * Part 55: Sidebar Dual-Window Model Quota Card & Hover Breakdown Tooltip
 * Reads dual 5h/weekly quota buckets via the native React retrieveUserQuotaSummary
 * service context (with userStatus Fiber & localStorage cache fallback).
 */
  const AG_QUOTA_CACHE_KEY = 'ag_codex_quota_cache_v2';
  const AG_QUOTA_LEGACY_CACHE_KEY = 'ag_codex_quota_cache_v1';
  const AG_QUOTA_COLLAPSE_KEY = 'ag_codex_quota_collapsed_v1';
  const AG_QUOTA_CARD_ID = 'ag-quota-card';
  const AG_QUOTA_TOOLTIP_ID = 'ag-quota-tooltip';
  const AG_QUOTA_POLL_MS = 15000;
  const AG_QUOTA_FORCE_MIN_GAP_MS = 15000;
  const AG_QUOTA_RENDER_MS = 1500;
  const AG_QUOTA_ALERT_PCT = 30;

  function escapeQuotaHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clampQuota01(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  function quotaLevelFromPct(pct) {
    return pct >= 40 ? 'ok' : pct >= 15 ? 'warn' : 'crit';
  }

  function normalizeQuotaModelKey(label) {
    return String(label || '')
      .toLowerCase()
      .replace(/\bextra\s*high\b|\(extra\)|\bextra\b/g, 'xhigh')
      .replace(/[^a-z0-9]+/g, '');
  }

  function stripQuotaEffortSuffix(label) {
    return String(label || '')
      .replace(/\s*\((?:Low|Medium|High|XHigh|Extra(?:\s*High)?)\)\s*$/i, '')
      .replace(/\s+(?:Low|Medium|High|XHigh|Extra(?:\s*High)?)\s*$/i, '')
      .trim();
  }

  function classifyQuotaFamily(text) {
    const s = String(text || '');
    if (/\bargon\b/i.test(s)) return 'argon';
    if (/(claude|anthropic|gpt|openai)/i.test(s)) return 'claude_gpt';
    if (/(gemini|orchestrator)/i.test(s)) return 'gemini';
    return 'other';
  }

  function getQuotaLocaleStrings(isZh) {
    if (isZh) {
      return {
        lang: 'zh',
        cardTitle: '模型配额',
        geminiTitle: 'Gemini 模型',
        claudeGptTitle: 'Claude 与 GPT 模型',
        argonTitle: 'Gemini 4 Argon',
        otherTitle: '其他模型',
        weekly: '每周',
        weeklyCompact: '每周',
        daily: '每日',
        current: '当前',
        limit5h: '5 小时限额',
        limitWeekly: '每周限额',
        limitDaily: '每日限额',
        limitCurrent: '当前配额',
        pendingSync: '待同步',
        waitSync: '等待同步',
        loadingQuota: '正在读取模型配额...',
        notAvailable: '暂无',
        todayPrefix: '今日 ',
        lowAlert: '余量偏低',
        cachedTag: '缓存',
        creditsUnit: ' 积分',
        creditsPrefix: ' · 积分 ',
        currentAccount: '当前账号',
        activePool: '当前使用池',
        standbyPool: '备用池',
        leftSuffix: ' 剩余',
        countdownPrefix: '倒计时：',
        resetPrefix: '重置：',
        modelsLbl: '包含模型',
        planPrefix: '套餐：',
        cachedAtPrefix: '缓存于 ',
        syncedAtPrefix: '同步于 ',
        overviewTitle: '模型配额总览',
        aiCreditsFootPrefix: 'AI 积分：',
        clickToExpand: '点击标题栏展开详情'
      };
    }
    return {
      lang: 'en',
      cardTitle: 'Model Quota',
      geminiTitle: 'Gemini Models',
      claudeGptTitle: 'Claude & GPT Models',
      argonTitle: 'Gemini 4 Argon',
      otherTitle: 'Other Models',
      weekly: 'Weekly',
      weeklyCompact: 'Wk',
      daily: 'Daily',
      current: 'Quota',
      limit5h: '5-Hour Limit',
      limitWeekly: 'Weekly Limit',
      limitDaily: 'Daily Limit',
      limitCurrent: 'Current Quota',
      pendingSync: 'Syncing',
      waitSync: 'Syncing...',
      loadingQuota: 'Loading model quota...',
      notAvailable: 'N/A',
      todayPrefix: 'Today ',
      lowAlert: 'Low',
      cachedTag: 'Cached',
      creditsUnit: ' cr',
      creditsPrefix: ' · Credits ',
      currentAccount: 'Current account',
      activePool: 'Active pool',
      standbyPool: 'Standby pool',
      leftSuffix: ' left',
      countdownPrefix: 'Resets in: ',
      resetPrefix: 'Reset at: ',
      modelsLbl: 'Models',
      planPrefix: 'Plan: ',
      cachedAtPrefix: 'Cached ',
      syncedAtPrefix: 'Synced ',
      overviewTitle: 'Quota Overview',
      aiCreditsFootPrefix: 'AI Credits: ',
      clickToExpand: 'Click header to expand'
    };
  }

  function isQuotaZhLocale() {
    return typeof MODULES === 'object' ? Boolean(MODULES.i18n) : true;
  }

  function getQuotaGroupTitle(family, rawName, isZh) {
    const t = getQuotaLocaleStrings(isZh);
    if (family === 'gemini') return t.geminiTitle;
    if (family === 'claude_gpt') return t.claudeGptTitle;
    if (family === 'argon') return t.argonTitle;
    return rawName ? String(rawName) : t.otherTitle;
  }

  function parseQuotaResetMs(rt) {
    if (!rt) return 0;
    if (typeof rt === 'bigint') {
      const sec = Number(rt);
      return Number.isFinite(sec) ? (sec > 1e12 ? sec : sec * 1000) : 0;
    }
    if (typeof rt === 'number' && Number.isFinite(rt)) {
      return rt > 1e12 ? rt : rt * 1000;
    }
    if (typeof rt === 'string') {
      const n = Number(rt);
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
      const ms = Date.parse(rt);
      return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof rt === 'object' && rt.seconds !== undefined && rt.seconds !== null) {
      const sec = Number(rt.seconds);
      const nano = Number(rt.nanos || 0);
      if (Number.isFinite(sec) && sec > 0) {
        return sec * 1000 + Math.floor((Number.isFinite(nano) ? nano : 0) / 1e6);
      }
    }
    return 0;
  }

  function normalizeQuotaWindowKey(bucket) {
    const rawWin = String((bucket && bucket.window) || '').trim().toLowerCase();
    if (rawWin === '5h' || rawWin === 'weekly' || rawWin === 'daily') return rawWin;
    const id = String((bucket && bucket.bucketId) || '').toLowerCase();
    if (/5h|5-?hour/.test(id)) return '5h';
    if (/week/.test(id)) return 'weekly';
    if (/day|daily/.test(id)) return 'daily';
    return rawWin || id || 'default';
  }

  function getQuotaWindowLabel(windowKey, fallbackDisplayName, isZh, compact = false) {
    const t = getQuotaLocaleStrings(isZh);
    if (windowKey === '5h') return '5h';
    if (windowKey === 'weekly') return compact ? t.weeklyCompact : t.weekly;
    if (windowKey === 'daily') return t.daily;
    if (windowKey === 'default') return t.current;
    return fallbackDisplayName ? String(fallbackDisplayName).trim() : windowKey;
  }

  function getQuotaWindowTooltipLabel(windowKey, fallbackDisplayName, isZh) {
    const t = getQuotaLocaleStrings(isZh);
    if (windowKey === '5h') return t.limit5h;
    if (windowKey === 'weekly') return t.limitWeekly;
    if (windowKey === 'daily') return t.limitDaily;
    if (windowKey === 'default') return t.limitCurrent;
    return fallbackDisplayName ? String(fallbackDisplayName).trim() : t.limitCurrent;
  }

  function extractModelsFromQuotaDescription(description) {
    const m = String(description || '').match(/Models within this group:\s*([^\n]+)/i);
    if (!m || !m[1]) return [];
    const listText = m[1].replace(/\.\s*$/, '');
    return listText
      .split(',')
      .map((s) => s.replace(/^\s+|\s+$/g, '').replace(/\.\s*$/, ''))
      .filter(Boolean);
  }

  function parseQuotaPlanMeta(us) {
    if (!us) return { planName: '', aiCredits: 0 };
    let aiCredits = 0;
    const creditsList = us.userTier && Array.isArray(us.userTier.availableCredits) ? us.userTier.availableCredits : [];
    for (let i = 0; i < creditsList.length; i++) {
      const amt = Number(creditsList[i] && creditsList[i].creditAmount);
      if (Number.isFinite(amt) && amt > 0) aiCredits += amt;
    }
    const planName = String(
      (us.userTier && us.userTier.name) ||
        (us.planStatus && us.planStatus.planInfo && us.planStatus.planInfo.planName) ||
        ''
    ).trim();
    return { planName, aiCredits };
  }

  function buildQuotaSnapshotFromUserStatus(us, nowMs = Date.now()) {
    if (!us || !us.cascadeModelConfigData) return null;
    const rawModels = us.cascadeModelConfigData.clientModelConfigs || [];
    const models = [];
    for (let i = 0; i < rawModels.length; i++) {
      const m = rawModels[i];
      if (!m || !m.label || m.disabled === true) continue;
      const tagTitle = String(m.tagTitle || '').trim();
      if (/^unavailable$/i.test(tagTitle)) continue;
      const qi = m.quotaInfo;
      if (!qi || typeof qi.remainingFraction !== 'number' || !Number.isFinite(qi.remainingFraction)) continue;
      const resetAtMs = parseQuotaResetMs(qi.resetTime);
      if (qi.remainingFraction <= 0 && !resetAtMs) continue;
      models.push({
        label: String(m.label).trim(),
        remainingFraction: clampQuota01(qi.remainingFraction),
        resetAtMs
      });
    }
    if (!models.length) return null;
    const meta = parseQuotaPlanMeta(us);
    return {
      updatedAt: nowMs,
      planName: meta.planName,
      aiCredits: meta.aiCredits,
      models
    };
  }

  function buildSnapshotFromQuotaSummary(res, metaSource, isZh = true, nowMs = Date.now()) {
    const payload = (res && res.response) || res;
    const rawGroups = payload && Array.isArray(payload.groups) ? payload.groups : [];
    if (!rawGroups.length) return null;

    const groups = [];
    for (let i = 0; i < rawGroups.length; i++) {
      const g = rawGroups[i];
      if (!g) continue;
      const rawName = String(g.displayName || '').trim();
      const family = classifyQuotaFamily(rawName);
      const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
      const buckets = [];

      for (let j = 0; j < rawBuckets.length; j++) {
        const b = rawBuckets[j];
        if (!b || b.disabled === true) continue;
        let remVal;
        if (b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number') {
          remVal = b.remaining.value;
        } else if (typeof b.remainingFraction === 'number') {
          remVal = b.remainingFraction;
        } else {
          continue;
        }
        const remainingFraction = clampQuota01(remVal);
        const pct = Math.max(0, Math.min(100, Math.round(remainingFraction * 100)));
        const windowKey = normalizeQuotaWindowKey(b);
        buckets.push({
          bucketId: String(b.bucketId || windowKey),
          windowKey,
          label: getQuotaWindowLabel(windowKey, b.displayName, isZh, false),
          tooltipLabel: getQuotaWindowTooltipLabel(windowKey, b.displayName, isZh),
          remainingFraction,
          pct,
          resetAtMs: parseQuotaResetMs(b.resetTime),
          level: quotaLevelFromPct(pct),
          description: String(b.description || '').trim()
        });
      }

      if (!buckets.length) continue;
      const winRank = { '5h': 1, daily: 2, weekly: 3, default: 4 };
      buckets.sort((a, b) => (winRank[a.windowKey] || 9) - (winRank[b.windowKey] || 9));

      groups.push({
        id: family !== 'other' ? family : rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'group_' + i,
        family,
        name: getQuotaGroupTitle(family, rawName, isZh),
        rawDisplayName: rawName,
        description: String(g.description || '').trim(),
        listedModels: extractModelsFromQuotaDescription(g.description),
        buckets
      });
    }

    if (!groups.length) return null;
    const meta = metaSource || { planName: '', aiCredits: 0 };
    return {
      updatedAt: nowMs,
      planName: meta.planName || '',
      aiCredits: meta.aiCredits || 0,
      groups
    };
  }

  function buildQuotaPools(summarySnap, userStatusSnap, activeModelLabel, isZh = true) {
    const activeKey = normalizeQuotaModelKey(activeModelLabel);
    const activeBaseName = stripQuotaEffortSuffix(activeModelLabel);
    const activeBaseKey = normalizeQuotaModelKey(activeBaseName);
    const familyOrder = { gemini: 1, claude_gpt: 2, argon: 3, other: 4 };

    const familyModelsMap = new Map();
    const fallbackGroupMap = new Map();

    if (userStatusSnap && Array.isArray(userStatusSnap.models)) {
      for (let i = 0; i < userStatusSnap.models.length; i++) {
        const m = userStatusSnap.models[i];
        const fam = classifyQuotaFamily(m.label);
        const baseName = stripQuotaEffortSuffix(m.label);
        if (!familyModelsMap.has(fam)) familyModelsMap.set(fam, new Map());
        const famSet = familyModelsMap.get(fam);
        if (!famSet.has(baseName)) {
          famSet.set(baseName, m);
        }

        let fg = fallbackGroupMap.get(fam);
        if (!fg) {
          fg = {
            id: fam,
            family: fam,
            name: getQuotaGroupTitle(fam, '', isZh),
            minQuota: null,
            activeQuota: null
          };
          fallbackGroupMap.set(fam, fg);
        }
        const mKey = normalizeQuotaModelKey(m.label);
        const mBaseKey = normalizeQuotaModelKey(baseName);
        if (activeKey && (mKey === activeKey || (activeBaseKey && mBaseKey === activeBaseKey))) {
          fg.activeQuota = m;
        }
        if (!fg.minQuota || m.remainingFraction < fg.minQuota.remainingFraction) {
          fg.minQuota = m;
        }
      }
    }

    const pools = [];
    if (summarySnap && Array.isArray(summarySnap.groups) && summarySnap.groups.length > 0) {
      for (let i = 0; i < summarySnap.groups.length; i++) {
        const g = summarySnap.groups[i];
        const memberNames = [];
        const seenMember = new Set();
        const addMember = (name) => {
          const clean = String(name || '').trim();
          const k = normalizeQuotaModelKey(clean);
          if (!clean || seenMember.has(k)) return;
          seenMember.add(k);
          memberNames.push(clean);
        };

        if (Array.isArray(g.listedModels)) {
          for (let j = 0; j < g.listedModels.length; j++) addMember(g.listedModels[j]);
        }
        const usMap = familyModelsMap.get(g.family);
        if (usMap) {
          usMap.forEach((_, baseName) => addMember(baseName));
        }

        const isActive =
          Boolean(activeBaseKey && memberNames.some((n) => normalizeQuotaModelKey(n) === activeBaseKey)) ||
          Boolean(activeModelLabel && classifyQuotaFamily(activeModelLabel) === g.family);

        const members = memberNames.map((name) => ({
          name,
          isCurrent: Boolean(activeBaseKey && normalizeQuotaModelKey(name) === activeBaseKey)
        }));

        let minPct = 100;
        const buckets = g.buckets.map((b) => {
          const pct = Math.max(0, Math.min(100, Math.round(clampQuota01(b.remainingFraction) * 100)));
          if (pct < minPct) minPct = pct;
          return {
            windowKey: b.windowKey,
            label: getQuotaWindowLabel(b.windowKey, b.label, isZh, false),
            compactLabel: getQuotaWindowLabel(b.windowKey, b.label, isZh, true),
            tooltipLabel: getQuotaWindowTooltipLabel(b.windowKey, b.tooltipLabel, isZh),
            remainingFraction: b.remainingFraction,
            pct,
            resetAtMs: b.resetAtMs || 0,
            level: quotaLevelFromPct(pct),
            description: b.description || ''
          };
        });

        pools.push({
          id: g.id,
          family: g.family,
          name: getQuotaGroupTitle(g.family, g.rawDisplayName || g.name, isZh),
          description: g.description || '',
          isActive,
          isAlert: minPct < AG_QUOTA_ALERT_PCT,
          minPct,
          level: quotaLevelFromPct(minPct),
          buckets,
          members
        });
      }
    } else if (fallbackGroupMap.size > 0) {
      fallbackGroupMap.forEach((fg) => {
        const chosen = fg.activeQuota || fg.minQuota;
        if (!chosen) return;
        const pct = Math.max(0, Math.min(100, Math.round(clampQuota01(chosen.remainingFraction) * 100)));
        const usMap = familyModelsMap.get(fg.family);
        const members = [];
        if (usMap) {
          usMap.forEach((_, name) => {
            members.push({
              name,
              isCurrent: Boolean(activeBaseKey && normalizeQuotaModelKey(name) === activeBaseKey)
            });
          });
        }
        const isActive =
          Boolean(fg.activeQuota) || Boolean(activeModelLabel && classifyQuotaFamily(activeModelLabel) === fg.family);
        const fallbackWinKey = fg.family === 'argon' ? 'weekly' : 'default';
        pools.push({
          id: fg.id,
          family: fg.family,
          name: fg.name,
          description: '',
          isActive,
          isAlert: pct < AG_QUOTA_ALERT_PCT,
          minPct: pct,
          level: quotaLevelFromPct(pct),
          buckets: [
            {
              windowKey: fallbackWinKey,
              label: getQuotaWindowLabel(fallbackWinKey, '', isZh, false),
              compactLabel: getQuotaWindowLabel(fallbackWinKey, '', isZh, true),
              tooltipLabel: getQuotaWindowTooltipLabel(fallbackWinKey, '', isZh),
              remainingFraction: chosen.remainingFraction,
              pct,
              resetAtMs: chosen.resetAtMs || 0,
              level: quotaLevelFromPct(pct),
              description: ''
            }
          ],
          members
        });
      });
    }

    pools.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return (familyOrder[a.family] || 9) - (familyOrder[b.family] || 9);
    });
    return pools;
  }

  function formatShortQuotaReset(resetAtMs, nowMs, isZh = true) {
    if (!resetAtMs || resetAtMs <= 0) return '';
    const diffSec = Math.round((resetAtMs - nowMs) / 1000);
    if (diffSec <= 0) return getQuotaLocaleStrings(isZh).pendingSync;
    if (diffSec < 60) return '<1m';
    const totalMin = Math.floor(diffSec / 60);
    if (totalMin < 60) return totalMin + 'm';
    const totalHours = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    if (totalHours < 24) return totalHours + 'h' + (remMin > 0 ? remMin + 'm' : '');
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return days + 'd' + (remHours > 0 ? remHours + 'h' : '');
  }

  function formatExactQuotaTime(tsMs, isZh = true, nowDate = new Date()) {
    const t = getQuotaLocaleStrings(isZh);
    if (!tsMs || tsMs <= 0) return t.notAvailable;
    const d = new Date(tsMs);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (
      d.getFullYear() === nowDate.getFullYear() &&
      d.getMonth() === nowDate.getMonth() &&
      d.getDate() === nowDate.getDate()
    ) {
      return t.todayPrefix + hhmm;
    }
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hhmm;
  }

  const agQuotaState = {
    initialized: false,
    summarySnapshot: null,
    userStatusSnapshot: null,
    fromCache: false,
    collapsed: false,
    hoveredPoolId: null,
    lastRenderSig: '',
    lastForceRefreshAt: 0,
    isSummaryFetching: false,
    wasGenerating: false,
    hideTimer: null,
    renderTimer: null,
    summaryTimer: null,
    turnRefreshTimer: null,
    observer: null,
    observerTimer: null,
    onFocusOrVisFn: null
  };

  function cleanupStaleQuotaDom() {
    if (typeof document === 'undefined') return;
    const oldCard = document.getElementById(AG_QUOTA_CARD_ID);
    if (oldCard) oldCard.remove();
    const oldTt = document.getElementById(AG_QUOTA_TOOLTIP_ID);
    if (oldTt) oldTt.remove();
  }

  function destroyQuotaCard() {
    if (agQuotaState.renderTimer) {
      clearInterval(agQuotaState.renderTimer);
      agQuotaState.renderTimer = null;
    }
    if (agQuotaState.summaryTimer) {
      clearInterval(agQuotaState.summaryTimer);
      agQuotaState.summaryTimer = null;
    }
    if (agQuotaState.hideTimer) {
      clearTimeout(agQuotaState.hideTimer);
      agQuotaState.hideTimer = null;
    }
    if (agQuotaState.turnRefreshTimer) {
      clearTimeout(agQuotaState.turnRefreshTimer);
      agQuotaState.turnRefreshTimer = null;
    }
    if (agQuotaState.observerTimer) {
      clearTimeout(agQuotaState.observerTimer);
      agQuotaState.observerTimer = null;
    }
    if (agQuotaState.observer) {
      try {
        agQuotaState.observer.disconnect();
      } catch {}
      agQuotaState.observer = null;
    }
    if (typeof window !== 'undefined' && agQuotaState.onFocusOrVisFn) {
      try { window.removeEventListener('focus', agQuotaState.onFocusOrVisFn); } catch {}
    }
    if (typeof document !== 'undefined' && agQuotaState.onFocusOrVisFn) {
      try { document.removeEventListener('visibilitychange', agQuotaState.onFocusOrVisFn); } catch {}
    }
    agQuotaState.onFocusOrVisFn = null;
    agQuotaState.initialized = false;
    cleanupStaleQuotaDom();
  }

  function extractActiveQuotaModelLabel() {
    try {
      const boxes = document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]');
      let el = null;
      for (let i = 0; i < boxes.length; i++) {
        if (!boxes[i].closest('[data-testid="side-question-tab-content"]')) {
          el = boxes[i].querySelector('[data-testid="model-selector-trigger"]');
          if (el) break;
        }
      }
      if (!el) el = document.querySelector('[data-testid="model-selector-trigger"]');
      if (!el) return '';

      const fk = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (fk && el[fk]) {
        let f = el[fk];
        for (let i = 0; i < 6 && f; i++, f = f.return) {
          const al = f.memoizedProps && f.memoizedProps['aria-label'];
          if (typeof al === 'string' && /(?:Select model|Model(?:\s+selector)?|选择模型|模型)/i.test(al)) {
            return al
              .replace(/^(?:Select model|Model(?:\s+selector)?|选择模型|模型)(?:[,，]\s*(?:current|当前))?[:：]\s*/i, '')
              .trim();
          }
        }
      }
      const origAl = el.getAttribute('data-ag-orig-aria-label');
      if (origAl) {
        return origAl
          .replace(/^(?:Select model|Model(?:\s+selector)?|选择模型|模型)(?:[,，]\s*(?:current|当前))?[:：]\s*/i, '')
          .trim();
      }
      return String(el.innerText || '').trim();
    } catch {
      return '';
    }
  }

  function getQuotaFiberAnchorCandidates() {
    const candidates = [];
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (settingsBtn) candidates.push(settingsBtn);
    const boxes = document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]');
    for (let i = 0; i < boxes.length; i++) candidates.push(boxes[i]);
    const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
    if (trigger) candidates.push(trigger);
    const convView = document.querySelector('[data-testid="conversation-view"]');
    if (convView) candidates.push(convView);
    const rootEl = document.getElementById('root') || (document.body && document.body.firstElementChild);
    if (rootEl) candidates.push(rootEl);
    return candidates;
  }

  function readLiveQuotaUserStatus() {
    try {
      const candidates = getQuotaFiberAnchorCandidates();
      for (let c = 0; c < candidates.length; c++) {
        const host = candidates[c];
        const fk = Object.keys(host).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        let cur = fk ? host[fk] : null;
        for (let i = 0; i < 240 && cur; i++, cur = cur.return) {
          const p = cur.memoizedProps;
          if (!p) continue;
          const us =
            (p.value && p.value.userStatus) ||
            p.userStatus ||
            (p.value &&
              p.value.themeStore &&
              typeof p.value.themeStore.getState === 'function' &&
              p.value.themeStore.getState().userStatus);
          if (us && us.cascadeModelConfigData && Array.isArray(us.cascadeModelConfigData.clientModelConfigs)) {
            return us;
          }
        }
      }
    } catch {}
    return null;
  }

  function findQuotaSummaryService() {
    try {
      const candidates = getQuotaFiberAnchorCandidates();
      for (let c = 0; c < candidates.length; c++) {
        const host = candidates[c];
        const fk = Object.keys(host).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        let cur = fk ? host[fk] : null;
        for (let i = 0; i < 320 && cur; i++, cur = cur.return) {
          const v = cur.memoizedProps && cur.memoizedProps.value;
          if (!v || typeof v !== 'object') continue;
          if (typeof v.retrieveUserQuotaSummary === 'function') return v;
          if (v.cloudCodeService && typeof v.cloudCodeService.retrieveUserQuotaSummary === 'function') {
            return v.cloudCodeService;
          }
        }
      }
    } catch {}
    return null;
  }

  function loadCachedQuotaSummary() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(AG_QUOTA_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.groups) && parsed.groups.length > 0) {
          return parsed;
        }
      }
      const legacy = localStorage.getItem(AG_QUOTA_LEGACY_CACHE_KEY);
      if (legacy) {
        const parsedLegacy = JSON.parse(legacy);
        if (parsedLegacy && Array.isArray(parsedLegacy.models) && parsedLegacy.models.length > 0) {
          return { fallbackUserStatus: parsedLegacy };
        }
      }
    } catch {}
    return null;
  }

  function saveCachedQuotaSummary(snap) {
    if (!snap || !Array.isArray(snap.groups) || !snap.groups.length) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(AG_QUOTA_CACHE_KEY, JSON.stringify(snap));
      }
    } catch {}
  }

  function getActiveQuotaMetaSnapshot() {
    return agQuotaState.summarySnapshot || agQuotaState.userStatusSnapshot || null;
  }

  function scheduleHideQuotaTooltip() {
    if (agQuotaState.hideTimer) clearTimeout(agQuotaState.hideTimer);
    agQuotaState.hideTimer = setTimeout(() => {
      agQuotaState.hoveredPoolId = null;
      const tt = document.getElementById(AG_QUOTA_TOOLTIP_ID);
      if (tt) tt.removeAttribute('data-visible');
    }, 140);
  }

  function ensureQuotaTooltipEl() {
    let tt = document.getElementById(AG_QUOTA_TOOLTIP_ID);
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = AG_QUOTA_TOOLTIP_ID;
      document.body.appendChild(tt);
      tt.addEventListener('mouseenter', () => {
        if (agQuotaState.hideTimer) {
          clearTimeout(agQuotaState.hideTimer);
          agQuotaState.hideTimer = null;
        }
      });
      tt.addEventListener('mouseleave', () => {
        scheduleHideQuotaTooltip();
      });
    }
    return tt;
  }

  function positionQuotaTooltip(anchorEl, tt) {
    if (!anchorEl || !tt) return;
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const ttW = tt.offsetWidth || 306;
    const ttH = tt.offsetHeight || 180;
    let left = rect.right + 10;
    if (left + ttW > vw - 12) {
      left = Math.max(12, vw - ttW - 12);
    }
    let top = rect.top + rect.height / 2 - ttH / 2;
    if (top + ttH > vh - 12) top = vh - ttH - 12;
    if (top < 12) top = 12;
    tt.style.left = Math.round(left) + 'px';
    tt.style.top = Math.round(top) + 'px';
  }

  function renderQuotaTooltip(anchorEl, poolId) {
    const tt = ensureQuotaTooltipEl();
    const activeSnap = getActiveQuotaMetaSnapshot();
    if (!tt || !activeSnap) return;

    const isZh = isQuotaZhLocale();
    const t = getQuotaLocaleStrings(isZh);
    const nowMs = Date.now();
    const activeModel = extractActiveQuotaModelLabel();
    const pools = buildQuotaPools(agQuotaState.summarySnapshot, agQuotaState.userStatusSnapshot, activeModel, isZh);
    if (!pools.length) return;

    const exactPct = (f) => {
      const val = clampQuota01(f) * 100;
      return val >= 99.95 ? '100%' : val.toFixed(1) + '%';
    };

    const creditsText = activeSnap.aiCredits > 0 ? t.creditsPrefix + activeSnap.aiCredits : '';
    const planText = activeSnap.planName
      ? '<code class="ag-q-raw">' + escapeQuotaHtml(activeSnap.planName) + '</code>'
      : t.currentAccount;
    const syncText = (agQuotaState.fromCache ? t.cachedAtPrefix : t.syncedAtPrefix) + formatExactQuotaTime(activeSnap.updatedAt, isZh);

    if (poolId) {
      const pool = pools.find((p) => p.id === poolId);
      if (!pool) return;

      const bucketCards = pool.buckets
        .map((b) => {
          const resetStr = formatShortQuotaReset(b.resetAtMs, nowMs, isZh);
          const exactReset = b.resetAtMs > 0 ? formatExactQuotaTime(b.resetAtMs, isZh) : t.notAvailable;
          return (
            '<div class="ag-qt-bucket-card lvl-' +
            b.level +
            '">' +
            '<div class="ag-qt-bucket-top">' +
            '<span class="ag-qt-bucket-name">' +
            escapeQuotaHtml(b.tooltipLabel) +
            '</span>' +
            '<span class="ag-qt-bucket-val">' +
            escapeQuotaHtml(exactPct(b.remainingFraction)) +
            t.leftSuffix +
            '</span>' +
            '</div>' +
            '<div class="ag-qt-bucket-track"><div class="ag-qt-bucket-fill" style="width:' +
            b.pct +
            '%"></div></div>' +
            '<div class="ag-qt-bucket-meta">' +
            '<span>' +
            escapeQuotaHtml(t.countdownPrefix + (resetStr || t.notAvailable)) +
            '</span>' +
            '<span>' +
            escapeQuotaHtml(t.resetPrefix + exactReset) +
            '</span>' +
            '</div>' +
            '</div>'
          );
        })
        .join('');

      const chips = pool.members
        .map(
          (member) =>
            '<span class="ag-qt-model-chip' +
            (member.isCurrent ? ' is-active' : '') +
            '"><code class="ag-q-raw">' +
            escapeQuotaHtml(member.name) +
            '</code></span>'
        )
        .join('');

      tt.innerHTML =
        '<div class="ag-qt-hdr">' +
        '<span class="ag-qt-title"><code class="ag-q-raw">' +
        escapeQuotaHtml(pool.name) +
        '</code></span>' +
        '<span class="ag-qt-pct">' +
        escapeQuotaHtml(pool.isActive ? t.activePool : t.standbyPool) +
        '</span>' +
        '</div>' +
        '<div class="ag-qt-bucket-cards">' +
        bucketCards +
        '</div>' +
        (pool.members.length
          ? '<div class="ag-qt-models-lbl">' +
            escapeQuotaHtml(t.modelsLbl) +
            ' (' +
            pool.members.length +
            ')</div><div class="ag-qt-models">' +
            chips +
            '</div>'
          : '') +
        '<div class="ag-qt-foot">' +
        '<span>' +
        escapeQuotaHtml(t.planPrefix) +
        planText +
        escapeQuotaHtml(creditsText) +
        '</span>' +
        '<span>' +
        escapeQuotaHtml(syncText) +
        '</span>' +
        '</div>';
    } else {
      const rows = pools
        .map((p) => {
          const valStr = p.buckets
            .map((b) => {
              const r = formatShortQuotaReset(b.resetAtMs, nowMs, isZh);
              return b.compactLabel + ' ' + b.pct + '%' + (r ? ' (' + r + ')' : '');
            })
            .join(' · ');
          return (
            '<div class="ag-qt-mini-row">' +
            '<span>' +
            (p.isActive ? '● ' : '') +
            '<code class="ag-q-raw">' +
            escapeQuotaHtml(p.name) +
            '</code></span>' +
            '<span class="ag-qt-mini-val">' +
            escapeQuotaHtml(valStr) +
            '</span>' +
            '</div>'
          );
        })
        .join('');

      tt.innerHTML =
        '<div class="ag-qt-hdr">' +
        '<span class="ag-qt-title">' +
        escapeQuotaHtml(t.overviewTitle) +
        '</span>' +
        '<span class="ag-qt-pct">' +
        planText +
        '</span>' +
        '</div>' +
        '<div class="ag-qt-mini-list">' +
        rows +
        '</div>' +
        '<div class="ag-qt-foot">' +
        '<span>' +
        escapeQuotaHtml(activeSnap.aiCredits > 0 ? t.aiCreditsFootPrefix + activeSnap.aiCredits : t.clickToExpand) +
        '</span>' +
        '<span>' +
        escapeQuotaHtml(syncText) +
        '</span>' +
        '</div>';
    }

    positionQuotaTooltip(anchorEl, tt);
    tt.setAttribute('data-visible', '1');
  }

  function ensureQuotaCardMounted(isZh) {
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (!settingsBtn) return null;
    const footerWrap = settingsBtn.parentElement;
    const sidebarCol = footerWrap && footerWrap.parentElement;
    const mountParent = sidebarCol && sidebarCol.contains(footerWrap) ? sidebarCol : footerWrap;
    if (!mountParent) return null;

    const t = getQuotaLocaleStrings(isZh);
    let card = document.getElementById(AG_QUOTA_CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = AG_QUOTA_CARD_ID;
      card.innerHTML =
        '<button type="button" class="ag-q-header-btn" aria-expanded="true">' +
        '<div class="ag-q-hdr-top">' +
        '<span class="ag-q-title"><code class="ag-q-raw"></code></span>' +
        '<span class="ag-q-hdr-right">' +
        '<span class="ag-q-credits-badge" style="display:none"></span>' +
        '<span class="ag-q-stale-tag" style="display:none"></span>' +
        '<svg class="ag-q-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 6l4 4 4-4"/>' +
        '</svg>' +
        '</span>' +
        '</div>' +
        '<div class="ag-q-hdr-sub"></div>' +
        '</button>' +
        '<div class="ag-q-body"></div>';

      card.addEventListener('click', (e) => {
        const hdrBtn = e.target && e.target.closest ? e.target.closest('.ag-q-header-btn') : null;
        if (!hdrBtn) return;
        e.preventDefault();
        e.stopPropagation();
        agQuotaState.collapsed = !agQuotaState.collapsed;
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(AG_QUOTA_COLLAPSE_KEY, agQuotaState.collapsed ? '1' : '0');
          }
        } catch {}
        card.setAttribute('data-collapsed', agQuotaState.collapsed ? '1' : '0');
        hdrBtn.setAttribute('aria-expanded', agQuotaState.collapsed ? 'false' : 'true');
        agQuotaState.lastRenderSig = '';
        renderQuotaCard(true);
      });

      card.addEventListener('mouseover', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.ag-q-row[data-pool-id]') : null;
        const hdr = e.target && e.target.closest ? e.target.closest('.ag-q-header-btn') : null;
        if (!row && !(hdr && agQuotaState.collapsed)) return;
        if (agQuotaState.hideTimer) {
          clearTimeout(agQuotaState.hideTimer);
          agQuotaState.hideTimer = null;
        }
        const poolId = row ? row.getAttribute('data-pool-id') : null;
        agQuotaState.hoveredPoolId = poolId || '__summary__';
        renderQuotaTooltip(row || card, poolId);
      });

      card.addEventListener('mouseout', (e) => {
        const rel = e.relatedTarget;
        if (rel && rel.closest && (rel.closest('#' + AG_QUOTA_CARD_ID) || rel.closest('#' + AG_QUOTA_TOOLTIP_ID))) return;
        scheduleHideQuotaTooltip();
      });
    }

    card.setAttribute('data-ag-quota-lang', t.lang);
    const titleCodeEl = card.querySelector('.ag-q-title > code.ag-q-raw') || card.querySelector('.ag-q-title');
    if (titleCodeEl && titleCodeEl.textContent !== t.cardTitle) {
      titleCodeEl.textContent = t.cardTitle;
    }

    if (mountParent === sidebarCol) {
      if (card.parentElement !== sidebarCol || card.nextElementSibling !== footerWrap) {
        sidebarCol.insertBefore(card, footerWrap);
      }
    } else if (card.parentElement !== footerWrap || card.nextElementSibling !== settingsBtn) {
      footerWrap.insertBefore(card, settingsBtn);
    }
    return card;
  }

  function renderQuotaBucketSubRowHtml(bucket, nowMs, isZh) {
    const resetStr = formatShortQuotaReset(bucket.resetAtMs, nowMs, isZh);
    return (
      '<div class="ag-q-bucket lvl-' +
      bucket.level +
      '">' +
      '<span class="ag-q-win-tag"><code class="ag-q-raw">' +
      escapeQuotaHtml(bucket.label) +
      '</code></span>' +
      '<div class="ag-q-track"><div class="ag-q-fill" style="width:' +
      bucket.pct +
      '%"></div></div>' +
      '<span class="ag-q-b-nums">' +
      '<span class="ag-q-pct">' +
      bucket.pct +
      '%</span>' +
      (resetStr ? '<span class="ag-q-reset">' + escapeQuotaHtml(resetStr) + '</span>' : '') +
      '</span>' +
      '</div>'
    );
  }

  function renderQuotaCard(forceRender) {
    if (typeof document === 'undefined') return;
    if (typeof MODULES === 'object' && MODULES.quota === false) return;

    if (!agQuotaState.summarySnapshot && !agQuotaState.userStatusSnapshot) {
      const cached = loadCachedQuotaSummary();
      if (cached) {
        if (cached.fallbackUserStatus) {
          agQuotaState.userStatusSnapshot = cached.fallbackUserStatus;
        } else {
          agQuotaState.summarySnapshot = cached;
        }
        agQuotaState.fromCache = true;
      }
    }

    const liveUs = readLiveQuotaUserStatus();
    if (liveUs) {
      const snap = buildQuotaSnapshotFromUserStatus(liveUs);
      if (snap) {
        agQuotaState.userStatusSnapshot = snap;
        if (agQuotaState.summarySnapshot) {
          if (snap.planName) agQuotaState.summarySnapshot.planName = snap.planName;
          agQuotaState.summarySnapshot.aiCredits = snap.aiCredits;
        }
      }
    }

    const isZh = isQuotaZhLocale();
    const t = getQuotaLocaleStrings(isZh);
    const card = ensureQuotaCardMounted(isZh);
    if (!card) return;

    const nowMs = Date.now();
    const activeModel = extractActiveQuotaModelLabel();
    const pools = buildQuotaPools(agQuotaState.summarySnapshot, agQuotaState.userStatusSnapshot, activeModel, isZh);
    const primaryPool = pools.find((p) => p.isActive) || pools[0] || null;
    const metaSnap = getActiveQuotaMetaSnapshot();

    const sig = JSON.stringify({
      l: t.lang,
      c: agQuotaState.collapsed ? 1 : 0,
      f: agQuotaState.fromCache ? 1 : 0,
      cr: metaSnap ? metaSnap.aiCredits : 0,
      am: activeModel,
      p: pools.map((x) => [
        x.id,
        x.isActive ? 1 : 0,
        x.isAlert ? 1 : 0,
        x.buckets.map((b) => [b.windowKey, b.pct, formatShortQuotaReset(b.resetAtMs, nowMs, isZh)])
      ])
    });

    if (
      !forceRender &&
      sig === agQuotaState.lastRenderSig &&
      card.getAttribute('data-collapsed') === (agQuotaState.collapsed ? '1' : '0')
    ) {
      return;
    }
    agQuotaState.lastRenderSig = sig;
    card.setAttribute('data-collapsed', agQuotaState.collapsed ? '1' : '0');

    const hdrBtn = card.querySelector('.ag-q-header-btn');
    if (hdrBtn) hdrBtn.setAttribute('aria-expanded', agQuotaState.collapsed ? 'false' : 'true');

    const hdrSubEl = card.querySelector('.ag-q-hdr-sub');
    if (hdrSubEl) {
      if (agQuotaState.collapsed) {
        if (primaryPool && primaryPool.buckets.length) {
          hdrSubEl.innerHTML = primaryPool.buckets
            .map((b) => {
              const rStr = formatShortQuotaReset(b.resetAtMs, nowMs, isZh);
              return (
                '<span class="ag-q-sub-item lvl-' +
                b.level +
                '">' +
                '<span class="ag-q-sub-win"><code class="ag-q-raw">' +
                escapeQuotaHtml(b.label) +
                '</code></span>' +
                '<span class="ag-q-sub-pct">' +
                b.pct +
                '%</span>' +
                (rStr ? '<span class="ag-q-sub-reset">' + escapeQuotaHtml(rStr) + '</span>' : '') +
                '</span>'
              );
            })
            .join('<span class="ag-q-sub-sep">·</span>');
        } else {
          hdrSubEl.innerHTML = '<span class="ag-q-sub-win">' + escapeQuotaHtml(t.waitSync) + '</span>';
        }
      } else {
        hdrSubEl.innerHTML = '';
      }
    }

    const creditsEl = card.querySelector('.ag-q-credits-badge');
    if (creditsEl) {
      if (metaSnap && metaSnap.aiCredits > 0) {
        creditsEl.textContent = metaSnap.aiCredits + t.creditsUnit;
        creditsEl.style.display = '';
      } else {
        creditsEl.style.display = 'none';
      }
    }

    const staleEl = card.querySelector('.ag-q-stale-tag');
    if (staleEl) {
      const showCacheBadge =
        (agQuotaState.fromCache || (!agQuotaState.summarySnapshot && Boolean(agQuotaState.userStatusSnapshot))) &&
        !agQuotaState.collapsed;
      staleEl.textContent = t.cachedTag;
      staleEl.style.display = showCacheBadge ? '' : 'none';
    }

    const bodyEl = card.querySelector('.ag-q-body');
    if (!bodyEl) return;
    if (!pools.length) {
      bodyEl.innerHTML = '<div class="ag-q-empty">' + escapeQuotaHtml(t.loadingQuota) + '</div>';
      return;
    }

    const htmlParts = [];
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      const expandedRow = p.isActive || p.isAlert;
      if (i > 0 && pools[i - 1].isActive && !expandedRow) {
        htmlParts.push('<div class="ag-q-divider"></div>');
      }

      if (expandedRow) {
        const dotHtml = p.isActive ? '<span class="ag-q-active-dot"></span>' : '';
        const alertBadge = !p.isActive && p.isAlert ? '<span class="ag-q-alert-badge">' + escapeQuotaHtml(t.lowAlert) + '</span>' : '';
        const bucketsHtml = p.buckets.map((b) => renderQuotaBucketSubRowHtml(b, nowMs, isZh)).join('');
        htmlParts.push(
          '<div class="ag-q-row lvl-' +
            p.level +
            (p.isActive ? ' is-active' : '') +
            (p.isAlert ? ' is-alert' : '') +
            '" data-pool-id="' +
            escapeQuotaHtml(p.id) +
            '">' +
            '<div class="ag-q-row-head">' +
            '<span class="ag-q-name-wrap">' +
            dotHtml +
            '<span class="ag-q-name"><code class="ag-q-raw">' +
            escapeQuotaHtml(p.name) +
            '</code></span>' +
            '</span>' +
            alertBadge +
            '</div>' +
            '<div class="ag-q-buckets">' +
            bucketsHtml +
            '</div>' +
            '</div>'
        );
      } else {
        const summaryStr = p.buckets.map((b) => b.compactLabel + ' ' + b.pct + '%').join('·');
        htmlParts.push(
          '<div class="ag-q-row is-inactive lvl-' +
            p.level +
            '" data-pool-id="' +
            escapeQuotaHtml(p.id) +
            '">' +
            '<div class="ag-q-inactive-line">' +
            '<span class="ag-q-name"><code class="ag-q-raw">' +
            escapeQuotaHtml(p.name) +
            '</code></span>' +
            '<span class="ag-q-inactive-vals">' +
            escapeQuotaHtml(summaryStr) +
            '</span>' +
            '</div>' +
            '</div>'
        );
      }
    }
    bodyEl.innerHTML = htmlParts.join('');
  }

  async function refreshQuotaSummary(forceRefresh) {
    if (agQuotaState.isSummaryFetching) return;
    if (typeof MODULES === 'object' && MODULES.quota === false) return;
    const now = Date.now();
    if (forceRefresh && now - agQuotaState.lastForceRefreshAt < AG_QUOTA_FORCE_MIN_GAP_MS) {
      forceRefresh = false;
    }

    const svc = findQuotaSummaryService();
    if (!svc) return;

    agQuotaState.isSummaryFetching = true;
    if (forceRefresh) agQuotaState.lastForceRefreshAt = now;
    try {
      const res = await svc.retrieveUserQuotaSummary(Boolean(forceRefresh));
      const liveUs = readLiveQuotaUserStatus();
      const meta = liveUs ? parseQuotaPlanMeta(liveUs) : getActiveQuotaMetaSnapshot();
      const snap = buildSnapshotFromQuotaSummary(res, meta, isQuotaZhLocale());
      if (snap) {
        agQuotaState.summarySnapshot = snap;
        agQuotaState.fromCache = false;
        saveCachedQuotaSummary(snap);
        renderQuotaCard(true);
      }
    } catch {
      // Silent fallback to cached / userStatus values on transient RPC error
    } finally {
      agQuotaState.isSummaryFetching = false;
    }
  }

  function checkQuotaTurnCompletion() {
    if (typeof document === 'undefined') return;
    const isGenerating = Boolean(document.querySelector('[data-testid="input-cancel-button"]'));
    if (agQuotaState.wasGenerating && !isGenerating) {
      if (agQuotaState.turnRefreshTimer) clearTimeout(agQuotaState.turnRefreshTimer);
      agQuotaState.turnRefreshTimer = setTimeout(() => {
        refreshQuotaSummary(true);
      }, 900);
    }
    agQuotaState.wasGenerating = isGenerating;
  }

  function initQuotaCard() {
    destroyQuotaCard();
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.top !== window) return;
    if (typeof IS_SWARM_PLUGIN_FRAME !== 'undefined' && IS_SWARM_PLUGIN_FRAME) return;
    if (typeof ENABLED !== 'undefined' && !ENABLED) return;
    if (typeof MODULES === 'object' && MODULES.quota === false) return;

    agQuotaState.initialized = true;
    try {
      if (typeof localStorage !== 'undefined') {
        agQuotaState.collapsed = localStorage.getItem(AG_QUOTA_COLLAPSE_KEY) === '1';
      }
    } catch {}

    renderQuotaCard(true);
    refreshQuotaSummary(false);

    agQuotaState.renderTimer = setInterval(() => {
      if (document.hidden) return;
      checkQuotaTurnCompletion();
      renderQuotaCard(false);
    }, AG_QUOTA_RENDER_MS);

    agQuotaState.summaryTimer = setInterval(() => {
      if (!document.hidden) refreshQuotaSummary(false);
    }, AG_QUOTA_POLL_MS);

    if (typeof MutationObserver !== 'undefined' && document.body) {
      agQuotaState.observer = new MutationObserver(() => {
        checkQuotaTurnCompletion();
        const card = document.getElementById(AG_QUOTA_CARD_ID);
        if (!card || !card.isConnected) {
          if (agQuotaState.observerTimer) clearTimeout(agQuotaState.observerTimer);
          agQuotaState.observerTimer = setTimeout(() => renderQuotaCard(true), 60);
        }
      });
      agQuotaState.observer.observe(document.body, { childList: true, subtree: true });
    }

    agQuotaState.onFocusOrVisFn = () => {
      if (!document.hidden) {
        renderQuotaCard(false);
        refreshQuotaSummary(true);
      }
    };
    window.addEventListener('focus', agQuotaState.onFocusOrVisFn);
    document.addEventListener('visibilitychange', agQuotaState.onFocusOrVisFn);

    if (Array.isArray(window.__ag_cleanup_fns)) {
      window.__ag_cleanup_fns.push(destroyQuotaCard);
    }
  }

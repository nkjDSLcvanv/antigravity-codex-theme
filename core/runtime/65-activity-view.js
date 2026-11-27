/**
 * Part 65: Codex-Style Activity View (Sidebar Overlay, Priority/Recent Grouping & Opt+Cmd+U Shortcut)
 * Pure helpers (normalizeActivityPrefs, isDefaultActivityPrefs, parseActivityTimestampMs,
 * isToggleActivityShortcut, extractActivityWorkspaceLabel, classifyConversationAttention,
 * sortActivityPriorityItems, groupActivitySections, formatActivityDayLabel)
 * have zero DOM dependencies so unit tests can evaluate this file directly.
 */
  const AG_ACTIVITY_ATTENTION_RANK = Object.freeze({
    waiting: 0,
    input: 0,
    approval: 0,
    error: 0,
    unread: 1,
    active: 2,
    idle: 3
  });

  const AG_ACTIVITY_DEFAULT_PREFS = Object.freeze({
    showPriority: true,
    showPinned: false,
    showScheduled: false,
    unreadOnly: false
  });

  function normalizeActivityPrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      showPriority: src.showPriority !== false,
      showPinned: Boolean(src.showPinned),
      showScheduled: Boolean(src.showScheduled),
      unreadOnly: Boolean(src.unreadOnly)
    };
  }

  function isDefaultActivityPrefs(prefs) {
    const p = normalizeActivityPrefs(prefs);
    return (
      p.showPriority === AG_ACTIVITY_DEFAULT_PREFS.showPriority &&
      p.showPinned === AG_ACTIVITY_DEFAULT_PREFS.showPinned &&
      p.showScheduled === AG_ACTIVITY_DEFAULT_PREFS.showScheduled &&
      p.unreadOnly === AG_ACTIVITY_DEFAULT_PREFS.unreadOnly
    );
  }

  function parseActivityTimestampMs(raw) {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw <= 0) return 0;
      return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
    }
    if (typeof raw === 'bigint') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return 0;
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    if (typeof raw === 'object') {
      const sec = Number(raw.seconds);
      if (!Number.isFinite(sec) || sec <= 0) return 0;
      const nanos = Number(raw.nanos || 0);
      return Math.round(sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0));
    }
    return 0;
  }

  function isToggleActivityShortcut(ev, platform) {
    if (!ev || typeof ev !== 'object') return false;
    const isMac = String(platform || '').toLowerCase().includes('mac') || String(platform || '').toLowerCase() === 'darwin';
    const modsOk = isMac
      ? Boolean(ev.metaKey && ev.altKey && !ev.ctrlKey && !ev.shiftKey)
      : Boolean(ev.ctrlKey && ev.altKey && !ev.metaKey && !ev.shiftKey);
    if (!modsOk) return false;
    // Check ev.code === 'KeyU' first because macOS Option+U emits dead key '¨' in ev.key
    if (ev.code === 'KeyU') return true;
    const k = String(ev.key || '').toLowerCase();
    return k === 'u' || k === '¨';
  }

  function extractWorkspaceBasename(rawUri) {
    let s = String(rawUri || '').trim();
    if (!s) return '';
    try {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
        const u = new URL(s);
        s = decodeURIComponent(u.pathname || '');
      }
    } catch {}
    s = s.replace(/[\\/]+$/, '');
    if (!s) return '';
    const parts = s.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  function extractActivityWorkspaceLabel(summary, projectNameMap, isZh) {
    if (!summary || typeof summary !== 'object') return '';
    const candidates = [];
    const pushWsList = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (!entry) continue;
        if (typeof entry === 'string') {
          candidates.push(entry);
        } else if (typeof entry === 'object') {
          if (entry.name) candidates.push(String(entry.name));
          if (entry.workspaceFolderAbsoluteUri) candidates.push(String(entry.workspaceFolderAbsoluteUri));
          if (entry.uri) candidates.push(String(entry.uri));
          if (entry.path) candidates.push(String(entry.path));
        }
      }
    };
    pushWsList(summary.workspaces);
    if (summary.trajectoryMetadata) {
      pushWsList(summary.trajectoryMetadata.workspaces);
      pushWsList(summary.trajectoryMetadata.workspaceUris);
    }
    for (let i = 0; i < candidates.length; i++) {
      const base = extractWorkspaceBasename(candidates[i]) || String(candidates[i]).trim();
      if (base) return base;
    }
    const projectId = String(summary.trajectoryMetadata?.projectId || '').trim();
    if (projectId) {
      if (projectId === 'outside-of-project') {
        return isZh ? '项目外' : 'Outside of Project';
      }
      if (projectNameMap && typeof projectNameMap === 'object' && projectNameMap[projectId]) {
        return String(projectNameMap[projectId]).trim();
      }
      if (projectId === 'default-cli-project') {
        return isZh ? 'CLI 项目' : 'CLI Project';
      }
      if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
        return projectId;
      }
    }
    return '';
  }

  function classifyConversationAttention(item) {
    if (!item || typeof item !== 'object') return 'idle';
    if (item.hasWaiting || Number(item.waitingCount || 0) > 0 || Number(item.openCardCount || 0) > 0) {
      return 'waiting';
    }
    if (item.hasError || item.interrupted) {
      return 'error';
    }
    // Match Codex Desktop (JHLi -> Ypxi.Kq): active/working takes precedence over unread
    // so running or background-task sessions never display the blue completed/unread dot.
    if (item.isActive) {
      return 'active';
    }
    if (item.isUnread) {
      return 'unread';
    }
    return 'idle';
  }

  function sortActivityPriorityItems(items) {
    if (!Array.isArray(items)) return [];
    return items.slice().sort((a, b) => {
      const ra = Object.prototype.hasOwnProperty.call(AG_ACTIVITY_ATTENTION_RANK, a.attentionState)
        ? AG_ACTIVITY_ATTENTION_RANK[a.attentionState]
        : 3;
      const rb = Object.prototype.hasOwnProperty.call(AG_ACTIVITY_ATTENTION_RANK, b.attentionState)
        ? AG_ACTIVITY_ATTENTION_RANK[b.attentionState]
        : 3;
      if (ra !== rb) return ra - rb;
      return (Number(b.recencyMs) || 0) - (Number(a.recencyMs) || 0);
    });
  }

  function startOfLocalDayMs(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function formatActivityDayLabel(dayStartMs, relativeDay, isZh) {
    if (relativeDay === 'today') return isZh ? '今天' : 'Today';
    if (relativeDay === 'yesterday') return isZh ? '昨天' : 'Yesterday';
    if (relativeDay === 'earlier') return isZh ? '更早' : 'Earlier';
    try {
      const locale = isZh ? 'zh-CN' : 'en-US';
      return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(dayStartMs));
    } catch {
      const zhDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const enDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const wd = new Date(dayStartMs).getDay();
      return (isZh ? zhDays : enDays)[wd] || '';
    }
  }

  function groupActivitySections({
    items = [],
    heldPriorityIds = null,
    clearedReadIds = null,
    prefs = AG_ACTIVITY_DEFAULT_PREFS,
    nowMs = Date.now(),
    visibleLimit = 10
  } = {}) {
    const p = normalizeActivityPrefs(prefs);
    const heldSet = heldPriorityIds && typeof heldPriorityIds.has === 'function' ? heldPriorityIds : new Set();
    const clearedSet = clearedReadIds && typeof clearedReadIds.has === 'function' ? clearedReadIds : new Set();
    const limit = Number.isFinite(visibleLimit) && visibleLimit > 0 ? Math.floor(visibleLimit) : 10;

    const eligible = [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      if (!raw || !raw.id || raw.isArchived) continue;
      if (raw.isScheduled && !p.showScheduled) continue;
      const attentionState = classifyConversationAttention(raw);
      eligible.push(Object.assign({}, raw, { attentionState }));
    }

    let hasAnyAttention = false;
    for (let i = 0; i < eligible.length; i++) {
      const st = eligible[i].attentionState;
      if (st === 'waiting' || st === 'error' || st === 'unread') {
        hasAnyAttention = true;
        break;
      }
    }

    const pinnedSet = new Set();
    const pinnedAll = [];
    for (let i = 0; i < eligible.length; i++) {
      if (eligible[i].isPinned) {
        pinnedSet.add(eligible[i].id);
        pinnedAll.push(eligible[i]);
      }
    }

    const priorityAll = [];
    const priorityIdSet = new Set();
    if (p.showPriority) {
      for (let i = 0; i < eligible.length; i++) {
        const it = eligible[i];
        if (p.showPinned && pinnedSet.has(it.id)) continue;
        const isLivePriority = it.attentionState !== 'idle';
        const isHeldRead = !isLivePriority && heldSet.has(it.id) && !clearedSet.has(it.id);
        if (p.unreadOnly) {
          if (it.attentionState === 'waiting' || it.attentionState === 'error' || it.attentionState === 'unread') {
            priorityAll.push(it);
            priorityIdSet.add(it.id);
          }
        } else if (isLivePriority || isHeldRead) {
          priorityAll.push(it);
          priorityIdSet.add(it.id);
        }
      }
    }
    const sortedPriority = sortActivityPriorityItems(priorityAll);
    const hasHeldReadInPriority =
      p.showPriority && sortedPriority.some((it) => it.attentionState === 'idle');
    const unreadPriorityCount = sortedPriority.filter(
      (it) => it.attentionState === 'unread' || (it.isUnread && it.attentionState !== 'active')
    ).length;
    const eligibleUnreadCount = eligible.filter(
      (it) => it.attentionState === 'unread' || (it.isUnread && it.attentionState !== 'active')
    ).length;

    const pinnedFiltered = p.showPinned
      ? pinnedAll
          .filter(
            (it) =>
              !p.unreadOnly ||
              it.attentionState === 'unread' ||
              it.attentionState === 'waiting' ||
              it.attentionState === 'error'
          )
          .sort((a, b) => (Number(b.recencyMs) || 0) - (Number(a.recencyMs) || 0))
      : [];

    const todayStart = startOfLocalDayMs(nowMs);
    const yesterdayDate = new Date(todayStart);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStart = yesterdayDate.getTime();
    const weekCutoffDate = new Date(todayStart);
    weekCutoffDate.setDate(weekCutoffDate.getDate() - 6);
    const weekCutoffMs = weekCutoffDate.getTime();

    const recentPool = [];
    for (let i = 0; i < eligible.length; i++) {
      const it = eligible[i];
      if (p.showPriority && priorityIdSet.has(it.id)) continue;
      if (p.showPinned && pinnedSet.has(it.id)) continue;
      if (
        p.unreadOnly &&
        it.attentionState !== 'unread' &&
        it.attentionState !== 'waiting' &&
        it.attentionState !== 'error'
      ) {
        continue;
      }
      recentPool.push(it);
    }
    recentPool.sort((a, b) => (Number(b.recencyMs) || 0) - (Number(a.recencyMs) || 0));

    const recentGroups = [];
    const earlierItems = [];
    for (let i = 0; i < recentPool.length; i++) {
      const it = recentPool[i];
      const rec = Number(it.recencyMs) || 0;
      if (rec < weekCutoffMs) {
        earlierItems.push(it);
        continue;
      }
      const dStart = startOfLocalDayMs(rec);
      const lastGroup = recentGroups.length > 0 ? recentGroups[recentGroups.length - 1] : null;
      if (lastGroup && lastGroup.dayStart === dStart) {
        lastGroup.items.push(it);
      } else {
        const relativeDay =
          dStart === todayStart ? 'today' : dStart === yesterdayStart ? 'yesterday' : 'weekday';
        recentGroups.push({
          kind: 'recent',
          dayStart: dStart,
          relativeDay,
          items: [it]
        });
      }
    }
    if (earlierItems.length > 0) {
      recentGroups.push({
        kind: 'recent',
        dayStart: null,
        relativeDay: 'earlier',
        items: earlierItems
      });
    }

    const sections = [];
    const visibleItems = [];
    const takeSlice = (arr) => {
      const rem = limit - visibleItems.length;
      if (rem <= 0) return [];
      const slice = arr.length <= rem ? arr : arr.slice(0, rem);
      for (let i = 0; i < slice.length; i++) visibleItems.push(slice[i]);
      return slice;
    };

    if (p.showPriority) {
      sections.push({
        kind: 'priority',
        dayStart: null,
        relativeDay: null,
        items: takeSlice(sortedPriority)
      });
    }
    if (p.showPinned && pinnedFiltered.length > 0) {
      const pSlice = takeSlice(pinnedFiltered);
      if (pSlice.length > 0) {
        sections.push({
          kind: 'pinned',
          dayStart: null,
          relativeDay: null,
          items: pSlice
        });
      }
    }

    let totalCount = (p.showPriority ? sortedPriority.length : 0) + pinnedFiltered.length;
    for (let i = 0; i < recentGroups.length; i++) {
      const grp = recentGroups[i];
      totalCount += grp.items.length;
      if (visibleItems.length >= limit) continue;
      const slice = takeSlice(grp.items);
      if (slice.length > 0) {
        sections.push({
          kind: 'recent',
          dayStart: grp.dayStart,
          relativeDay: grp.relativeDay,
          items: slice
        });
      }
    }

    return {
      sections,
      visibleItems,
      totalCount,
      hasMore: totalCount > visibleItems.length,
      hasHeldReadInPriority,
      unreadPriorityCount,
      eligibleUnreadCount,
      hasAnyAttention
    };
  }

  function cleanupActivityViewDom() {
    try {
      for (const id of [
        'ag-activity-toggle-btn',
        'ag-activity-view',
        'ag-activity-options-menu',
        'ag-activity-tooltip'
      ]) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
      if (document.documentElement) {
        document.documentElement.removeAttribute('data-ag-activity-open');
      }
    } catch {}
  }

  function clearActivityViewGlobals(expected = null) {
    const keys = [
      '__ag_toggle_activity_view',
      '__ag_set_activity_view_open',
      '__ag_on_activity_previews',
      '__ag_on_activity_prefs_sync',
      '__ag_get_activity_view_state'
    ];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!expected || window[k] === expected[k]) {
        try {
          delete window[k];
        } catch {
          window[k] = undefined;
        }
      }
    }
  }

  function mountActivityView() {
    if (IS_SWARM_PLUGIN_FRAME || !ENABLED || !MODULES.activityView) {
      window.__ag_activity_open = false;
      clearActivityViewGlobals();
      cleanupActivityViewDom();
      return;
    }
    if (typeof document === 'undefined' || !document.body) return;

    (function initActivityView() {
      const PREFS_STORAGE_KEY = 'ag-activity-view-prefs-v1';
      const READ_TIMES_STORAGE_KEY = 'ag-activity-read-times-v1';
      const MANUAL_UNREAD_STORAGE_KEY = 'ag-activity-manual-unread-v1';
      const PAGE_STEP = 10;

      const platformStr = String(boot.platform || (typeof navigator !== 'undefined' ? navigator.platform : '') || '');
      const isMac = /mac|darwin/i.test(platformStr);
      const shortcutBadgeText = isMac ? '⌥⌘U' : 'Ctrl+Alt+U';

      let disposed = false;
      let isOpen = Boolean(window.__ag_activity_open);
      let optionsOpen = false;
      let visibleLimit = PAGE_STEP;
      let heldPriorityIds = new Set();
      let clearedReadIds = new Set();
      let previewCache = new Map();
      let previewInFlight = new Set();
      let previewReqSeq = 0;
      const pendingPreviewReqs = new Map();
      const prevServerUnread = new Map();
      let renameWatchCleanup = null;

      let cachedStore = null;
      let storeUnsub = null;
      let cachedRouter = null;
      let cachedPms = null;
      let renderScheduled = false;
      let obsTimer = null;
      let pollTimer = null;
      let tooltipHideTimer = null;
      let lastRenderSig = '';
      let lastToggleSig = '';

      function escHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function isZhUi() {
        return Boolean(MODULES.i18n);
      }

      function readJsonStorage(key, fallback) {
        try {
          if (typeof localStorage === 'undefined' || !localStorage) return fallback;
          const raw = localStorage.getItem(key);
          if (!raw) return fallback;
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch {
          return fallback;
        }
      }

      function writeJsonStorage(key, obj) {
        try {
          if (typeof localStorage === 'undefined' || !localStorage) return;
          localStorage.setItem(key, JSON.stringify(obj));
        } catch {}
      }

      const bootPrefs =
        boot.activityView || (boot.userConfig && boot.userConfig.activityView) || null;
      const storedPrefs = readJsonStorage(PREFS_STORAGE_KEY, null);
      let prefs = normalizeActivityPrefs(
        boot.activityViewConfigured && bootPrefs
          ? bootPrefs
          : Object.assign({}, bootPrefs || {}, storedPrefs || {})
      );
      if (boot.activityViewConfigured && bootPrefs) {
        writeJsonStorage(PREFS_STORAGE_KEY, prefs);
      }
      let localReadTimes = readJsonStorage(READ_TIMES_STORAGE_KEY, {});
      let manualUnreadMap = readJsonStorage(MANUAL_UNREAD_STORAGE_KEY, {});

      function pruneMapToMax(obj, maxEntries) {
        const keys = Object.keys(obj || {});
        if (keys.length <= maxEntries) return obj;
        keys.sort((a, b) => Number(obj[b] || 0) - Number(obj[a] || 0));
        const next = {};
        for (let i = 0; i < maxEntries; i++) {
          next[keys[i]] = obj[keys[i]];
        }
        return next;
      }

      function savePrefs(nextPrefs) {
        prefs = normalizeActivityPrefs(nextPrefs);
        writeJsonStorage(PREFS_STORAGE_KEY, prefs);
        if (typeof window.__agUpdateSettings === 'function') {
          try {
            window.__agUpdateSettings(
              JSON.stringify({ reqId: 'av-pref-' + Date.now(), patch: { activityView: prefs } })
            );
          } catch {}
        }
      }

      function markConversationRead(cid, modSec) {
        if (!cid) return;
        const nowSec = Math.floor(Date.now() / 1000);
        localReadTimes[cid] = Math.max(nowSec, Math.ceil(Number(modSec || 0)) + 1);
        localReadTimes = pruneMapToMax(localReadTimes, 200);
        writeJsonStorage(READ_TIMES_STORAGE_KEY, localReadTimes);
        if (Object.prototype.hasOwnProperty.call(manualUnreadMap, cid)) {
          delete manualUnreadMap[cid];
          writeJsonStorage(MANUAL_UNREAD_STORAGE_KEY, manualUnreadMap);
        }
      }

      function toggleManualUnread(cid, currentlyUnread, modSec) {
        if (!cid) return;
        if (currentlyUnread) {
          markConversationRead(cid, modSec);
        } else {
          manualUnreadMap[cid] = Date.now();
          manualUnreadMap = pruneMapToMax(manualUnreadMap, 120);
          writeJsonStorage(MANUAL_UNREAD_STORAGE_KEY, manualUnreadMap);
          clearedReadIds.delete(cid);
          heldPriorityIds.add(cid);
        }
        lastRenderSig = '';
        scheduleRender();
      }

      function getStrings() {
        if (isZhUi()) {
          return {
            activityView: '活动视图',
            turnOffActivityView: '关闭活动视图',
            priority: '优先',
            pinned: '已置顶',
            optionsLabel: '活动视图选项',
            showSection: '显示',
            restoreDefaults: '恢复默认',
            showPriority: '优先分组',
            unreadOnly: '仅显示未读',
            showPinned: '已置顶',
            showScheduled: '定时任务',
            markAllRead: '全部标为已读',
            clearReadChats: '清除已读对话',
            emptyPriority: '暂无需要关注的对话',
            emptyAll: '暂无符合条件的对话',
            showMore: '显示更多',
            markAsRead: '标为已读',
            markAsUnread: '标为未读',
            workingTip: '运行中',
            taskRunningTip: '后台任务运行中',
            waitingTip: '等待处理',
            errorTip: '执行失败',
            unreadTipLabel: '已完成 · 未读',
            untitled: '未命名对话'
          };
        }
        return {
          activityView: 'Activity view',
          turnOffActivityView: 'Turn off activity view',
          priority: 'Priority',
          pinned: 'Pinned',
          optionsLabel: 'Activity view options',
          showSection: 'Show',
          restoreDefaults: 'Restore defaults',
          showPriority: 'Priority section',
          unreadOnly: 'Unread only',
          showPinned: 'Pinned',
          showScheduled: 'Scheduled',
          markAllRead: 'Mark all as read',
          clearReadChats: 'Clear read chats',
          emptyPriority: 'Nothing needs attention',
          emptyAll: 'No matching chats',
          showMore: 'Show more',
          markAsRead: 'Mark as read',
          markAsUnread: 'Mark as unread',
          workingTip: 'Working',
          taskRunningTip: 'Background task running',
          waitingTip: 'Needs attention',
          errorTip: 'Task failed',
          unreadTipLabel: 'Unread',
          untitled: 'Untitled chat'
        };
      }

      /* ---------------- React / Redux / Router discovery ---------------- */
      function walkFibersForContext() {
        const anchors = [
          document.querySelector('[data-testid="conversation-list-sidebar"]'),
          document.querySelector('[data-testid="conversation-row-sidebar"]'),
          document.querySelector('[data-testid="sidebar-search-button"]'),
          document.body
        ];
        for (let a = 0; a < anchors.length; a++) {
          const el = anchors[a];
          if (!el) continue;
          let fk = '';
          try {
            fk = Object.keys(el).find(
              (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
            );
          } catch {}
          if (!fk || !el[fk]) continue;
          let f = el[fk];
          for (let i = 0; i < 240 && f; i++, f = f.return) {
            const v = f.memoizedProps && f.memoizedProps.value;
            if (!v || typeof v !== 'object') continue;
            if (!cachedStore && v.store && typeof v.store.getState === 'function') {
              cachedStore = v.store;
            }
            if (!cachedRouter && typeof v.navigate === 'function' && v.routesByPath) {
              cachedRouter = v;
            }
            if (!cachedPms && v.core && v.core.projectManagementService) {
              cachedPms = v.core.projectManagementService;
            }
            if (cachedStore && cachedRouter && cachedPms) return;
          }
        }
      }

      function ensureStoreSubscription() {
        if (!cachedStore || !cachedRouter) walkFibersForContext();
        if (cachedStore && !storeUnsub && typeof cachedStore.subscribe === 'function') {
          try {
            storeUnsub = cachedStore.subscribe(() => {
              if (!disposed) scheduleRender();
            });
          } catch {}
        }
      }

      function getCurrentSelectedCascadeId(st) {
        const convoCid = st && st.conversation && st.conversation.convoState && st.conversation.convoState.cascadeId;
        if (typeof convoCid === 'string' && /^[0-9a-f-]{36}$/i.test(convoCid)) {
          return convoCid;
        }
        try {
          const m = String(window.location && window.location.pathname || '').match(/\/c\/([0-9a-f-]{36})/i);
          if (m && m[1]) return m[1];
        } catch {}
        try {
          const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
          if (sel) {
            const cid = sel.getAttribute('data-cascade-id');
            if (cid) return cid;
          }
        } catch {}
        return '';
      }

      function buildProjectNameMap(st) {
        const map = {};
        const sp = st && st.sidebarProjects && Array.isArray(st.sidebarProjects.projects)
          ? st.sidebarProjects.projects
          : [];
        for (let i = 0; i < sp.length; i++) {
          if (sp[i] && sp[i].id && sp[i].name) {
            map[sp[i].id] = sp[i].name;
          }
        }
        if (cachedPms && cachedPms.projectsStateProvider && typeof cachedPms.projectsStateProvider.getState === 'function') {
          try {
            const raw = cachedPms.projectsStateProvider.getState();
            if (Array.isArray(raw)) {
              for (let i = 0; i < raw.length; i++) {
                const proj = raw[i] && raw[i].project;
                if (proj && proj.id && proj.name && !map[proj.id]) {
                  map[proj.id] = proj.name;
                }
              }
            }
          } catch {}
        }
        return map;
      }

      function collectConversations() {
        ensureStoreSubscription();
        const isZh = isZhUi();
        const strings = getStrings();
        if (cachedStore && typeof cachedStore.getState === 'function') {
          try {
            const st = cachedStore.getState() || {};
            const ts = st.trajectorySummaries || {};
            const summaries = ts.summaries || {};
            const idx = ts.indexes || {};
            const topLevelKeys =
              idx.topLevel && typeof idx.topLevel === 'object'
                ? Object.keys(idx.topLevel)
                : Object.keys(summaries);
            const activeMap = idx.active || {};
            const pinnedMap = idx.pinned || {};
            const archivedMap = idx.archived || {};
            const serverUnreadMap = idx.serverUnread || {};
            const waitingMap = idx.hasWaitingSteps || {};
            const localViews = (st.conversation && st.conversation.localLastViewedTimes) || {};
            const selectedCid = getCurrentSelectedCascadeId(st);
            const projectNameMap = buildProjectNameMap(st);

            const list = [];
            let readTimesDirty = false;
            let manualUnreadDirty = false;
            for (let i = 0; i < topLevelKeys.length; i++) {
              const id = topLevelKeys[i];
              const s = summaries[id];
              if (!s || typeof s !== 'object') continue;
              const curSrvUnread = Boolean(serverUnreadMap[id]);
              if (prevServerUnread.has(id)) {
                const wasSrvUnread = prevServerUnread.get(id);
                if (!wasSrvUnread && curSrvUnread && Object.prototype.hasOwnProperty.call(localReadTimes, id)) {
                  // User explicitly triggered native "Mark Unread" -> clear local read suppression
                  delete localReadTimes[id];
                  readTimesDirty = true;
                } else if (wasSrvUnread && !curSrvUnread && Object.prototype.hasOwnProperty.call(manualUnreadMap, id)) {
                  // User explicitly triggered native "Mark Read" -> clear local manual unread
                  delete manualUnreadMap[id];
                  manualUnreadDirty = true;
                }
              }
              prevServerUnread.set(id, curSrvUnread);
              const modMs = parseActivityTimestampMs(s.lastModifiedTime) || parseActivityTimestampMs(s.createdTime);
              const modSec = modMs / 1000;
              const serverViewSec = parseActivityTimestampMs(s.annotations && s.annotations.lastUserViewTime) / 1000;
              const appLocalViewSec = parseActivityTimestampMs(localViews[id]) / 1000;
              const pluginReadSec = Number(localReadTimes[id] || 0);
              const effectiveViewSec = Math.max(serverViewSec, appLocalViewSec, pluginReadSec);
              const isSelected = id === selectedCid;
              const manualUnread = Boolean(manualUnreadMap[id]);
              const locallyMarkedRead =
                pluginReadSec > 0 && (modSec <= 0 || pluginReadSec >= modSec + 0.5);
              const serverUnreadActive = curSrvUnread && !locallyMarkedRead;
              const timestampUnread = modSec > 0 && effectiveViewSec > 0 && modSec > effectiveViewSec + 1;
              const computedUnread =
                manualUnread || (!isSelected && (serverUnreadActive || timestampUnread));

              const backgroundTaskCount = Number(s.backgroundTaskCount || 0);
              const isAgentRunning = Boolean(
                Number(s.status) === 2 || s.hasActiveChildren || s.hasRunningSubagents
              );
              const isActive = Boolean(
                isAgentRunning ||
                  s.notFullyIdle ||
                  s.hasActivity ||
                  backgroundTaskCount > 0 ||
                  activeMap[id]
              );
              const activeKind = isActive
                ? !isAgentRunning && backgroundTaskCount > 0
                  ? 'task'
                  : 'working'
                : '';
              const waitingCount = Array.isArray(s.waitingSteps) ? s.waitingSteps.length : 0;
              const openCardCount = Number(s.openCardCount || 0);
              const previewRec = previewCache.get(id) || null;
              const hasError = Boolean(s.interrupted || (previewRec && previewRec.hasError));
              const isPinned = Boolean(pinnedMap[id] || (s.annotations && s.annotations.pinned));
              const isArchived = Boolean(archivedMap[id]);
              const isScheduled = Boolean(
                Number(s.source) === 2 ||
                  (s.annotations && Array.isArray(s.annotations.tags) && s.annotations.tags.includes('scheduled'))
              );
              const rawTitle = String((s.annotations && s.annotations.title) || s.summary || '').trim();
              const workspaceLabel = extractActivityWorkspaceLabel(s, projectNameMap, isZh);

              list.push({
                id,
                title: rawTitle || strings.untitled,
                workspaceLabel,
                previewText: previewRec ? previewRec.text : '',
                hasWaiting: Boolean(waitingMap[id] || waitingCount > 0 || openCardCount > 0),
                waitingCount,
                openCardCount,
                hasError,
                interrupted: Boolean(s.interrupted),
                isUnread: computedUnread,
                isActive,
                activeKind,
                backgroundTaskCount,
                isPinned,
                isArchived,
                isScheduled,
                isSelected,
                recencyMs: modMs,
                modSec
              });
            }
            if (readTimesDirty) writeJsonStorage(READ_TIMES_STORAGE_KEY, localReadTimes);
            if (manualUnreadDirty) writeJsonStorage(MANUAL_UNREAD_STORAGE_KEY, manualUnreadMap);
            return { items: list, selectedCid };
          } catch {}
        }

        // Fallback: scrape visible native sidebar rows if Redux store isn't ready yet
        const rows = document.querySelectorAll ? document.querySelectorAll('[data-testid="conversation-row-sidebar"]') : [];
        const fallbackList = [];
        let selectedCid = '';
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const cid = row.getAttribute('data-cascade-id') || '';
          if (!cid) continue;
          const sel = row.getAttribute('data-selected') === 'true';
          if (sel) selectedCid = cid;
          const pinned = row.getAttribute('data-pinned') === 'true';
          const titleEl = row.querySelector('span.truncate, a[aria-label]');
          const title = String(
            (titleEl && (titleEl.getAttribute('aria-label') || titleEl.textContent)) || row.textContent || ''
          )
            .trim()
            .split('\n')[0]
            .trim();
          const previewRec = previewCache.get(cid) || null;
          fallbackList.push({
            id: cid,
            title: title || strings.untitled,
            workspaceLabel: isZh ? '项目外' : 'Outside of Project',
            previewText: previewRec ? previewRec.text : '',
            hasWaiting: false,
            waitingCount: 0,
            openCardCount: 0,
            hasError: Boolean(previewRec && previewRec.hasError),
            interrupted: false,
            isUnread: Boolean(manualUnreadMap[cid]),
            isActive: false,
            isPinned: pinned,
            isArchived: false,
            isScheduled: false,
            isSelected: sel,
            recencyMs: Date.now() - i * 60000,
            modSec: Math.floor((Date.now() - i * 60000) / 1000)
          });
        }
        return { items: fallbackList, selectedCid };
      }

      /* ---------------- Daemon SQLite Preview Bridge ---------------- */
      const onActivityPreviews = (reqId, payload) => {
        if (disposed) return;
        const cb = pendingPreviewReqs.get(reqId);
        if (cb) {
          pendingPreviewReqs.delete(reqId);
          cb(payload);
        }
      };
      window.__ag_on_activity_previews = onActivityPreviews;

      function requestDaemonPreviews(cascadeItems, force) {
        if (disposed || typeof window.__agRequestActivityPreviews !== 'function') return;
        const toFetch = [];
        const modSecByCid = new Map();
        for (let i = 0; i < cascadeItems.length; i++) {
          const entry = cascadeItems[i];
          const cid = typeof entry === 'string' ? entry : entry && entry.id;
          const modSec = typeof entry === 'object' && entry ? Number(entry.modSec || 0) : 0;
          if (!cid || previewInFlight.has(cid)) continue;
          const prev = previewCache.get(cid);
          const staleByMod = Boolean(prev && modSec > 0 && modSec > (prev.modSec || 0) + 0.5);
          if (!force && prev && !staleByMod) continue;
          toFetch.push(cid);
          modSecByCid.set(cid, modSec);
          if (toFetch.length >= 36) break;
        }
        if (toFetch.length === 0) return;

        previewReqSeq += 1;
        const reqId = `av-prev-${Date.now()}-${previewReqSeq}`;
        for (let i = 0; i < toFetch.length; i++) previewInFlight.add(toFetch[i]);

        const timer = setTimeout(() => {
          pendingPreviewReqs.delete(reqId);
          for (let i = 0; i < toFetch.length; i++) previewInFlight.delete(toFetch[i]);
        }, 6000);

        pendingPreviewReqs.set(reqId, (payload) => {
          clearTimeout(timer);
          for (let i = 0; i < toFetch.length; i++) previewInFlight.delete(toFetch[i]);
          if (disposed || !payload || !payload.previews) return;
          let changed = false;
          const entries = Object.entries(payload.previews);
          for (let i = 0; i < entries.length; i++) {
            const [cid, data] = entries[i];
            const prev = previewCache.get(cid);
            const nextText = typeof data?.text === 'string' ? data.text : '';
            const nextErr = Boolean(data?.hasError);
            const nextSig = String(data?.sig || '');
            const nextModSec = Math.max(Number(modSecByCid.get(cid) || 0), Number(prev?.modSec || 0));
            if (!prev || prev.text !== nextText || prev.hasError !== nextErr || prev.sig !== nextSig) {
              previewCache.set(cid, { text: nextText, hasError: nextErr, sig: nextSig, modSec: nextModSec });
              changed = true;
            } else if (nextModSec > (prev.modSec || 0)) {
              previewCache.set(cid, { text: prev.text, hasError: prev.hasError, sig: prev.sig, modSec: nextModSec });
            }
          }
          if (changed) {
            lastRenderSig = '';
            scheduleRender();
          }
        });

        try {
          window.__agRequestActivityPreviews(JSON.stringify({ reqId, cascadeIds: toFetch }));
        } catch {
          clearTimeout(timer);
          pendingPreviewReqs.delete(reqId);
          for (let i = 0; i < toFetch.length; i++) previewInFlight.delete(toFetch[i]);
        }
      }

      /* ---------------- Navigation ---------------- */
      function navigateToConversation(cid, modSec) {
        if (disposed || !cid) return;
        markConversationRead(cid, modSec);
        ensureStoreSubscription();

        // 1. Prefer Antigravity's TanStack Router SPA navigation
        if (cachedRouter && typeof cachedRouter.navigate === 'function') {
          try {
            cachedRouter.navigate({ to: '/c/$cascadeId', params: { cascadeId: cid } });
            lastRenderSig = '';
            scheduleRender();
            return;
          } catch {}
        }

        // 2. Fallback: click native sidebar row link if present in DOM
        try {
          const nativeLink = document.querySelector(
            `[data-testid="conversation-row-sidebar"][data-cascade-id="${cid}"] a[href]`
          );
          if (nativeLink && typeof nativeLink.click === 'function') {
            nativeLink.click();
            lastRenderSig = '';
            scheduleRender();
            return;
          }
        } catch {}

        // 3. Final fallback: History API pushState
        try {
          if (window.history && typeof window.history.pushState === 'function') {
            window.history.pushState({}, '', '/c/' + cid);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }
        } catch {}
        lastRenderSig = '';
        scheduleRender();
      }

      /* ---------------- Native Context Menu Delegation ---------------- */
      function clearRenameWatch() {
        if (typeof renameWatchCleanup === 'function') {
          try {
            renameWatchCleanup();
          } catch {}
          renameWatchCleanup = null;
        }
      }

      function watchNativeRenameForRow(nativeRow) {
        clearRenameWatch();
        if (disposed || !nativeRow || typeof MutationObserver !== 'function') return;
        let inRenameMode = false;
        let restoreActivityAfterRename = false;
        let idleExpireTimer = null;

        const stop = () => {
          if (idleExpireTimer) {
            clearTimeout(idleExpireTimer);
            idleExpireTimer = null;
          }
          try {
            rowMo.disconnect();
          } catch {}
          if (renameWatchCleanup === stop) renameWatchCleanup = null;
        };

        const checkRenameInput = () => {
          if (disposed) {
            stop();
            return;
          }
          const inp = nativeRow.querySelector ? nativeRow.querySelector('input') : null;
          if (inp && !inRenameMode) {
            inRenameMode = true;
            if (idleExpireTimer) {
              clearTimeout(idleExpireTimer);
              idleExpireTimer = null;
            }
            restoreActivityAfterRename = isOpen;
            if (isOpen) {
              // Temporarily reveal native sidebar so Antigravity's inline rename input is visible and editable
              setActivityOpen(false);
            }
            const focusRename = () => {
              if (disposed) return;
              try {
                if (typeof nativeRow.scrollIntoView === 'function') {
                  nativeRow.scrollIntoView({ block: 'nearest' });
                }
                if (typeof inp.focus === 'function') inp.focus();
                if (typeof inp.select === 'function') inp.select();
              } catch {}
            };
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(focusRename);
            } else {
              focusRename();
            }
          } else if (!inp && inRenameMode) {
            inRenameMode = false;
            const shouldRestore = restoreActivityAfterRename;
            restoreActivityAfterRename = false;
            stop();
            if (shouldRestore && !disposed && !isOpen) {
              setActivityOpen(true);
            }
          }
        };

        const rowMo = new MutationObserver(checkRenameInput);
        try {
          rowMo.observe(nativeRow, { childList: true, subtree: true });
        } catch {
          return;
        }
        // Expire observer if user dismissed context menu without clicking Rename
        idleExpireTimer = setTimeout(() => {
          if (!inRenameMode) stop();
        }, 20000);
        renameWatchCleanup = stop;
      }

      function findNativeConversationRow(cid) {
        if (!cid || typeof document === 'undefined' || !document.querySelectorAll) return null;
        try {
          const direct = document.querySelector(
            `[data-testid="conversation-row-sidebar"][data-cascade-id="${cid}"]`
          );
          if (direct) return direct;
        } catch {}
        try {
          const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute && rows[i].getAttribute('data-cascade-id') === cid) {
              return rows[i];
            }
          }
        } catch {}
        return null;
      }

      function openFallbackCardContextMenu(card, ev) {
        const cid = card.getAttribute('data-cascade-id');
        if (!cid) return;
        const modSec = Number(card.getAttribute('data-mod-sec') || 0);
        const isUnr = card.getAttribute('data-unread') === 'true';
        const isActiveCard = card.getAttribute('data-attention') === 'active';
        const titleEl = card.querySelector ? card.querySelector('.ag-av-title') : null;
        const titleText = String((titleEl && titleEl.textContent) || '').trim();
        const s = getStrings();
        const menu = ensureOptionsMenu();
        if (!menu) return;
        hideTooltip();
        optionsOpen = true;
        menu.innerHTML =
          '<button type="button" class="ag-av-menu-item" role="menuitem" data-av-act="ctx-open" data-av-cid="' +
          escHtml(cid) +
          '" data-av-mod-sec="' +
          Math.floor(modSec) +
          '"><span>' +
          escHtml(isZhUi() ? '打开对话' : 'Open') +
          '</span></button>' +
          (!isActiveCard
            ? '<button type="button" class="ag-av-menu-item" role="menuitem" data-av-act="ctx-toggle-unread" data-av-cid="' +
              escHtml(cid) +
              '" data-av-is-unread="' +
              (isUnr ? 'true' : 'false') +
              '" data-av-mod-sec="' +
              Math.floor(modSec) +
              '"><span>' +
              escHtml(isUnr ? s.markAsRead : s.markAsUnread) +
              '</span></button>'
            : '') +
          '<div class="ag-av-menu-sep" role="separator"></div>' +
          '<button type="button" class="ag-av-menu-item" role="menuitem" data-av-act="ctx-copy-title" data-av-copy="' +
          escHtml(titleText) +
          '"><span>' +
          escHtml(isZhUi() ? '复制对话名称' : 'Copy Conversation Name') +
          '</span></button>' +
          '<button type="button" class="ag-av-menu-item" role="menuitem" data-av-act="ctx-copy-id" data-av-copy="' +
          escHtml(cid) +
          '"><span>' +
          escHtml(isZhUi() ? '复制对话 ID' : 'Copy Conversation ID') +
          '</span></button>';
        menu.hidden = false;
        try {
          const mRect = menu.getBoundingClientRect();
          const vw = window.innerWidth || 1200;
          const vh = window.innerHeight || 800;
          const x = Math.max(8, Math.min(vw - (mRect.width || 180) - 8, Number(ev.clientX || 0)));
          const y = Math.max(8, Math.min(vh - (mRect.height || 140) - 8, Number(ev.clientY || 0)));
          menu.style.left = Math.round(x) + 'px';
          menu.style.top = Math.round(y) + 'px';
        } catch {}
      }

      function forwardCardContextMenu(card, ev) {
        if (disposed || !card) return false;
        const cid = card.getAttribute('data-cascade-id');
        if (!cid) return false;
        closeOptionsMenu();
        hideTooltip();
        const nativeRow = findNativeConversationRow(cid);
        if (nativeRow && typeof nativeRow.dispatchEvent === 'function') {
          ev.preventDefault();
          ev.stopPropagation();
          watchNativeRenameForRow(nativeRow);
          try {
            const Ctor = typeof MouseEvent === 'function' ? MouseEvent : Event;
            const forwarded = new Ctor('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: Number(ev.clientX || 0),
              clientY: Number(ev.clientY || 0),
              screenX: Number(ev.screenX || 0),
              screenY: Number(ev.screenY || 0),
              button: 2,
              buttons: 2,
              view: typeof window !== 'undefined' ? window : undefined
            });
            nativeRow.dispatchEvent(forwarded);
            return true;
          } catch {}
        }
        // Fallback for older conversations not currently mounted in native sidebar DOM
        ev.preventDefault();
        ev.stopPropagation();
        openFallbackCardContextMenu(card, ev);
        return false;
      }

      /* ---------------- SVG Icons ---------------- */
      const SVG_FILTER =
        '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M3.25 5.5H16.75M5.75 10H14.25M8.25 14.5H11.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
        '</svg>';

      const SVG_SLIDERS =
        '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M3.5 6.25H7.5M11.5 6.25H16.5M3.5 13.75H10.5M14.5 13.75H16.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '<circle cx="9.5" cy="6.25" r="2" stroke="currentColor" stroke-width="1.6"/>' +
        '<circle cx="12.5" cy="13.75" r="2" stroke="currentColor" stroke-width="1.6"/>' +
        '</svg>';

      // Authentic Codex Desktop eraser-badge icon (Clear read chats)
      const SVG_ERASER_BADGE =
        '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M11.2 4.1L15.9 8.8C16.7 9.6 16.7 10.9 15.9 11.7L11.8 15.8H6.4L4.1 13.5C3.3 12.7 3.3 11.4 4.1 10.6L8.3 4.1C9.1 3.3 10.4 3.3 11.2 4.1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="M7.2 8.2L11.8 12.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '<circle cx="15.4" cy="15.2" r="2.7" fill="#3B82F6"/>' +
        '</svg>';

      const SVG_FOLDER =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.15C6.55 3 6.93 3.16 7.21 3.44L8.15 4.38C8.34 4.56 8.59 4.67 8.85 4.67H12.5C13.33 4.67 14 5.34 14 6.17V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>' +
        '</svg>';

      const SVG_CHECK =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 5"/></svg>';

      const SVG_RESET =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8A5.5 5.5 0 1 1 4.1 11.9"/><path d="M2.5 4.5V8H6"/></svg>';

      const SVG_MARK_UNREAD =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/></svg>';

      const SVG_MARK_READ =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3.4" stroke="currentColor" stroke-width="1.5"/></svg>';

      // Authentic Codex Desktop working spinner (FyDI / RNul — neutral gray rotating arc, never blue)
      const SVG_WORKING_SPINNER =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path opacity="0.28" d="M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z" fill="currentColor"/>' +
        '<path d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z" fill="currentColor"/>' +
        '</svg>';

      // Antigravity-native background task running terminal icon (>_ with gently blinking caret)
      const SVG_TASK_RUNNING =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3.7 5.2L6.7 8L3.7 10.8"/>' +
        '<path class="ag-av-task-caret" d="M8.3 10.8H12.3"/>' +
        '</svg>';

      /* ---------------- Tooltip ---------------- */
      function ensureTooltipEl() {
        let tt = document.getElementById('ag-activity-tooltip');
        if (!tt && document.body) {
          tt = document.createElement('div');
          tt.id = 'ag-activity-tooltip';
          tt.setAttribute('role', 'tooltip');
          document.body.appendChild(tt);
        }
        return tt;
      }

      function showTooltip(anchorEl, labelText, kbdText) {
        if (!anchorEl) return;
        if (tooltipHideTimer) {
          clearTimeout(tooltipHideTimer);
          tooltipHideTimer = null;
        }
        const tt = ensureTooltipEl();
        if (!tt) return;
        tt.innerHTML =
          '<span>' +
          escHtml(labelText) +
          '</span>' +
          (kbdText ? '<span class="ag-av-kbd">' + escHtml(kbdText) + '</span>' : '');
        tt.setAttribute('data-open', 'true');
        try {
          const rect = anchorEl.getBoundingClientRect();
          const ttRect = tt.getBoundingClientRect();
          const vw = window.innerWidth || 1200;
          const left = Math.max(8, Math.min(vw - ttRect.width - 8, rect.left + rect.width / 2 - ttRect.width / 2));
          const top = rect.bottom + 8;
          tt.style.left = Math.round(left) + 'px';
          tt.style.top = Math.round(top) + 'px';
        } catch {}
      }

      function hideTooltip() {
        const tt = document.getElementById('ag-activity-tooltip');
        if (tt) tt.removeAttribute('data-open');
      }

      /* ---------------- Options Popover Menu ---------------- */
      function closeOptionsMenu() {
        optionsOpen = false;
        const menu = document.getElementById('ag-activity-options-menu');
        if (menu) menu.hidden = true;
        const btn = document.getElementById('ag-activity-options-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }

      function ensureOptionsMenu() {
        let menu = document.getElementById('ag-activity-options-menu');
        if (!menu && document.body) {
          menu = document.createElement('div');
          menu.id = 'ag-activity-options-menu';
          menu.setAttribute('role', 'menu');
          menu.hidden = true;
          menu.addEventListener('click', (ev) => {
            const target = ev.target && ev.target.closest ? ev.target.closest('button[data-av-act]') : null;
            if (!target || target.disabled) return;
            ev.preventDefault();
            ev.stopPropagation();
            const act = target.getAttribute('data-av-act');
            if (act === 'toggle-showPriority') {
              savePrefs(Object.assign({}, prefs, { showPriority: !prefs.showPriority }));
            } else if (act === 'toggle-unreadOnly') {
              savePrefs(Object.assign({}, prefs, { unreadOnly: !prefs.unreadOnly }));
            } else if (act === 'toggle-showPinned') {
              savePrefs(Object.assign({}, prefs, { showPinned: !prefs.showPinned }));
            } else if (act === 'toggle-showScheduled') {
              savePrefs(Object.assign({}, prefs, { showScheduled: !prefs.showScheduled }));
            } else if (act === 'restore-defaults') {
              savePrefs(AG_ACTIVITY_DEFAULT_PREFS);
              clearReadChatsInPriority();
            } else if (act === 'mark-all-read') {
              markAllPriorityRead();
              closeOptionsMenu();
            } else if (act === 'ctx-open') {
              const cid = target.getAttribute('data-av-cid');
              const modSec = Number(target.getAttribute('data-av-mod-sec') || 0);
              closeOptionsMenu();
              navigateToConversation(cid, modSec);
              return;
            } else if (act === 'ctx-toggle-unread') {
              const cid = target.getAttribute('data-av-cid');
              const isUnr = target.getAttribute('data-av-is-unread') === 'true';
              const modSec = Number(target.getAttribute('data-av-mod-sec') || 0);
              closeOptionsMenu();
              toggleManualUnread(cid, isUnr, modSec);
              return;
            } else if (act === 'ctx-copy-title' || act === 'ctx-copy-id') {
              const val = target.getAttribute('data-av-copy') || '';
              closeOptionsMenu();
              try {
                if (val && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                  void navigator.clipboard.writeText(val).catch(() => {});
                }
              } catch {}
              return;
            }
            lastRenderSig = '';
            renderNow();
            if (optionsOpen) renderOptionsMenuContent();
          });
          document.body.appendChild(menu);
        }
        return menu;
      }

      let lastGroupedState = null;

      function renderOptionsMenuContent() {
        const menu = ensureOptionsMenu();
        if (!menu) return;
        const s = getStrings();
        const showReset = !isDefaultActivityPrefs(prefs);
        const unreadCnt = lastGroupedState ? lastGroupedState.eligibleUnreadCount : 0;

        const mkCheckRow = (act, label, checked) =>
          '<button type="button" class="ag-av-menu-item" role="menuitemcheckbox" aria-checked="' +
          (checked ? 'true' : 'false') +
          '" data-av-act="' +
          act +
          '">' +
          '<span>' +
          escHtml(label) +
          '</span>' +
          '<span class="ag-av-menu-check">' +
          (checked ? SVG_CHECK : '') +
          '</span>' +
          '</button>';

        menu.innerHTML =
          '<div class="ag-av-menu-head">' +
          '<span>' +
          escHtml(s.showSection) +
          '</span>' +
          (showReset
            ? '<button type="button" class="ag-av-menu-reset" data-av-act="restore-defaults" title="' +
              escHtml(s.restoreDefaults) +
              '" aria-label="' +
              escHtml(s.restoreDefaults) +
              '">' +
              SVG_RESET +
              '</button>'
            : '') +
          '</div>' +
          mkCheckRow('toggle-showPriority', s.showPriority, prefs.showPriority) +
          mkCheckRow('toggle-unreadOnly', s.unreadOnly, prefs.unreadOnly) +
          mkCheckRow('toggle-showPinned', s.showPinned, prefs.showPinned) +
          mkCheckRow('toggle-showScheduled', s.showScheduled, prefs.showScheduled) +
          '<div class="ag-av-menu-sep" role="separator"></div>' +
          '<button type="button" class="ag-av-menu-item" role="menuitem" data-av-act="mark-all-read"' +
          (unreadCnt === 0 ? ' disabled' : '') +
          '>' +
          '<span>' +
          escHtml(s.markAllRead) +
          '</span>' +
          '</button>';
      }

      function toggleOptionsMenu(anchorBtn) {
        if (!anchorBtn) return;
        const menu = ensureOptionsMenu();
        if (!menu) return;
        if (optionsOpen && !menu.hidden) {
          closeOptionsMenu();
          return;
        }
        hideTooltip();
        optionsOpen = true;
        renderOptionsMenuContent();
        menu.hidden = false;
        anchorBtn.setAttribute('aria-expanded', 'true');
        try {
          const rect = anchorBtn.getBoundingClientRect();
          const mRect = menu.getBoundingClientRect();
          const vw = window.innerWidth || 1200;
          const vh = window.innerHeight || 800;
          let left = rect.right - mRect.width;
          if (left < 8) left = rect.left;
          left = Math.max(8, Math.min(vw - mRect.width - 8, left));
          let top = rect.bottom + 6;
          if (top + mRect.height > vh - 8) {
            top = Math.max(8, rect.top - mRect.height - 6);
          }
          menu.style.left = Math.round(left) + 'px';
          menu.style.top = Math.round(top) + 'px';
        } catch {}
      }

      /* ---------------- Priority Session Actions ---------------- */
      function clearReadChatsInPriority() {
        if (disposed) return;
        const { items } = collectConversations();
        const nextHeld = new Set();
        for (let i = 0; i < items.length; i++) {
          const st = classifyConversationAttention(items[i]);
          if (st !== 'idle') {
            nextHeld.add(items[i].id);
          } else if (heldPriorityIds.has(items[i].id)) {
            clearedReadIds.add(items[i].id);
          }
        }
        heldPriorityIds = nextHeld;
        lastRenderSig = '';
        renderNow();
      }

      function markAllPriorityRead() {
        if (disposed) return;
        const { items } = collectConversations();
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it || !it.id || it.isArchived) continue;
          if (it.isScheduled && !prefs.showScheduled) continue;
          if (it.isUnread && !it.isActive) {
            markConversationRead(it.id, it.modSec);
            if (prefs.showPriority && !(prefs.showPinned && it.isPinned)) {
              heldPriorityIds.add(it.id);
              clearedReadIds.delete(it.id);
            }
          }
        }
        lastRenderSig = '';
        renderNow();
      }

      function isSidebarCollapsed() {
        try {
          const st = cachedStore && cachedStore.getState ? cachedStore.getState() : null;
          if (st && st.sideBar && typeof st.sideBar.isOpen === 'boolean') {
            return st.sideBar.isOpen === false;
          }
        } catch {}
        try {
          const listEl = document.querySelector('[data-testid="conversation-list-sidebar"]');
          if (listEl && typeof listEl.getBoundingClientRect === 'function') {
            const rect = listEl.getBoundingClientRect();
            if (rect && rect.width > 0 && rect.right <= 4) return true;
          }
        } catch {}
        return false;
      }

      function expandSidebarIfCollapsed() {
        if (!isSidebarCollapsed()) return false;
        try {
          const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]');
          if (toggleBtn && typeof toggleBtn.click === 'function') {
            toggleBtn.click();
            return true;
          }
        } catch {}
        return false;
      }

      function setActivityOpen(nextOpen) {
        if (disposed) return;
        const targetOpen = Boolean(nextOpen);
        if (targetOpen && isOpen && isSidebarCollapsed()) {
          expandSidebarIfCollapsed();
          lastRenderSig = '';
          lastToggleSig = '';
          renderNow();
          return;
        }
        if (targetOpen === isOpen) return;
        isOpen = targetOpen;
        window.__ag_activity_open = isOpen;
        closeOptionsMenu();
        hideTooltip();

        if (isOpen) {
          visibleLimit = PAGE_STEP;
          clearedReadIds = new Set();
          const { items } = collectConversations();
          heldPriorityIds = new Set();
          for (let i = 0; i < items.length; i++) {
            const st = classifyConversationAttention(items[i]);
            if (st !== 'idle') heldPriorityIds.add(items[i].id);
          }
          // If Antigravity's sidebar is currently collapsed, expand it so Activity View is visible
          expandSidebarIfCollapsed();
        } else {
          heldPriorityIds = new Set();
          clearedReadIds = new Set();
        }

        if (document.documentElement) {
          if (isOpen) {
            document.documentElement.setAttribute('data-ag-activity-open', 'true');
          } else {
            document.documentElement.removeAttribute('data-ag-activity-open');
          }
        }
        lastRenderSig = '';
        lastToggleSig = '';
        syncPollTimer();
        renderNow();
      }

      function toggleActivityView() {
        if (disposed) return;
        if (isOpen && isSidebarCollapsed()) {
          setActivityOpen(true);
          return;
        }
        setActivityOpen(!isOpen);
      }

      const onActivityPrefsSync = (nextPrefs) => {
        if (disposed || !nextPrefs || typeof nextPrefs !== 'object') return;
        prefs = normalizeActivityPrefs(nextPrefs);
        writeJsonStorage(PREFS_STORAGE_KEY, prefs);
        lastRenderSig = '';
        scheduleRender();
        if (optionsOpen) renderOptionsMenuContent();
      };
      const getActivityViewState = () => ({
        open: isOpen,
        prefs: Object.assign({}, prefs),
        visibleLimit,
        previewCount: previewCache.size
      });
      const ownedGlobals = {
        __ag_toggle_activity_view: toggleActivityView,
        __ag_set_activity_view_open: setActivityOpen,
        __ag_on_activity_previews: onActivityPreviews,
        __ag_on_activity_prefs_sync: onActivityPrefsSync,
        __ag_get_activity_view_state: getActivityViewState
      };
      window.__ag_toggle_activity_view = toggleActivityView;
      window.__ag_set_activity_view_open = setActivityOpen;
      window.__ag_on_activity_prefs_sync = onActivityPrefsSync;
      window.__ag_get_activity_view_state = getActivityViewState;

      /* ---------------- DOM Mounting (Self-Healing) ---------------- */
      function ensureToggleButton() {
        const searchBtn = document.querySelector('[data-testid="sidebar-search-button"]');
        const toggleSidebarBtn = document.querySelector('[data-testid="sidebar-toggle"]');
        const parent =
          (searchBtn && searchBtn.parentElement) ||
          (toggleSidebarBtn && toggleSidebarBtn.parentElement);
        if (!parent) return null;

        let btn = document.getElementById('ag-activity-toggle-btn');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.id = 'ag-activity-toggle-btn';
          btn.setAttribute('data-testid', 'ag-activity-toggle-button');
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggleActivityView();
          });
          btn.addEventListener('mouseenter', () => {
            const s = getStrings();
            showTooltip(btn, isOpen ? s.turnOffActivityView : s.activityView, shortcutBadgeText);
          });
          btn.addEventListener('mouseleave', hideTooltip);
          btn.addEventListener('focus', () => {
            const s = getStrings();
            showTooltip(btn, isOpen ? s.turnOffActivityView : s.activityView, shortcutBadgeText);
          });
          btn.addEventListener('blur', hideTooltip);
        }

        if (searchBtn && searchBtn.parentElement === parent) {
          if (btn.parentElement !== parent || btn.nextElementSibling !== searchBtn) {
            try {
              parent.insertBefore(btn, searchBtn);
            } catch {
              return null;
            }
          }
        } else if (btn.parentElement !== parent) {
          try {
            parent.appendChild(btn);
          } catch {
            return null;
          }
        }
        return btn;
      }

      function ensurePanelContainer() {
        const listEl = document.querySelector('[data-testid="conversation-list-sidebar"]');
        const parent = listEl && listEl.parentElement;
        if (!listEl || !parent) return null;

        let panel = document.getElementById('ag-activity-view');
        if (!panel) {
          panel = document.createElement('div');
          panel.id = 'ag-activity-view';
          panel.setAttribute('role', 'region');
          panel.setAttribute('aria-label', getStrings().activityView);
          panel.addEventListener('click', (ev) => {
            const optBtn = ev.target && ev.target.closest ? ev.target.closest('#ag-activity-options-btn') : null;
            if (optBtn) {
              ev.preventDefault();
              ev.stopPropagation();
              toggleOptionsMenu(optBtn);
              return;
            }
            const clearBtn = ev.target && ev.target.closest ? ev.target.closest('#ag-activity-clear-read-btn') : null;
            if (clearBtn) {
              ev.preventDefault();
              ev.stopPropagation();
              hideTooltip();
              clearReadChatsInPriority();
              return;
            }
            const moreBtn = ev.target && ev.target.closest ? ev.target.closest('.ag-av-more-btn') : null;
            if (moreBtn) {
              ev.preventDefault();
              ev.stopPropagation();
              visibleLimit += PAGE_STEP;
              lastRenderSig = '';
              renderNow();
              return;
            }
            const toggleUnreadBtn =
              ev.target && ev.target.closest ? ev.target.closest('[data-av-toggle-unread]') : null;
            if (toggleUnreadBtn) {
              ev.preventDefault();
              ev.stopPropagation();
              const cid = toggleUnreadBtn.getAttribute('data-av-toggle-unread');
              const isUnr = toggleUnreadBtn.getAttribute('data-av-is-unread') === 'true';
              const modSec = Number(toggleUnreadBtn.getAttribute('data-av-mod-sec') || 0);
              toggleManualUnread(cid, isUnr, modSec);
              return;
            }
            const card = ev.target && ev.target.closest ? ev.target.closest('.ag-av-card[data-cascade-id]') : null;
            if (card) {
              ev.preventDefault();
              ev.stopPropagation();
              const cid = card.getAttribute('data-cascade-id');
              const modSec = Number(card.getAttribute('data-mod-sec') || 0);
              navigateToConversation(cid, modSec);
            }
          });
          panel.addEventListener('contextmenu', (ev) => {
            const card = ev.target && ev.target.closest ? ev.target.closest('.ag-av-card[data-cascade-id]') : null;
            if (card) {
              forwardCardContextMenu(card, ev);
            }
          });
          panel.addEventListener('mouseover', (ev) => {
            const btn =
              ev.target && ev.target.closest
                ? ev.target.closest('#ag-activity-options-btn, #ag-activity-clear-read-btn')
                : null;
            if (btn) {
              const tip = btn.getAttribute('data-av-tip');
              if (tip) showTooltip(btn, tip, '');
            }
          });
          panel.addEventListener('mouseout', (ev) => {
            const btn =
              ev.target && ev.target.closest
                ? ev.target.closest('#ag-activity-options-btn, #ag-activity-clear-read-btn')
                : null;
            if (btn && !(ev.relatedTarget && typeof btn.contains === 'function' && btn.contains(ev.relatedTarget))) {
              hideTooltip();
            }
          });
        }
        if (panel.parentElement !== parent) {
          try {
            parent.appendChild(panel);
          } catch {
            return null;
          }
        }
        return panel;
      }

      /* ---------------- Render ---------------- */
      function renderNow() {
        if (disposed) return;
        const s = getStrings();
        const isZh = isZhUi();

        if (document.documentElement) {
          if (isOpen) {
            document.documentElement.setAttribute('data-ag-activity-open', 'true');
          } else {
            document.documentElement.removeAttribute('data-ag-activity-open');
          }
        }

        const { items } = collectConversations();

        // Merge newly arriving non-idle items into heldPriorityIds while open
        if (isOpen) {
          for (let i = 0; i < items.length; i++) {
            const st = classifyConversationAttention(items[i]);
            if (st !== 'idle') {
              heldPriorityIds.add(items[i].id);
              clearedReadIds.delete(items[i].id);
            }
          }
        }

        const grouped = groupActivitySections({
          items,
          heldPriorityIds,
          clearedReadIds,
          prefs,
          nowMs: Date.now(),
          visibleLimit
        });
        lastGroupedState = grouped;

        const toggleBtn = ensureToggleButton();
        if (toggleBtn) {
          const toggleSig = `${isOpen}|${grouped.hasAnyAttention}|${isZh}`;
          if (toggleSig !== lastToggleSig) {
            lastToggleSig = toggleSig;
            const label = isOpen ? s.turnOffActivityView : s.activityView;
            toggleBtn.setAttribute('aria-label', label);
            toggleBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
            toggleBtn.setAttribute('data-active', isOpen ? 'true' : 'false');
            toggleBtn.innerHTML =
              SVG_FILTER +
              (!isOpen && grouped.hasAnyAttention ? '<span class="ag-av-toggle-dot" aria-hidden="true"></span>' : '');
          }
        }

        const panel = ensurePanelContainer();
        if (!panel || !isOpen) return;

        // Request previews from daemon for currently visible cards (and immediately refresh if modSec advanced)
        if (grouped.visibleItems.length > 0) {
          requestDaemonPreviews(grouped.visibleItems, false);
        }

        const renderSig = JSON.stringify({
          isZh,
          prefs,
          optionsOpen,
          hasHeldRead: grouped.hasHeldReadInPriority,
          hasMore: grouped.hasMore,
          sections: grouped.sections.map((sec) => ({
            k: sec.kind,
            d: sec.dayStart,
            r: sec.relativeDay,
            items: sec.items.map((it) => [
              it.id,
              it.title,
              it.workspaceLabel,
              it.previewText,
              it.attentionState,
              it.activeKind || '',
              it.backgroundTaskCount || 0,
              it.isSelected,
              it.isUnread
            ])
          }))
        });

        if (renderSig === lastRenderSig) return;
        lastRenderSig = renderSig;

        const headerActionsHtml =
          '<div class="ag-av-hdr-actions">' +
          '<button type="button" id="ag-activity-options-btn" class="ag-av-icon-btn" aria-haspopup="menu" aria-expanded="' +
          (optionsOpen ? 'true' : 'false') +
          '" aria-label="' +
          escHtml(s.optionsLabel) +
          '" data-av-tip="' +
          escHtml(s.optionsLabel) +
          '" data-active="' +
          (prefs.unreadOnly ? 'true' : 'false') +
          '">' +
          SVG_SLIDERS +
          '</button>' +
          (grouped.hasHeldReadInPriority
            ? '<button type="button" id="ag-activity-clear-read-btn" class="ag-av-icon-btn" aria-label="' +
              escHtml(s.clearReadChats) +
              '" data-av-tip="' +
              escHtml(s.clearReadChats) +
              '">' +
              SVG_ERASER_BADGE +
              '</button>'
            : '') +
          '</div>';

        const renderIndicatorHtml = (it) => {
          if (it.attentionState === 'idle') return '';
          if (it.attentionState === 'active') {
            if (it.activeKind === 'task') {
              const cnt = Number(it.backgroundTaskCount || 0);
              const tip =
                cnt > 0
                  ? isZh
                    ? `${cnt} 个后台任务运行中`
                    : `${cnt} ${cnt === 1 ? 'task' : 'tasks'} running`
                  : s.taskRunningTip;
              return (
                '<span class="ag-av-indicator ag-av-indicator-task" data-state="active" data-active-kind="task" role="status" title="' +
                escHtml(tip) +
                '" aria-label="' +
                escHtml(tip) +
                '">' +
                SVG_TASK_RUNNING +
                '</span>'
              );
            }
            return (
              '<span class="ag-av-indicator ag-av-indicator-working" data-state="active" data-active-kind="working" role="status" title="' +
              escHtml(s.workingTip) +
              '" aria-label="' +
              escHtml(s.workingTip) +
              '">' +
              SVG_WORKING_SPINNER +
              '</span>'
            );
          }
          const dotTip =
            it.attentionState === 'waiting'
              ? s.waitingTip
              : it.attentionState === 'error'
              ? s.errorTip
              : s.unreadTipLabel;
          return (
            '<span class="ag-av-dot" data-state="' +
            escHtml(it.attentionState) +
            '" title="' +
            escHtml(dotTip) +
            '" aria-label="' +
            escHtml(dotTip) +
            '"></span>'
          );
        };

        const renderCardHtml = (it) => {
          const isCardUnread = it.attentionState === 'unread';
          const unreadTip = isCardUnread ? s.markAsRead : s.markAsUnread;
          const secondaryHtml = it.previewText
            ? '<div class="ag-av-preview">' + escHtml(it.previewText) + '</div>'
            : '<div class="ag-av-fallback">' +
              SVG_FOLDER +
              '<span class="ag-av-fallback-label">' +
              escHtml(it.workspaceLabel || (isZh ? '项目外' : 'Outside of Project')) +
              '</span></div>';

          return (
            '<div class="ag-av-card" role="listitem" tabindex="0" data-cascade-id="' +
            escHtml(it.id) +
            '" data-selected="' +
            (it.isSelected ? 'true' : 'false') +
            '" data-unread="' +
            (isCardUnread ? 'true' : 'false') +
            '" data-attention="' +
            escHtml(it.attentionState) +
            '" data-mod-sec="' +
            Math.floor(it.modSec || 0) +
            '">' +
            '<div class="ag-av-card-top">' +
            renderIndicatorHtml(it) +
            '<span class="ag-av-title">' +
            escHtml(it.title) +
            '</span>' +
            (it.workspaceLabel
              ? '<span class="ag-av-workspace">' + escHtml(it.workspaceLabel) + '</span>'
              : '') +
            (it.attentionState !== 'active'
              ? '<span class="ag-av-card-actions">' +
                '<button type="button" class="ag-av-card-action-btn" data-av-toggle-unread="' +
                escHtml(it.id) +
                '" data-av-is-unread="' +
                (isCardUnread ? 'true' : 'false') +
                '" data-av-mod-sec="' +
                Math.floor(it.modSec || 0) +
                '" title="' +
                escHtml(unreadTip) +
                '" aria-label="' +
                escHtml(unreadTip) +
                '">' +
                (isCardUnread ? SVG_MARK_READ : SVG_MARK_UNREAD) +
                '</button>' +
                '</span>'
              : '') +
            '</div>' +
            '<div class="ag-av-secondary">' +
            secondaryHtml +
            '</div>' +
            '</div>'
          );
        };

        let sectionsHtml = '';
        if (grouped.sections.length === 0) {
          sectionsHtml =
            '<div class="ag-av-section">' +
            '<div class="ag-av-section-hdr">' +
            '<span class="ag-av-section-title">' +
            escHtml(formatActivityDayLabel(startOfLocalDayMs(Date.now()), 'today', isZh)) +
            '</span>' +
            headerActionsHtml +
            '</div>' +
            '<div class="ag-av-empty">' +
            escHtml(s.emptyAll) +
            '</div>' +
            '</div>';
        } else {
          for (let i = 0; i < grouped.sections.length; i++) {
            const sec = grouped.sections[i];
            const title =
              sec.kind === 'priority'
                ? s.priority
                : sec.kind === 'pinned'
                ? s.pinned
                : formatActivityDayLabel(sec.dayStart, sec.relativeDay, isZh);
            const includeActions = i === 0;
            let bodyHtml = '';
            if (sec.kind === 'priority' && sec.items.length === 0) {
              bodyHtml = '<div class="ag-av-empty">' + escHtml(s.emptyPriority) + '</div>';
            } else {
              for (let j = 0; j < sec.items.length; j++) {
                bodyHtml += renderCardHtml(sec.items[j]);
              }
            }
            sectionsHtml +=
              '<div class="ag-av-section" data-section-kind="' +
              escHtml(sec.kind) +
              '">' +
              '<div class="ag-av-section-hdr">' +
              '<span class="ag-av-section-title">' +
              escHtml(title) +
              '</span>' +
              (includeActions ? headerActionsHtml : '') +
              '</div>' +
              bodyHtml +
              '</div>';
          }
        }

        const moreHtml = grouped.hasMore
          ? '<button type="button" class="ag-av-more-btn">' + escHtml(s.showMore) + '</button>'
          : '';

        const prevScroll = panel.scrollTop || 0;
        panel.innerHTML = '<div class="ag-av-list" role="list">' + sectionsHtml + moreHtml + '</div>';
        if (prevScroll > 0) panel.scrollTop = prevScroll;
      }

      function scheduleRender() {
        if (disposed || renderScheduled) return;
        renderScheduled = true;
        const run = () => {
          renderScheduled = false;
          if (!disposed) renderNow();
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(run);
        } else {
          setTimeout(run, 16);
        }
      }

      /* ---------------- Event Listeners ---------------- */
      function onKeyDown(ev) {
        if (disposed) return;
        if (isToggleActivityShortcut(ev, platformStr)) {
          ev.preventDefault();
          ev.stopPropagation();
          toggleActivityView();
          return;
        }
        if (ev.key === 'Escape' && optionsOpen) {
          ev.preventDefault();
          ev.stopPropagation();
          closeOptionsMenu();
          return;
        }
        if (isOpen && (ev.key === 'Enter' || ev.key === ' ')) {
          const card = ev.target && ev.target.closest ? ev.target.closest('.ag-av-card[data-cascade-id]') : null;
          if (card && !(ev.target && ev.target.closest && ev.target.closest('button'))) {
            ev.preventDefault();
            navigateToConversation(card.getAttribute('data-cascade-id'), Number(card.getAttribute('data-mod-sec') || 0));
          }
        }
      }

      function onDocMouseDown(ev) {
        if (!optionsOpen) return;
        const target = ev.target;
        if (
          target &&
          target.closest &&
          (target.closest('#ag-activity-options-menu') || target.closest('#ag-activity-options-btn'))
        ) {
          return;
        }
        closeOptionsMenu();
      }

      function onWindowResize() {
        if (optionsOpen) closeOptionsMenu();
        hideTooltip();
      }

      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('mousedown', onDocMouseDown, true);
      window.addEventListener('resize', onWindowResize, { passive: true });

      let observedRoot = null;

      function findSidebarObserverRoot() {
        try {
          const searchBtn = document.querySelector('[data-testid="sidebar-search-button"]');
          const listEl = document.querySelector('[data-testid="conversation-list-sidebar"]');
          const anchor = searchBtn || listEl;
          if (anchor && typeof anchor.closest === 'function') {
            const root = anchor.closest('aside, .bg-sidebar');
            if (root) return root;
          }
          if (searchBtn && searchBtn.parentElement && listEl && listEl.parentElement) {
            let p = searchBtn.parentElement;
            while (p && p !== document.body && p !== document.documentElement) {
              if (typeof p.contains === 'function' && p.contains(listEl)) return p;
              p = p.parentElement;
            }
          }
        } catch {}
        return null;
      }

      const mo =
        typeof MutationObserver === 'function'
          ? new MutationObserver((records) => {
              if (disposed) return;
              // Re-scope from document.body to sidebar container as soon as sidebar mounts
              if (observedRoot === document.body) {
                const sbRoot = findSidebarObserverRoot();
                if (sbRoot) {
                  ensureObserverTarget();
                } else {
                  if (!document.querySelector('[data-testid="sidebar-search-button"]') && !document.querySelector('[data-testid="conversation-list-sidebar"]')) {
                    return;
                  }
                }
              } else {
                // Zero-cost fast path while Activity View is closed: only react if toggle button vanished or store not yet bound
                if (!isOpen && document.getElementById('ag-activity-toggle-btn') && cachedStore) {
                  return;
                }
                // Ignore mutations generated by our own Activity View renders
                if (isOpen && Array.isArray(records) && records.length > 0) {
                  const av = document.getElementById('ag-activity-view');
                  if (av && typeof av.contains === 'function') {
                    let hasExternal = false;
                    for (let i = 0; i < records.length; i++) {
                      const t = records[i] && records[i].target;
                      if (!t || (t !== av && !av.contains(t))) {
                        hasExternal = true;
                        break;
                      }
                    }
                    if (!hasExternal) return;
                  }
                }
              }
              if (obsTimer) return;
              obsTimer = setTimeout(() => {
                obsTimer = null;
                if (!disposed) scheduleRender();
              }, 150);
            })
          : null;

      function ensureObserverTarget() {
        if (!mo || disposed) return;
        const targetRoot = findSidebarObserverRoot() || document.body;
        if (!targetRoot || targetRoot === observedRoot) return;
        try {
          if (observedRoot) mo.disconnect();
          mo.observe(targetRoot, { childList: true, subtree: true });
          observedRoot = targetRoot;
        } catch {}
      }

      function syncPollTimer() {
        if (disposed || !isOpen) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }
        if (!pollTimer) {
          pollTimer = setInterval(() => {
            if (disposed || document.hidden || !isOpen) return;
            if (lastGroupedState && lastGroupedState.visibleItems.length > 0) {
              requestDaemonPreviews(lastGroupedState.visibleItems, true);
            }
            scheduleRender();
          }, 5000);
        }
      }

      ensureObserverTarget();
      renderNow();
      ensureObserverTarget();
      syncPollTimer();

      if (Array.isArray(window.__ag_cleanup_fns)) {
        window.__ag_cleanup_fns.push(() => {
          disposed = true;
          try {
            window.removeEventListener('keydown', onKeyDown, true);
          } catch {}
          try {
            document.removeEventListener('mousedown', onDocMouseDown, true);
          } catch {}
          try {
            window.removeEventListener('resize', onWindowResize);
          } catch {}
          if (mo) {
            try {
              mo.disconnect();
            } catch {}
          }
          if (storeUnsub) {
            try {
              storeUnsub();
            } catch {}
            storeUnsub = null;
          }
          if (obsTimer) {
            clearTimeout(obsTimer);
            obsTimer = null;
          }
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          if (tooltipHideTimer) {
            clearTimeout(tooltipHideTimer);
            tooltipHideTimer = null;
          }
          clearRenameWatch();
          pendingPreviewReqs.clear();
          clearActivityViewGlobals(ownedGlobals);
          cleanupActivityViewDom();
        });
      }
    })();
  }

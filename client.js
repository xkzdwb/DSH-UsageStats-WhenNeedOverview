// usage-stats — Client half: a sidebar panel button plus the main-column dashboard.
//
// Registers into `sidebar.panellist` (which owns the button and pairs it with the
// main-panel key of the same id) and into `main` under that key. All data comes from
// the Host half's read-only GET route over the authenticated page origin.
//
// Styling uses only `--dsw-alias-*` theme tokens, so the panel follows light/dark
// automatically. No Harness Client package is imported: React comes from the shared
// module table, and every control is local markup.

window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const ROUTE = '/plugin-usage-stats/data';
    const NS = 'usage-stats';
    const POLL_MS = 5000;
    const EMPTY_ROWS = [];

    /** Currency reported by the newest Host payload; read by money formatting. */
    let currentCurrency = 'CNY';

    const LANG_KEY = 'dsh-usage-stats:lang';

    /** 'auto' follows the Harness locale; 'en' / 'zh' pin this panel's language. */
    function readStoredLang() {
      try {
        const saved = window.localStorage.getItem(LANG_KEY);
        return saved === 'en' || saved === 'zh' ? saved : 'auto';
      } catch {
        return 'auto';
      }
    }

    function storeLang(next) {
      try {
        if (next === 'auto') window.localStorage.removeItem(LANG_KEY);
        else window.localStorage.setItem(LANG_KEY, next);
      } catch {
        /* private mode or a blocked store: the choice simply does not persist */
      }
    }

    let forcedLang = readStoredLang();

    const DICT = {
      en: {
        title: 'Usage statistics',
        tagline: 'Token usage, estimated cost and CPU activity read from your real session logs.',
        panelLabel: 'Usage statistics',
        langLabel: 'Panel language',
        langAuto: 'Auto',
        rangeAll: 'All',
        range1d: '24h',
        range7d: '7d',
        range30d: '30d',
        refresh: 'Refresh',
        loading: 'Reading session logs…',
        loadFailed: 'Could not reach the statistics host half.',
        retry: 'Retry',
        kpiTokens: 'Total tokens',
        kpiConversations: 'Conversations',
        kpiCalls: 'Model calls',
        kpiCost: 'Estimated cost',
        kpiBudget: 'Budget',
        budgetRemaining: '{amount} left',
        budgetOver: '{amount} over budget',
        budgetUnset: 'No budget configured',
        budgetMonth: 'this month',
        budgetAll: 'all time',
        breakdown: '{input} in · {output} out · {cache} cached',
        timeline: 'Token-usage timeline',
        timelineEmpty: 'No usage in this range.',
        bucketHour: 'per hour',
        bucketDay: 'per day',
        legendCacheRead: 'cache read',
        legendInput: 'input',
        legendOutput: 'output',
        legendCost: 'cost',
        byModel: 'By model',
        colModel: 'Model',
        colCalls: 'Calls',
        colTokens: 'Tokens',
        colCost: 'Cost',
        colShare: 'Share',
        cpu: 'CPU activity',
        cpuProcess: 'Harness process',
        cpuSystem: 'System',
        cpuCores: 'cores',
        cpuMemory: 'Process memory',
        cpuWaiting: 'Collecting samples…',
        cpuMachine: '{percent}% of machine',
        cpuUptime: 'Harness uptime',
        conversations: 'Conversations',
        convSearch: 'Filter by title, workspace or id',
        colConversation: 'Conversation',
        colUpdated: 'Last activity',
        colTotal: 'Tokens',
        badgeLive: 'live',
        badgeSubagent: 'subagent',
        noMatch: 'Nothing matches this filter.',
        showMore: 'Show {count} more',
        showLess: 'Show fewer',
        truncated: 'Showing the {shown} most expensive of {total} conversations.',
        generatedAt: 'Updated {time}',
        estimateNote:
          'Costs are estimates: token counts come from session logs, prices from this plugin’s config.',
        errors: 'Some sessions could not be read: {count}',
        untitled: 'Untitled conversation',
      },
      zh: {
        title: '用量统计',
        tagline: 'token 用量、费用估算与 CPU 活动，全部取自真实会话日志。',
        panelLabel: '用量统计',
        langLabel: '面板语言',
        langAuto: '自动',
        rangeAll: '全部',
        range1d: '24 小时',
        range7d: '7 天',
        range30d: '30 天',
        refresh: '刷新',
        loading: '正在读取会话日志…',
        loadFailed: '连不上统计插件的 Host 半边。',
        retry: '重试',
        kpiTokens: '总 token 数',
        kpiConversations: '会话数',
        kpiCalls: '模型调用',
        kpiCost: '预估费用',
        kpiBudget: '预算',
        budgetRemaining: '剩余 {amount}',
        budgetOver: '超支 {amount}',
        budgetUnset: '未设置预算',
        budgetMonth: '本月',
        budgetAll: '累计',
        breakdown: '输入 {input} · 输出 {output} · 缓存 {cache}',
        timeline: 'Token 用量时间线',
        timelineEmpty: '该时间范围内没有用量。',
        bucketHour: '按小时',
        bucketDay: '按天',
        legendCacheRead: '缓存读取',
        legendInput: '输入',
        legendOutput: '输出',
        legendCost: '费用',
        byModel: '按模型',
        colModel: '模型',
        colCalls: '调用',
        colTokens: 'Token',
        colCost: '费用',
        colShare: '占比',
        cpu: 'CPU 活动',
        cpuProcess: 'Harness 进程',
        cpuSystem: '系统',
        cpuCores: '核',
        cpuMemory: '进程内存',
        cpuWaiting: '正在采集样本…',
        cpuMachine: '占整机 {percent}%',
        cpuUptime: 'Harness 运行时长',
        conversations: '会话明细',
        convSearch: '按标题、工作区或 id 过滤',
        colConversation: '会话',
        colUpdated: '最后活动',
        colTotal: 'Token',
        badgeLive: '进行中',
        badgeSubagent: '子代理',
        noMatch: '没有符合过滤条件的会话。',
        showMore: '再显示 {count} 条',
        showLess: '收起',
        truncated: '共 {total} 个会话，这里显示花费最高的 {shown} 个。',
        generatedAt: '更新于 {time}',
        estimateNote: '费用是按本插件配置里的价格、乘以会话日志中记录的 token 估算出来的。',
        errors: '有 {count} 个会话读取失败。',
        untitled: '未命名会话',
      },
    };

    const CSS = `
.us-root { height: 100%; min-height: 0; overflow: auto; overscroll-behavior: contain; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.us-inner { max-width: 1120px; margin: 0 auto; padding: 20px 20px 48px; }
.us-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.us-head h1 { font-size: 18px; line-height: 26px; margin: 0 0 4px; font-weight: 600; }
.us-tagline { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin: 0; max-width: 560px; }
.us-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.us-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }
.us-seg button { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 5px 10px; cursor: pointer; }
.us-seg button[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.us-seg-lang button { padding: 5px 8px; }
.us-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.us-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.us-btn:disabled { opacity: .5; cursor: default; }
.us-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; }
.us-mb { margin-bottom: 12px; }
.us-grid-kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 12px; }
.us-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-bottom: 12px; }
.us-kpi-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.us-kpi-value { font-size: 22px; line-height: 30px; font-weight: 600; font-variant-numeric: tabular-nums; }
.us-kpi-sub { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); margin-top: 4px; font-variant-numeric: tabular-nums; }
.us-card-title { font-size: 13px; font-weight: 600; margin: 0 0 10px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.us-card-title span { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.us-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 8px; }
.us-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.us-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
.us-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.us-chart { width: 100%; height: auto; display: block; }
.us-table-wrap { overflow-x: auto; }
table.us-table { width: 100%; border-collapse: collapse; font-size: 12px; }
table.us-table th, table.us-table td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
table.us-table th:first-child, table.us-table td:first-child { text-align: left; white-space: normal; }
table.us-table th { color: var(--dsw-alias-label-secondary); font-weight: 500; cursor: pointer; user-select: none; }
table.us-table th[aria-sort] { color: var(--dsw-alias-label-primary); }
table.us-table td { font-variant-numeric: tabular-nums; }
table.us-table tbody tr:hover { background: var(--dsw-alias-bg-layer-2); }
.us-conv-title { display: block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.us-conv-meta { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.us-badge { display: inline-block; font-size: 10px; line-height: 14px; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); margin-left: 6px; vertical-align: 1px; }
.us-badge-live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.us-costbar { display: inline-block; height: 6px; border-radius: 999px; background: var(--dsw-alias-brand-primary); vertical-align: middle; margin-left: 6px; min-width: 2px; }
.us-note { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); margin-top: 10px; }
.us-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 10px 12px; font-size: 12px; margin-bottom: 12px; }
.us-warn { border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); border-radius: 8px; padding: 8px 12px; font-size: 11px; margin-top: 12px; }
.us-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 16px 0; text-align: center; }
.us-input { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 8px; min-width: 220px; }
.us-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.us-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12px; padding: 2px 0; }
.us-row span:last-child { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.us-kpisub-block { margin-top: 2px; }
`;

    // ------------------------------------------------------------------ format

    function interpolate(text, vars) {
      if (vars === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (_match, key) => (vars[key] === undefined ? '' : String(vars[key])));
    }

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' };

    function numberFormat(localeId, options) {
      try {
        return new Intl.NumberFormat(localeId, options);
      } catch {
        return new Intl.NumberFormat(undefined, options);
      }
    }

    function compact(value) {
      const n = Number(value) || 0;
      const abs = Math.abs(n);
      if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.round(n));
    }

    function bytes(value) {
      const n = Number(value) || 0;
      if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
      if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${Math.round(n)} B`;
    }

    function duration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    function shortPath(path) {
      if (typeof path !== 'string' || path.length === 0) return '';
      const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/);
      return parts[parts.length - 1] || path;
    }

    function money(value, localeId) {
      const n = Number(value) || 0;
      const digits = Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2;
      const symbol = CURRENCY_SYMBOL[currentCurrency];
      const body = numberFormat(localeId, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
      return symbol ? `${symbol}${body}` : `${body} ${currentCurrency}`;
    }

    // ---------------------------------------------------------------- data hook

    function useStats(days, token) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null });
      const forcedRef = useRef(null);

      useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        const forceOnce = token !== '' && forcedRef.current !== token;
        if (forceOnce) forcedRef.current = token;

        const load = async (force) => {
          try {
            const response = await fetch(`${ROUTE}?days=${days}${force ? '&refresh=1' : ''}`, {
              signal: controller.signal,
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const json = await response.json();
            if (json && json.error) throw new Error(String(json.error));
            if (json && typeof json.currency === 'string') currentCurrency = json.currency;
            if (!cancelled) setState({ status: 'ready', data: json, error: null });
          } catch (error) {
            if (cancelled || (error && error.name === 'AbortError')) return;
            const message = String((error && error.message) || error);
            setState((prev) => ({ status: prev.data ? 'ready' : 'error', data: prev.data, error: message }));
          }
        };

        void load(forceOnce);
        const timer = setInterval(() => void load(false), POLL_MS);
        return () => {
          cancelled = true;
          controller.abort();
          clearInterval(timer);
        };
      }, [days, token]);

      return state;
    }

    // ------------------------------------------------------------------ charts

    function TimelineChart({ t, timeline }) {
      const points = (timeline && timeline.points) || [];
      if (points.length === 0) return h('div', { className: 'us-empty' }, t('timelineEmpty'));

      const W = 900;
      const H = 210;
      const padL = 4;
      const padR = 4;
      const padT = 10;
      const padB = 24;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;
      const slot = innerW / points.length;
      const barW = Math.max(1.5, Math.min(28, slot - 2));
      const maxTokens = Math.max(1, ...points.map((point) => point.total || 0));
      const maxCost = Math.max(1e-9, ...points.map((point) => point.cost || 0));
      const numeric = numberFormat(t.localeId);

      const segmentFill = {
        cacheRead: 'var(--dsw-alias-state-idle-primary)',
        input: 'var(--dsw-alias-brand-primary)',
        output: 'var(--dsw-alias-state-warn-primary)',
      };

      const bars = points.map((point, index) => {
        const x = padL + index * slot + (slot - barW) / 2;
        const barHeight = ((point.total || 0) / maxTokens) * innerH;
        let cursor = padT + innerH;
        const rects = [];
        for (const key of ['cacheRead', 'input', 'output']) {
          const value = point[key] || 0;
          if (value <= 0) continue;
          const segmentHeight = (value / maxTokens) * innerH;
          cursor -= segmentHeight;
          rects.push(
            h('rect', {
              key,
              x,
              y: cursor,
              width: barW,
              height: Math.max(0.5, segmentHeight),
              fill: segmentFill[key],
            }),
          );
        }
        if (rects.length === 0) return null;
        return h(
          'g',
          { key: point.t },
          h(
            'title',
            null,
            `${new Date(point.t).toLocaleString(t.localeId)} · ${numeric.format(point.total || 0)} tokens · ${money(point.cost, t.localeId)} · ${point.calls || 0} calls`,
          ),
          h('rect', { x, y: padT + innerH - barHeight, width: barW, height: Math.max(0.5, barHeight), fill: 'transparent' }),
          rects,
        );
      });

      const costLine = points
        .map((point, index) => {
          const x = padL + index * slot + slot / 2;
          const y = padT + innerH - ((point.cost || 0) / maxCost) * innerH * 0.9;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

      const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(
        (value) => value >= 0,
      );
      const labels = labelIndexes.map((index) => {
        const date = new Date(points[index].t);
        const text =
          timeline.bucket === 'day'
            ? `${date.getMonth() + 1}/${date.getDate()}`
            : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`;
        const first = index === 0;
        const last = index === points.length - 1;
        return h(
          'text',
          {
            key: `label-${index}`,
            x: first ? padL : last ? W - padR : padL + index * slot + slot / 2,
            y: H - 6,
            textAnchor: first ? 'start' : last ? 'end' : 'middle',
            fontSize: 10,
            fill: 'var(--dsw-alias-label-secondary)',
          },
          text,
        );
      });

      return h(
        'div',
        null,
        h(
          'svg',
          { className: 'us-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('timeline') },
          h('line', {
            x1: padL,
            y1: padT + innerH,
            x2: W - padR,
            y2: padT + innerH,
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: 1,
          }),
          bars,
          points.length > 1
            ? h('polyline', {
                points: costLine,
                fill: 'none',
                stroke: 'var(--dsw-alias-state-success-primary)',
                strokeWidth: 1.5,
                strokeLinejoin: 'round',
              })
            : null,
          labels,
        ),
        h(
          'div',
          { className: 'us-legend' },
          h('span', null, h('i', { style: { background: segmentFill.cacheRead } }), t('legendCacheRead')),
          h('span', null, h('i', { style: { background: segmentFill.input } }), t('legendInput')),
          h('span', null, h('i', { style: { background: segmentFill.output } }), t('legendOutput')),
          h('span', null, h('i', { style: { background: 'var(--dsw-alias-state-success-primary)' } }), t('legendCost')),
        ),
      );
    }

    function CpuSpark({ t, cpu }) {
      const history = (cpu && cpu.history) || [];
      if (history.length < 2) return h('div', { className: 'us-empty' }, t('cpuWaiting'));
      const W = 460;
      const H = 64;
      const cores = Math.max(1, cpu.cores || 1);
      const line = (pick) =>
        history
          .map((sample, index) => {
            const x = (index / (history.length - 1)) * W;
            const value = Math.min(100, Math.max(0, pick(sample)));
            return `${x.toFixed(1)},${(H - (value / 100) * H).toFixed(1)}`;
          })
          .join(' ');
      return h(
        'svg',
        {
          className: 'us-chart',
          viewBox: `0 0 ${W} ${H}`,
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': t('cpu'),
          style: { height: 64 },
        },
        h('line', { x1: 0, y1: H - 0.5, x2: W, y2: H - 0.5, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
        h('polyline', { points: line((sample) => sample.s), fill: 'none', stroke: 'var(--dsw-alias-state-idle-primary)', strokeWidth: 1.5 }),
        h('polyline', { points: line((sample) => sample.p / cores), fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5 }),
      );
    }

    // ---------------------------------------------------------------- panel UI

    function Panel(props) {
      const t = props.t;
      const [days, setDays] = useState(0);
      const [token, setToken] = useState('');
      const [sort, setSort] = useState('cost');
      const [filter, setFilter] = useState('');
      const [limit, setLimit] = useState(20);
      const { status, data, error } = useStats(days, token);

      const conversations = (data && data.conversations) || EMPTY_ROWS;

      const filtered = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const rows = needle
          ? conversations.filter((row) =>
              [row.title, row.cwd, row.id].some(
                (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
              ),
            )
          : conversations;
        const sorted = [...rows];
        sorted.sort((a, b) => {
          if (sort === 'time') return (b.updatedAt || 0) - (a.updatedAt || 0);
          if (sort === 'tokens') return (b.total || 0) - (a.total || 0);
          if (sort === 'calls') return (b.calls || 0) - (a.calls || 0);
          if (sort === 'title') return String(a.title || a.id).localeCompare(String(b.title || b.id));
          return (b.cost || 0) - (a.cost || 0);
        });
        return sorted;
      }, [conversations, filter, sort]);

      const onSort = useCallback((key) => {
        setSort((prev) => (prev === key ? (key === 'time' ? 'cost' : 'time') : key));
      }, []);

      if (status === 'loading' && data === null) {
        return h(
          'div',
          { className: 'us-root' },
          h('style', null, CSS),
          h('div', { className: 'us-inner' }, h('div', { className: 'us-empty' }, t('loading'))),
        );
      }

      if (status === 'error' && data === null) {
        return h(
          'div',
          { className: 'us-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'us-inner' },
            h('div', { className: 'us-error' }, `${t('loadFailed')} ${error || ''}`),
            h('button', { className: 'us-btn', type: 'button', onClick: () => setToken(String(Date.now())) }, t('retry')),
          ),
        );
      }

      const totals = data.totals || {};
      const budget = data.budget || { amount: 0, spent: 0, remaining: 0, ratio: 0, period: 'month' };
      const cpu = data.cpu || { history: [], process: {}, system: {}, memory: {}, cores: 1 };
      const timeline = data.timeline || { bucket: 'hour', points: [] };
      const modelRows = data.byModel || [];
      const maxModelCost = Math.max(1e-9, ...modelRows.map((row) => row.cost || 0));
      const maxConvCost = Math.max(1e-9, ...conversations.map((row) => row.cost || 0));
      const visible = filtered.slice(0, limit);
      const budgetRatio = Math.min(1, Math.max(0, budget.ratio || 0));
      const budgetColor =
        budgetRatio >= 0.9
          ? 'var(--dsw-alias-state-error-primary)'
          : budgetRatio >= 0.7
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-brand-primary)';
      const numeric = numberFormat(t.localeId);
      const periodLabel = budget.period === 'all' ? t('budgetAll') : t('budgetMonth');

      const kpi = (label, value, sub, extra) =>
        h(
          'div',
          { className: 'us-card' },
          h('div', { className: 'us-kpi-label' }, label),
          h('div', { className: 'us-kpi-value' }, value),
          sub ? h('div', { className: 'us-kpi-sub' }, sub) : null,
          extra || null,
        );

      const sortableHead = (key, label) =>
        h(
          'th',
          {
            key,
            role: 'button',
            tabIndex: 0,
            'aria-sort': sort === key ? 'descending' : undefined,
            onClick: () => onSort(key),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSort(key);
              }
            },
          },
          label,
        );

      return h(
        'div',
        { className: 'us-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'us-inner' },
          h(
            'div',
            { className: 'us-head' },
            h('div', null, h('h1', null, t('title')), h('p', { className: 'us-tagline' }, t('tagline'))),
            h(
              'div',
              { className: 'us-head-actions' },
              h(
                'div',
                { className: 'us-seg us-seg-lang', role: 'group', 'aria-label': t('langLabel'), title: t('langLabel') },
                [
                  ['auto', t('langAuto')],
                  ['zh', '中文'],
                  ['en', 'EN'],
                ].map(([value, label]) =>
                  h(
                    'button',
                    {
                      key: value,
                      type: 'button',
                      'aria-pressed': (props.lang || 'auto') === value,
                      onClick: () => {
                        if (typeof props.setLang === 'function') props.setLang(value);
                      },
                    },
                    label,
                  ),
                ),
              ),
              h(
                'div',
                { className: 'us-seg', role: 'group' },
                [
                  [0, t('rangeAll')],
                  [1, t('range1d')],
                  [7, t('range7d')],
                  [30, t('range30d')],
                ].map(([value, label]) =>
                  h(
                    'button',
                    { key: value, type: 'button', 'aria-pressed': days === value, onClick: () => setDays(value) },
                    label,
                  ),
                ),
              ),
              h('button', { className: 'us-btn', type: 'button', onClick: () => setToken(String(Date.now())) }, t('refresh')),
            ),
          ),

          status === 'error' && error ? h('div', { className: 'us-error' }, `${t('loadFailed')} ${error}`) : null,

          h(
            'div',
            { className: 'us-grid-kpi' },
            kpi(
              t('kpiTokens'),
              compact(totals.total),
              t('breakdown', {
                input: compact(totals.input),
                output: compact(totals.output),
                cache: compact(totals.cacheRead),
              }),
            ),
            kpi(
              t('kpiConversations'),
              numeric.format(totals.conversations || 0),
              `${numeric.format(totals.calls || 0)} ${t('kpiCalls').toLowerCase()}`,
            ),
            kpi(t('kpiCost'), money(totals.cost || 0, t.localeId), periodLabel),
            budget.amount > 0
              ? kpi(
                  t('kpiBudget'),
                  `${Math.round(budgetRatio * 100)}%`,
                  budget.remaining >= 0
                    ? t('budgetRemaining', { amount: money(budget.remaining, t.localeId) })
                    : t('budgetOver', { amount: money(Math.abs(budget.remaining), t.localeId) }),
                  h('div', { className: 'us-kpisub-block' }, h('div', { className: 'us-bar' }, h('div', { className: 'us-bar-fill', style: { width: `${budgetRatio * 100}%`, background: budgetColor } }))),
                )
              : kpi(t('kpiBudget'), '—', t('budgetUnset')),
          ),

          h(
            'div',
            { className: 'us-card us-mb' },
            h(
              'h2',
              { className: 'us-card-title' },
              t('timeline'),
              h('span', null, timeline.bucket === 'day' ? t('bucketDay') : t('bucketHour')),
            ),
            h(TimelineChart, { t, timeline }),
          ),

          h(
            'div',
            { className: 'us-grid-2' },
            h(
              'div',
              { className: 'us-card' },
              h('h2', { className: 'us-card-title' }, t('byModel')),
              modelRows.length === 0
                ? h('div', { className: 'us-empty' }, t('timelineEmpty'))
                : h(
                    'div',
                    { className: 'us-table-wrap' },
                    h(
                      'table',
                      { className: 'us-table' },
                      h('thead', null, h('tr', null, h('th', null, t('colModel')), h('th', null, t('colCalls')), h('th', null, t('colTokens')), h('th', null, t('colCost')), h('th', null, t('colShare')))),
                      h(
                        'tbody',
                        null,
                        modelRows.map((row) =>
                          h(
                            'tr',
                            { key: row.key },
                            h('td', { className: 'us-mono', title: row.key }, row.key),
                            h('td', null, numeric.format(row.calls || 0)),
                            h('td', { title: numeric.format(row.total || 0) }, compact(row.total)),
                            h('td', null, money(row.cost, t.localeId)),
                            h('td', null, h('span', { className: 'us-costbar', style: { width: `${Math.max(2, ((row.cost || 0) / maxModelCost) * 48)}px` } })),
                          ),
                        ),
                      ),
                    ),
                  ),
            ),
            h(
              'div',
              { className: 'us-card' },
              h('h2', { className: 'us-card-title' }, t('cpu'), h('span', null, `${cpu.cores} ${t('cpuCores')}`)),
              h(CpuSpark, { t, cpu }),
              h('div', { className: 'us-row', style: { marginTop: 6 } }, h('span', null, t('cpuProcess')), h('span', null, `${numeric.format(Math.round((cpu.process.percent || 0) * 10) / 10)}%  ·  ${t('cpuMachine', { percent: (cpu.process.machinePercent || 0).toFixed(1) })}`)),
              h('div', { className: 'us-bar' }, h('div', { className: 'us-bar-fill', style: { width: `${Math.min(100, cpu.process.machinePercent || 0)}%` } })),
              h('div', { className: 'us-row', style: { marginTop: 8 } }, h('span', null, t('cpuSystem')), h('span', null, `${(cpu.system.percent || 0).toFixed(1)}%`)),
              h('div', { className: 'us-bar' }, h('div', { className: 'us-bar-fill', style: { width: `${Math.min(100, cpu.system.percent || 0)}%`, background: 'var(--dsw-alias-state-idle-primary)' } })),
              h('div', { className: 'us-row', style: { marginTop: 8 } }, h('span', null, t('cpuMemory')), h('span', null, bytes(cpu.memory.processRssBytes))),
              h('div', { className: 'us-row' }, h('span', null, t('cpuUptime')), h('span', null, duration(cpu.hostUptimeSec))),
            ),
          ),

          h(
            'div',
            { className: 'us-card' },
            h('h2', { className: 'us-card-title' }, t('conversations'), h('span', null, `${filtered.length} / ${conversations.length}`)),
            h('input', {
              className: 'us-input',
              type: 'search',
              value: filter,
              placeholder: t('convSearch'),
              'aria-label': t('convSearch'),
              onChange: (event) => setFilter(event.target.value),
              style: { marginBottom: 10 },
            }),
            visible.length === 0
              ? h('div', { className: 'us-empty' }, t('noMatch'))
              : h(
                  'div',
                  { className: 'us-table-wrap' },
                  h(
                    'table',
                    { className: 'us-table' },
                    h(
                      'thead',
                      null,
                      h('tr', null, sortableHead('title', t('colConversation')), sortableHead('calls', t('colCalls')), sortableHead('tokens', t('colTotal')), sortableHead('cost', t('colCost')), sortableHead('time', t('colUpdated'))),
                    ),
                    h(
                      'tbody',
                      null,
                      visible.map((row) =>
                        h(
                          'tr',
                          { key: row.id },
                          h(
                            'td',
                            null,
                            h('span', { className: 'us-conv-title', title: row.title || row.id }, row.title || t('untitled')),
                            row.live ? h('span', { className: 'us-badge us-badge-live' }, t('badgeLive')) : null,
                            row.subagent ? h('span', { className: 'us-badge' }, t('badgeSubagent')) : null,
                            h(
                              'span',
                              { className: 'us-conv-meta', title: row.cwd || row.id },
                              [shortPath(row.cwd), row.models && row.models.length > 0 ? row.models.join(', ') : row.id.slice(0, 24)]
                                .filter(Boolean)
                                .join('  ·  '),
                            ),
                          ),
                          h('td', null, numeric.format(row.calls || 0)),
                          h('td', { title: numeric.format(row.total || 0) }, compact(row.total)),
                          h('td', null, money(row.cost, t.localeId), h('span', { className: 'us-costbar', style: { width: `${Math.max(2, ((row.cost || 0) / maxConvCost) * 40)}px` } })),
                          h(
                            'td',
                            null,
                            row.updatedAt
                              ? new Date(row.updatedAt).toLocaleString(t.localeId, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                              : '—',
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            limit < filtered.length
              ? h('button', { className: 'us-btn', type: 'button', style: { marginTop: 10 }, onClick: () => setLimit((value) => value + 50) }, t('showMore', { count: Math.min(50, filtered.length - limit) }))
              : limit > 20
                ? h('button', { className: 'us-btn', type: 'button', style: { marginTop: 10 }, onClick: () => setLimit(20) }, t('showLess'))
                : null,
            data.conversationsTruncated
              ? h('div', { className: 'us-note' }, t('truncated', { shown: conversations.length, total: totals.conversations }))
              : null,
          ),

          data.errors && data.errors.length > 0
            ? h('div', { className: 'us-warn' }, t('errors', { count: data.errors.length }))
            : null,
          h('div', { className: 'us-note' }, t('estimateNote')),
          h('div', { className: 'us-note' }, t('generatedAt', { time: new Date(data.generatedAt).toLocaleTimeString(t.localeId) })),
        ),
      );
    }

    // ------------------------------------------------------------------- apply

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false, style: { display: 'block' } },
        h('path', {
          d: 'M3 20h18M6.5 20v-6M12 20V6M17.5 20v-9',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale && typeof locale.register === 'function') {
          for (const [id, dict] of Object.entries(DICT)) {
            ctx.effect(() => locale.register(NS, id, dict), `usage-stats: locale ${id}`);
          }
        }

        const hostLocale = () => {
          try {
            return (locale && locale.getSnapshot && locale.getSnapshot().active) || undefined;
          } catch {
            return undefined;
          }
        };

        /** A pinned choice wins over the Harness locale, for this panel only. */
        const activeLocale = () => (forcedLang === 'auto' ? hostLocale() : forcedLang);

        const t = (key, vars) => {
          const active = activeLocale();
          const base = typeof active === 'string' ? active.split('-')[0] : 'en';
          const dict = DICT[active] || DICT[base] || DICT.en;
          const text = dict[key] !== undefined ? dict[key] : DICT.en[key] !== undefined ? DICT.en[key] : key;
          return interpolate(text, vars);
        };
        Object.defineProperty(t, 'localeId', { get: activeLocale });

        const BoundPanel = (props) => {
          const [revision, setRevision] = useState(0);
          const [lang, setLangState] = useState(forcedLang);
          useEffect(() => {
            if (!locale || typeof locale.subscribe !== 'function') return undefined;
            return locale.subscribe(() => setRevision((value) => value + 1));
          }, []);
          const setLang = useCallback((next) => {
            forcedLang = next === 'en' || next === 'zh' ? next : 'auto';
            storeLang(forcedLang);
            setLangState(forcedLang);
            setRevision((value) => value + 1);
          }, []);
          void revision;
          return h(Panel, { ...props, t, lang, setLang });
        };
        BoundPanel.displayName = 'UsageStatsPanel';

        const BoundIcon = (props) => h(PanelIcon, props);
        BoundIcon.displayName = 'UsageStatsIcon';

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'usage-stats', order: 20, label: () => t('panelLabel') },
            BoundIcon,
          ),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'usage-stats' }, BoundPanel));
      },
    };
  },
});

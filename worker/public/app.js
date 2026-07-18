(() => {
  "use strict";

  const API = Object.freeze({
    dashboard: "/api/dashboard",
    settings: "/api/admin/settings",
    run: "/api/admin/run",
    balances: "/api/admin/balances",
    history: "/api/history/events",
  });
  const TOKEN_KEY = "vsllm_admin_token";
  const DEFAULT_QUOTA_PER_CNY = 500000;
  const VALID_TABS = new Set(["overview", "accounts", "records", "settings"]);
  const moneyFormat = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  const quotaFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
  const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const fullDateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const EMPTY_DASHBOARD = Object.freeze({
    as_of: null,
    conversion: { quota_per_cny: DEFAULT_QUOTA_PER_CNY },
    income: {},
    accounts: [],
    schedules: [],
    trend: [],
    recent_runs: [],
    recent_events: [],
    settings: {},
  });

  function readSessionToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function writeSessionToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Session storage can be unavailable in strict browser privacy modes.
    }
  }

  const state = {
    dashboard: null,
    adminSettings: null,
    adminToken: readSessionToken(),
    afterLogin: null,
    loading: false,
    activeTab: "overview",
    eventHistory: {
      items: [],
      pagination: { page: 1, page_size: 25, total: 0, total_pages: 0 },
      loaded: false,
      loading: false,
      requestVersion: 0,
    },
    balances: null,
  };
  const buttonContents = new WeakMap();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeNumber(value, fallback = 0) {
    const number = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function safeInteger(value, fallback = 0) {
    return Math.max(0, Math.trunc(safeNumber(value, fallback)));
  }

  function quotaPerCny() {
    const value = safeNumber(state.dashboard?.conversion?.quota_per_cny, DEFAULT_QUOTA_PER_CNY);
    return value > 0 ? value : DEFAULT_QUOTA_PER_CNY;
  }

  function quotaOf(record, key = "quota") {
    return safeNumber(record?.[key]);
  }

  function amountOf(record, quotaKey = "quota", amountKey = "amount_yuan") {
    const explicit = Number(record?.[amountKey]);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    return quotaOf(record, quotaKey) / quotaPerCny();
  }

  function formatMoney(value) {
    return moneyFormat.format(safeNumber(value)).replace("CN¥", "¥");
  }

  function formatQuota(value) {
    return quotaFormat.format(safeNumber(value));
  }

  function formatRate(wins, draws) {
    const total = safeInteger(draws);
    if (!total) return "0.0%";
    return `${Math.min(100, (safeInteger(wins) / total) * 100).toFixed(1)}%`;
  }

  function validTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }

  function formatDateTime(value, fallback = "--") {
    if (!validTimestamp(value)) return fallback;
    return dateTimeFormat.format(new Date(value)).replace("24:", "00:");
  }

  function formatFullDateTime(value, fallback = "--") {
    if (!validTimestamp(value)) return fallback;
    return fullDateTimeFormat.format(new Date(value)).replace("24:", "00:");
  }

  function relativeTime(value) {
    if (!validTimestamp(value)) return "尚未运行";
    const difference = Date.now() - Date.parse(value);
    if (difference < -60000) return formatDateTime(value);
    const minutes = Math.floor(Math.max(0, difference) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return formatDateTime(value);
  }

  function sourceLabel(source) {
    return ({
      draw: "常规翻牌",
      gwent: "常规翻牌",
      checkin: "签到",
      quiz: "答题",
      ad: "视频",
      all: "全部任务 + 翻牌",
    })[source] || "其他任务";
  }

  function triggerLabel(trigger) {
    return ({
      manual: "手动",
      schedule: "定时",
      scheduled: "定时",
      reward: "奖励后",
      api: "接口",
    })[trigger] || trigger || "自动";
  }

  function normalizeStatus(value) {
    const status = String(value || "unknown").toLowerCase();
    const aliases = {
      done: "completed",
      success: "success",
      ready: "available",
      active: "running",
      failure: "failed",
    };
    return aliases[status] || status;
  }

  function taskView(task, type) {
    if (!task || typeof task !== "object") {
      return { state: "unknown", label: "待检查", message: "尚未收到今日状态" };
    }
    let status = task.completed ? "completed" : normalizeStatus(task.state || task.status);
    const nextAt = task.next_available_at || task.next_at || null;
    if (type === "ad" && status === "cooldown" && validTimestamp(nextAt) && Date.parse(nextAt) <= Date.now()) {
      status = "available";
    }
    const baseLabel = ({
      completed: "已完成",
      success: "已完成",
      available: "可执行",
      cooldown: "冷却中",
      pending: "待执行",
      queued: "排队中",
      running: "执行中",
      suspended: "已暂停",
      error: "异常",
      failed: "失败",
      auth: "认证异常",
      unknown: "待检查",
    })[status] || "待检查";
    let label = baseLabel;
    if (type === "ad") {
      const doneValid = task.done_count !== null && task.done_count !== undefined && task.done_count !== ""
        && Number.isInteger(Number(task.done_count)) && Number(task.done_count) >= 0;
      const capValid = task.daily_cap !== null && task.daily_cap !== undefined && task.daily_cap !== ""
        && Number.isInteger(Number(task.daily_cap)) && Number(task.daily_cap) > 0;
      const progress = doneValid ? `${Math.trunc(Number(task.done_count))}/${capValid ? Math.trunc(Number(task.daily_cap)) : 3}` : "--/3";
      label = `${progress} · ${baseLabel}`;
    }
    return {
      state: status,
      label,
      message: task.message || "",
      checkedAt: task.checked_at || task.updated_at || null,
      nextAt,
    };
  }

  function statusChip(status, label, title) {
    const normalized = normalizeStatus(status);
    const chip = element("span", `status-chip status-${normalized}`, label);
    chip.setAttribute("aria-label", label);
    if (title) chip.title = String(title);
    return chip;
  }

  function taskChip(task, type) {
    const view = taskView(task, type);
    const details = [view.message];
    if (view.nextAt && view.state === "cooldown") details.push(`下次可执行：${formatFullDateTime(view.nextAt)}`);
    return statusChip(view.state, view.label, details.filter(Boolean).join("\n"));
  }

  function accountInitial(name, index) {
    const text = String(name || "").trim();
    return text ? text.slice(0, 1).toUpperCase() : String(index + 1);
  }

  function accountIdentity(account, index, subtitle) {
    const wrap = element("div", "account-identity");
    wrap.append(element("span", "account-avatar", accountInitial(account.account_name, index)));
    const copy = element("span");
    copy.append(element("strong", "", account.account_name || `账号 ${index + 1}`));
    copy.append(element("small", "", subtitle || `账号 ${index + 1}`));
    wrap.append(copy);
    return wrap;
  }

  function moneyBlock(amount, quota) {
    const wrap = element("span");
    wrap.append(element("strong", "money-primary", formatMoney(amount)));
    wrap.append(element("small", "money-secondary", `${formatQuota(quota)} 额度`));
    return wrap;
  }

  function setCellLabel(cell, label) {
    cell.dataset.label = label;
    return cell;
  }

  function setConnection(status, text) {
    const badge = $("#storage-status");
    badge.className = `connection-badge status-${status}`;
    badge.lastElementChild.textContent = text;
  }

  function showPageError(message) {
    $("#page-message-text").textContent = message;
    $("#page-message").hidden = false;
  }

  function clearPageError() {
    $("#page-message").hidden = true;
  }

  function showToast(message, type = "success", duration = 4200) {
    const toast = element("div", `toast${type === "success" ? "" : ` is-${type}`}`, message);
    $("#toast-region").append(toast);
    window.setTimeout(() => toast.remove(), duration);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      buttonContents.set(button, [...button.childNodes].map((node) => node.cloneNode(true)));
      button.disabled = true;
      if (busyText) button.textContent = busyText;
    } else {
      button.disabled = false;
      const original = buttonContents.get(button);
      if (original) button.replaceChildren(...original);
      buttonContents.delete(button);
    }
  }

  async function request(url, options = {}) {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.admin) {
      if (!state.adminToken) {
        const error = new Error("需要管理员登录");
        error.status = 401;
        throw error;
      }
      headers.set("Authorization", `Bearer ${state.adminToken}`);
    }
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let payload = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const message = typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.error?.message === "string"
            ? payload.error.message
            : `请求失败（HTTP ${response.status}）`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  function showLoadingPlaceholders() {
    for (const selector of ["#today-task-list", "#schedule-list", "#overview-run-list"]) {
      const container = $(selector);
      container.replaceChildren(...Array.from({ length: 3 }, () => element("div", "loading-line")));
    }
  }

  function renderIncome(income, totals, accounts) {
    for (const period of ["total", "today", "week", "month"]) {
      const item = income?.[period] || {};
      const quota = quotaOf(item);
      const amount = amountOf(item);
      $(`#income-${period}`).textContent = formatMoney(amount);
      $(`#income-${period}-quota`).textContent = `${formatQuota(quota)} 额度`;
    }
    $("#conversion-rate").textContent = `${formatQuota(quotaPerCny())} 额度 = ¥1`;
    const accountItems = Array.isArray(accounts) ? accounts : [];
    const totalDraws = safeInteger(totals?.total_draws, accountItems.reduce((sum, account) => sum + safeInteger(account.total_draws), 0));
    const totalWins = safeInteger(totals?.total_wins, accountItems.reduce((sum, account) => sum + safeInteger(account.total_wins), 0));
    $("#total-draws").textContent = formatQuota(totalDraws);
    $("#total-wins").textContent = formatQuota(totalWins);
    $("#total-win-rate").textContent = formatRate(totalWins, totalDraws);
    $("#total-accounts").textContent = formatQuota(safeInteger(totals?.total_accounts, accountItems.length));
  }

  function renderAutomationPause(paused) {
    const banner = $("#automation-paused-banner");
    banner.hidden = paused !== true;
  }

  function renderTodayTasks(accounts) {
    const list = $("#today-task-list");
    const empty = $("#today-task-empty");
    list.replaceChildren();
    const visible = accounts.slice(0, 6);
    empty.hidden = visible.length > 0;
    if (!visible.length) return;

    const fragment = document.createDocumentFragment();
    visible.forEach((account, index) => {
      const row = element("article", "task-account-row");
      row.append(accountIdentity(account, index, `${formatQuota(account.total_draws)} 次累计翻牌`));
      for (const [type, label] of [["checkin", "签到"], ["quiz", "答题"], ["ad", "视频"]]) {
        const cell = element("div", "task-cell");
        cell.append(element("span", "task-cell-label", label));
        cell.append(taskChipForAccount(account, type));
        row.append(cell);
      }
      const quota = safeNumber(account.today_quota);
      const income = element("div", "task-income");
      income.append(element("strong", "", formatMoney(
        Number.isFinite(Number(account.today_amount_yuan))
          ? Number(account.today_amount_yuan)
          : quota / quotaPerCny(),
      )));
      income.append(element("small", "", `${formatQuota(quota)} 今日额度`));
      row.append(income);
      fragment.append(row);
    });
    list.append(fragment);
  }

  function renderSchedules(schedules) {
    const list = $("#schedule-list");
    const empty = $("#schedule-empty");
    list.replaceChildren();
    const items = Array.isArray(schedules) ? schedules : [];
    const enabledCount = items.filter((item) => item?.enabled).length;
    $("#enabled-schedule-count").textContent = `${enabledCount} 项启用`;
    empty.hidden = items.length > 0;
    if (!items.length) return;

    const fragment = document.createDocumentFragment();
    items.forEach((schedule) => {
      const row = element("div", `schedule-item${schedule.enabled ? " is-enabled" : ""}`);
      const copy = element("div");
      copy.append(element("strong", "", schedule.label || sourceLabel(schedule.key)));
      copy.append(element("small", "", schedule.summary || (schedule.enabled ? "已启用" : "已停用")));
      const time = element("div", "schedule-time");
      const timeNode = element("time", "", schedule.enabled ? formatDateTime(schedule.next_at, "等待调度") : "已停用");
      if (validTimestamp(schedule.next_at)) timeNode.dateTime = new Date(schedule.next_at).toISOString();
      time.append(timeNode);
      time.append(element("span", "", schedule.enabled && validTimestamp(schedule.next_at) ? "下次执行" : "计划状态"));
      row.append(copy, time);
      fragment.append(row);
    });
    list.append(fragment);
  }

  function renderTrend(trend) {
    const chart = $("#trend-chart");
    const empty = $("#trend-empty");
    const items = (Array.isArray(trend) ? trend : []).slice(-14);
    chart.replaceChildren();
    empty.hidden = items.length > 0;
    chart.hidden = items.length === 0;
    if (!items.length) return;

    const maximum = Math.max(1, ...items.map((item) => safeNumber(item.total_quota ?? item.quota)));
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const quota = safeNumber(item.total_quota ?? item.quota);
      const column = element("div", "trend-column");
      const barWrap = element("div", "trend-bar-wrap");
      const level = quota > 0 ? Math.max(1, Math.min(20, Math.round((quota / maximum) * 20))) : 0;
      const bar = element("span", `trend-bar trend-level-${level}`);
      bar.title = `${item.date || "未知日期"}：${formatQuota(quota)} 额度（${formatMoney(amountOf(item, "total_quota"))}）`;
      barWrap.append(bar);
      column.append(barWrap, element("span", "trend-label", String(item.date || "--").slice(5)));
      fragment.append(column);
    });
    chart.append(fragment);
  }

  function renderOverviewEvents(events) {
    const list = $("#overview-event-list");
    const empty = $("#overview-event-empty");
    const items = (Array.isArray(events) ? events : []).slice(0, 5);
    list.replaceChildren();
    empty.hidden = items.length > 0;
    if (!items.length) return;

    const fragment = document.createDocumentFragment();
    items.forEach((event) => {
      const quota = safeNumber(event.prize_quota ?? event.quota);
      const row = element("div", "event-preview-row");
      const copy = element("div", "event-preview-copy");
      copy.append(element("strong", "", event.account_name || "未知账号"));
      copy.append(element("small", "", `${formatDateTime(event.occurred_at || event.created_at)} · ${sourceLabel(event.source || event.task_type)}`));
      const result = element("div", "event-preview-result");
      const resultLabel = event.prize_name || event.result || event.message || drawStatusLabel(event.status);
      const resultName = element("strong", quota > 0 ? "is-positive" : "", resultLabel || "--");
      const amountLabel = quota > 0
        ? `+${formatQuota(quota)} 额度 · ${formatMoney(amountOf(event, "prize_quota"))}`
        : drawStatusLabel(event.status);
      result.append(resultName, element("small", "", amountLabel));
      row.append(copy, result);
      fragment.append(row);
    });
    list.append(fragment);
  }

  function runAmount(run) {
    const quota = safeNumber(run.total_quota ?? run.quota);
    const explicit = Number(run.amount_yuan);
    return Number.isFinite(explicit) && explicit >= 0 ? explicit : quota / quotaPerCny();
  }

  function renderOverviewRuns(runs) {
    const list = $("#overview-run-list");
    const empty = $("#overview-run-empty");
    list.replaceChildren();
    const visible = (Array.isArray(runs) ? runs : []).slice(0, 5);
    empty.hidden = visible.length > 0;
    if (!visible.length) return;

    const fragment = document.createDocumentFragment();
    visible.forEach((run) => {
      const row = element("div", "run-row");
      const name = element("div", "run-name");
      name.append(element("strong", "", sourceLabel(run.source || run.task_type)));
      name.append(element("small", "", relativeTime(run.finished_at || run.started_at)));
      const trigger = element("div", "run-meta");
      trigger.append(element("strong", "", triggerLabel(run.trigger)));
      trigger.append(element("small", "", "触发方式"));
      const accounts = element("div", "run-meta");
      accounts.append(element("strong", "", `${safeInteger(run.account_count)} 个账号`));
      accounts.append(element("small", "", `${safeInteger(run.successful_draws)} 次成功翻牌`));
      const status = statusChip(run.status, ({ success: "成功", partial: "部分完成", error: "失败", failed: "失败", running: "执行中", queued: "排队中" })[normalizeStatus(run.status)] || "未知");
      const amount = element("div", "run-amount", formatMoney(runAmount(run)));
      row.append(name, trigger, accounts, status, amount);
      fragment.append(row);
    });
    list.append(fragment);
  }

  function filteredAccounts() {
    const accounts = Array.isArray(state.dashboard?.accounts) ? state.dashboard.accounts : [];
    const query = $("#account-search").value.trim().toLocaleLowerCase("zh-CN");
    if (!query) return accounts;
    return accounts.filter((account) => String(account.account_name || "").toLocaleLowerCase("zh-CN").includes(query));
  }

  function renderBalances(payload) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const refreshedAt = payload?.updated_at || new Date().toISOString();
    state.balances = { ...payload, results, refreshedAt };
    const grid = $("#balance-grid");
    const empty = $("#balances-empty");
    const total = $("#balances-total");
    grid.replaceChildren();
    empty.hidden = results.length > 0;
    total.hidden = results.length === 0;
    total.textContent = formatMoney(payload?.balance_yuan);
    $("#balances-updated").textContent = `更新于 ${formatFullDateTime(refreshedAt)} · 成功 ${safeInteger(payload?.succeeded)} / ${safeInteger(payload?.total, results.length)} 个`;
    if (!results.length) return;

    const fragment = document.createDocumentFragment();
    results.forEach((result, index) => {
      const success = result?.ok === true || result?.success === true;
      const card = element("article", `balance-item${success ? "" : " is-error"}`);
      const heading = element("div", "balance-item-heading");
      heading.append(accountIdentity(result, index, success ? "实时额度" : "读取异常"));
      heading.append(statusChip(success ? "success" : "failed", success ? "已更新" : "失败"));
      const amount = element("div", "balance-amount");
      if (success) {
        amount.append(element("strong", "", formatMoney(result.balance_yuan)));
        amount.append(element("small", "", `${formatQuota(result.balance_quota)} 额度`));
      } else {
        amount.append(element("strong", "", "--"));
        amount.append(element("small", "", result.message || "无法读取额度"));
      }
      const timestamp = result.updated_at || result.checked_at || refreshedAt;
      const time = element("time", "balance-updated", `更新于 ${formatFullDateTime(timestamp)}`);
      if (validTimestamp(timestamp)) time.dateTime = new Date(timestamp).toISOString();
      card.append(heading, amount, time);
      fragment.append(card);
    });
    grid.append(fragment);
  }

  function drawStatusLabel(status) {
    return ({
      success: "成功",
      completed: "成功",
      cooldown: "冷却中",
      failed: "失败",
      error: "失败",
      auth: "认证异常",
      running: "执行中",
      queued: "排队中",
    })[normalizeStatus(status)] || "未知";
  }

  function renderAccounts() {
    const accounts = filteredAccounts();
    const allAccounts = Array.isArray(state.dashboard?.accounts) ? state.dashboard.accounts : [];
    const body = $("#account-table-body");
    const empty = $("#accounts-empty");
    body.replaceChildren();
    $("#accounts-summary").textContent = accounts.length === allAccounts.length
      ? `${allAccounts.length} 个账号`
      : `显示 ${accounts.length} / ${allAccounts.length} 个账号`;
    empty.hidden = accounts.length > 0;
    if (!accounts.length) return;

    const fragment = document.createDocumentFragment();
    accounts.forEach((account, index) => {
      const row = document.createElement("tr");
      const name = setCellLabel(document.createElement("td"), "账号");
      const subtitle = account.configured === false
        ? "历史记录 · 已移出当前配置"
        : account.account_key
          ? `标识 ${String(account.account_key).slice(0, 8)}`
          : "脱敏账号";
      name.append(accountIdentity(account, index, subtitle));
      row.append(name);
      for (const [type, label] of [["checkin", "签到"], ["quiz", "答题"], ["ad", "视频"]]) {
        const cell = setCellLabel(document.createElement("td"), label);
        cell.append(taskChipForAccount(account, type));
        row.append(cell);
      }
      const todayDraws = setCellLabel(document.createElement("td"), "今日翻牌");
      todayDraws.className = "number-column";
      todayDraws.textContent = formatQuota(account.today_draws);
      const draws = setCellLabel(document.createElement("td"), "累计翻牌");
      draws.className = "number-column";
      draws.textContent = formatQuota(account.total_draws);
      const wins = setCellLabel(document.createElement("td"), "中奖");
      wins.className = "number-column";
      wins.append(element("strong", "account-win-count", formatQuota(account.total_wins)));
      wins.append(element("small", "account-win-rate", formatRate(account.total_wins, account.total_draws)));
      const totalQuota = safeNumber(account.total_quota);
      const totalAmount = Number.isFinite(Number(account.amount_yuan))
        ? Number(account.amount_yuan)
        : totalQuota / quotaPerCny();
      const total = setCellLabel(document.createElement("td"), "累计收入");
      total.className = "number-column";
      total.append(moneyBlock(totalAmount, totalQuota));
      const recent = setCellLabel(document.createElement("td"), "最近翻牌");
      recent.className = "draw-recency";
      const lastAt = account.last_draw_at || account.last_event_at;
      const lastStatus = account.last_draw_status || account.last_status;
      const recentCopy = element("span", "draw-recency-copy");
      recentCopy.append(element("strong", "", formatDateTime(lastAt, "暂无记录")));
      recentCopy.append(element("small", "", relativeTime(lastAt)));
      recent.append(recentCopy);
      if (lastAt || lastStatus) recent.append(statusChip(lastStatus, drawStatusLabel(lastStatus)));
      const action = setCellLabel(document.createElement("td"), "操作");
      const historyButton = element("button", "table-action", "翻牌记录");
      historyButton.type = "button";
      historyButton.dataset.historyAccount = account.account_key || "";
      historyButton.disabled = !account.account_key;
      action.append(historyButton);
      row.append(todayDraws, draws, wins, total, recent, action);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function renderRunsTable(runs) {
    const body = $("#run-table-body");
    const empty = $("#runs-empty");
    body.replaceChildren();
    const items = Array.isArray(runs) ? runs : [];
    empty.hidden = items.length > 0;
    if (!items.length) return;

    const fragment = document.createDocumentFragment();
    items.forEach((run) => {
      const row = document.createElement("tr");
      const values = [
        ["时间", formatDateTime(run.finished_at || run.started_at)],
        ["任务", sourceLabel(run.source || run.task_type)],
        ["触发方式", triggerLabel(run.trigger)],
      ];
      values.forEach(([label, value]) => {
        const cell = setCellLabel(document.createElement("td"), label);
        cell.textContent = value;
        row.append(cell);
      });
      const status = setCellLabel(document.createElement("td"), "状态");
      const normalized = normalizeStatus(run.status);
      status.append(statusChip(normalized, ({ success: "成功", partial: "部分完成", error: "失败", failed: "失败", running: "执行中", queued: "排队中" })[normalized] || "未知"));
      const accountCount = setCellLabel(document.createElement("td"), "账号");
      accountCount.className = "number-column";
      accountCount.textContent = String(safeInteger(run.account_count));
      const income = setCellLabel(document.createElement("td"), "收入");
      income.className = "number-column";
      income.append(moneyBlock(runAmount(run), safeNumber(run.total_quota ?? run.quota)));
      row.append(status, accountCount, income);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function renderEventsTable() {
    const events = Array.isArray(state.eventHistory.items) ? state.eventHistory.items : [];
    const body = $("#event-table-body");
    const empty = $("#events-empty");
    body.replaceChildren();
    empty.querySelector("p").textContent = "暂无匹配事件";
    empty.hidden = events.length > 0;
    if (!events.length) return;

    const fragment = document.createDocumentFragment();
    events.forEach((event) => {
      const row = document.createElement("tr");
      const source = event.source || event.task_type;
      const resultText = event.prize_name || event.result || event.message || ({ success: "成功", cooldown: "冷却", error: "失败", auth: "认证异常" })[event.status] || "--";
      const quota = safeNumber(event.quota ?? event.prize_quota);
      const amount = Number.isFinite(Number(event.amount_yuan)) ? Number(event.amount_yuan) : quota / quotaPerCny();
      const values = [
        ["时间", formatDateTime(event.occurred_at || event.created_at)],
        ["账号", event.account_name || "未知账号"],
        ["来源", sourceLabel(source)],
        ["结果", resultText],
      ];
      values.forEach(([label, value]) => {
        const cell = setCellLabel(document.createElement("td"), label);
        cell.textContent = value;
        row.append(cell);
      });
      const quotaCell = setCellLabel(document.createElement("td"), "额度");
      quotaCell.className = "number-column";
      quotaCell.textContent = formatQuota(quota);
      const amountCell = setCellLabel(document.createElement("td"), "收入");
      amountCell.className = "number-column";
      amountCell.textContent = formatMoney(amount);
      const bonusCell = setCellLabel(document.createElement("td"), "加成");
      bonusCell.className = "number-column";
      const bonus = safeNumber(event.bonus_percent);
      bonusCell.textContent = bonus ? `${formatQuota(bonus)}%` : "--";
      row.append(quotaCell, amountCell, bonusCell);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function populateEventAccountFilter() {
    const select = $("#event-account-filter");
    const selected = select.value;
    const accounts = Array.isArray(state.dashboard?.accounts) ? state.dashboard.accounts : [];
    select.replaceChildren(new Option("全部账号", ""));
    accounts.forEach((account, index) => {
      if (!account.account_key) return;
      select.append(new Option(account.account_name || `账号 ${index + 1}`, account.account_key));
    });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

  function eventFilters() {
    return {
      accountKey: $("#event-account-filter").value,
      source: $("#event-source-filter").value,
      from: $("#event-from-filter").value,
      to: $("#event-to-filter").value,
    };
  }

  function renderEventPagination() {
    const pagination = state.eventHistory.pagination;
    const page = Math.max(1, safeInteger(pagination.page, 1));
    const totalPages = safeInteger(pagination.total_pages);
    const total = safeInteger(pagination.total);
    $("#events-total-note").textContent = total ? `共 ${formatQuota(total)} 条记录` : "没有匹配记录";
    $("#events-pagination").hidden = totalPages <= 1;
    $("#events-page-info").textContent = `第 ${page} / ${Math.max(1, totalPages)} 页`;
    $("#events-prev-page").disabled = state.eventHistory.loading || page <= 1;
    $("#events-next-page").disabled = state.eventHistory.loading || !totalPages || page >= totalPages;
  }

  function renderEventsLoading() {
    const body = $("#event-table-body");
    const row = document.createElement("tr");
    const cell = setCellLabel(document.createElement("td"), "状态");
    cell.className = "table-loading";
    cell.colSpan = 7;
    cell.textContent = "正在读取完整记录…";
    row.append(cell);
    body.replaceChildren(row);
    $("#events-empty").hidden = true;
    $("#events-pagination").hidden = true;
    $("#events-total-note").textContent = "正在读取完整记录";
  }

  async function loadEventHistory({ page = 1 } = {}) {
    const filters = eventFilters();
    if (filters.from && filters.to && filters.from > filters.to) {
      showToast("起始日期不能晚于结束日期", "warning");
      return;
    }
    const version = state.eventHistory.requestVersion + 1;
    state.eventHistory.requestVersion = version;
    state.eventHistory.loading = true;
    renderEventsLoading();
    const params = new URLSearchParams({ page: String(Math.max(1, safeInteger(page, 1))), page_size: "25" });
    if (filters.accountKey) params.set("account_key", filters.accountKey);
    if (filters.source) params.set("source", filters.source);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    try {
      const payload = await request(`${API.history}?${params}`);
      if (version !== state.eventHistory.requestVersion) return;
      const pagination = payload?.pagination && typeof payload.pagination === "object" ? payload.pagination : {};
      state.eventHistory.items = Array.isArray(payload?.items) ? payload.items : [];
      state.eventHistory.pagination = {
        page: Math.max(1, safeInteger(pagination.page, page)),
        page_size: Math.max(1, safeInteger(pagination.page_size, 25)),
        total: safeInteger(pagination.total),
        total_pages: safeInteger(pagination.total_pages),
      };
      state.eventHistory.loaded = true;
      state.eventHistory.loading = false;
      renderEventsTable();
      renderEventPagination();
    } catch (error) {
      if (version !== state.eventHistory.requestVersion) return;
      state.eventHistory.items = [];
      state.eventHistory.pagination = { page: 1, page_size: 25, total: 0, total_pages: 0 };
      const empty = $("#events-empty");
      empty.querySelector("p").textContent = `记录读取失败：${error.message}`;
      empty.hidden = false;
      $("#event-table-body").replaceChildren();
      $("#events-total-note").textContent = "完整记录暂不可用";
      $("#events-pagination").hidden = true;
    } finally {
      if (version === state.eventHistory.requestVersion) state.eventHistory.loading = false;
    }
  }

  function renderDashboard(payload) {
    const dashboard = payload && typeof payload === "object" ? payload : EMPTY_DASHBOARD;
    state.dashboard = {
      ...EMPTY_DASHBOARD,
      ...dashboard,
      conversion: { ...EMPTY_DASHBOARD.conversion, ...(dashboard.conversion || {}) },
      income: dashboard.income || {},
      accounts: Array.isArray(dashboard.accounts) ? dashboard.accounts : [],
      schedules: Array.isArray(dashboard.schedules) ? dashboard.schedules : [],
      trend: Array.isArray(dashboard.trend) ? dashboard.trend : [],
      recent_runs: Array.isArray(dashboard.recent_runs) ? dashboard.recent_runs : [],
      recent_events: Array.isArray(dashboard.recent_events) ? dashboard.recent_events : [],
    };
    $("#overview-updated").textContent = validTimestamp(state.dashboard.as_of)
      ? `数据更新于 ${formatFullDateTime(state.dashboard.as_of)}`
      : "尚未收到更新时间";
    renderIncome(state.dashboard.income, state.dashboard.totals, state.dashboard.accounts);
    renderAutomationPause(state.dashboard.automation_paused === true);
    renderTodayTasks(state.dashboard.accounts);
    renderSchedules(state.dashboard.schedules);
    renderTrend(state.dashboard.trend);
    renderOverviewRuns(state.dashboard.recent_runs);
    renderOverviewEvents(state.dashboard.recent_events);
    renderAccounts();
    renderRunsTable(state.dashboard.recent_runs);
    populateEventAccountFilter();
    if (!$("#manual-dialog").open) populateManualAccounts();
    if (state.dashboard.configuration_error) {
      showPageError(`账号配置提示：${state.dashboard.configuration_error}`);
    }
  }

  async function loadDashboard({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const refreshButton = $("#refresh-button");
    refreshButton.disabled = true;
    refreshButton.classList.add("is-loading");
    if (!silent) clearPageError();
    try {
      const data = await request(`${API.dashboard}?t=${Date.now()}`);
      renderDashboard(data);
      setConnection("connected", "D1 已连接");
    } catch (error) {
      setConnection("error", "D1 连接异常");
      if (!state.dashboard) renderDashboard(EMPTY_DASHBOARD);
      if (!silent) showPageError(`数据加载失败：${error.message}`);
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-loading");
    }
  }

  function activateTab(tabName, moveFocus = false) {
    const tab = VALID_TABS.has(tabName) ? tabName : "overview";
    state.activeTab = tab;
    $$("[role='tab']").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tab}`;
    });
    history.replaceState(null, "", `#${tab}`);
    if (moveFocus) $(`#panel-${tab}`).focus({ preventScroll: true });
    if (tab === "settings") prepareSettingsView();
    if (tab === "records" && !state.eventHistory.loaded && !state.eventHistory.loading) loadEventHistory();
  }

  function updateAdminUi() {
    const authenticated = Boolean(state.adminToken);
    $("#admin-button-label").textContent = authenticated ? "自动化设置" : "设置 / 登录";
    $("#logout-button").hidden = !authenticated;
  }

  function clearAdminSession(message) {
    state.adminToken = "";
    state.adminSettings = null;
    state.afterLogin = null;
    writeSessionToken("");
    updateAdminUi();
    $("#settings-form").hidden = true;
    $("#settings-locked").hidden = false;
    $("#save-settings-button").disabled = true;
    if (message) showToast(message, "warning");
  }

  function openLogin(afterLogin = "settings") {
    state.afterLogin = afterLogin;
    $("#login-error").hidden = true;
    $("#admin-token-input").value = "";
    $("#login-dialog").showModal();
    window.setTimeout(() => $("#admin-token-input").focus(), 0);
  }

  async function loadAdminSettings({ announce = false } = {}) {
    if (!state.adminToken) return false;
    try {
      const payload = await request(API.settings, { admin: true });
      state.adminSettings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
      fillSettingsForm(state.adminSettings);
      $("#settings-locked").hidden = true;
      $("#settings-form").hidden = false;
      $("#save-settings-button").disabled = false;
      updateAdminUi();
      if (announce) showToast("管理员登录成功");
      return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearAdminSession();
      }
      throw error;
    }
  }

  async function prepareSettingsView() {
    if (!state.adminToken) {
      $("#settings-form").hidden = true;
      $("#settings-locked").hidden = false;
      $("#save-settings-button").disabled = true;
      return;
    }
    if (state.adminSettings) {
      $("#settings-locked").hidden = true;
      $("#settings-form").hidden = false;
      $("#save-settings-button").disabled = false;
      return;
    }
    try {
      await loadAdminSettings();
    } catch (error) {
      showToast(`设置加载失败：${error.message}`, "error");
    }
  }

  function settingSection(settings, ...names) {
    for (const name of names) {
      const value = settings?.[name];
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }
    return {};
  }

  function setField(name, value) {
    const field = $(`[name="${name}"]`, $("#settings-form"));
    if (!field) return;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else if (value !== undefined && value !== null) field.value = String(value);
  }

  function fillSettingsForm(settings) {
    const checkin = settingSection(settings, "checkin");
    const draw = settingSection(settings, "draw", "regular_draw");
    const quiz = settingSection(settings, "quiz");
    const ad = settingSection(settings, "ad", "video");
    const notifications = settingSection(settings, "notifications");
    setField("automation_enabled", settings.automation_enabled ?? true);
    setField("timezone", settings.timezone || "Asia/Shanghai");
    setField("checkin_enabled", checkin.enabled ?? true);
    setField("checkin_time", checkin.daily_at || checkin.time || "00:10");
    setField("draw_enabled", draw.enabled ?? true);
    setField("draw_anchor", draw.anchor_local || draw.anchor || draw.anchor_time || "00:20");
    setField("draw_every_minutes", draw.every_minutes ?? 120);
    setField("draw_count", draw.draw_count ?? 1);
    setField("quiz_enabled", quiz.enabled ?? true);
    setField("quiz_time", quiz.daily_at || quiz.time || "00:15");
    setField("ad_enabled", ad.enabled ?? true);
    setField("ad_anchor", ad.anchor_local || ad.anchor || ad.anchor_time || "01:00");
    setField("ad_poll_minutes", ad.every_minutes ?? ad.poll_minutes ?? ad.poll_every_minutes ?? 120);
    setField("ad_daily_limit", ad.daily_limit ?? 3);
    setField("quiz_reward_draw", quiz.draw_after_success ?? true);
    setField("ad_reward_draw", ad.draw_after_claim ?? true);
    setField("share_bonus", draw.share_bonus ?? true);
    setField("notifications_enabled", notifications.enabled ?? false);
    setField("notifications_errors_only", notifications.errors_only ?? false);
    setField("notifications_checkin", notifications.checkin ?? true);
    setField("notifications_draw", notifications.draw ?? true);
    setField("notifications_task_error", notifications.task_error ?? true);
    setField("notifications_webhook", "");
    setField("notifications_clear_webhook", false);
    const webhookStatus = $("#notification-webhook-status");
    webhookStatus.textContent = notifications.webhook_configured
      ? "已配置通知地址。输入新地址可替换，留空则保持不变。"
      : "尚未配置通知地址；启用通知前请填写 HTTPS Webhook。";
    webhookStatus.classList.toggle("is-configured", Boolean(notifications.webhook_configured));
    updateDrawSettingHelp();
    updateWebhookFields();
  }

  function accountSupports(account, action) {
    const explicit = account?.capabilities?.[action];
    if (typeof explicit === "boolean") return explicit;
    if (action === "checkin") return account?.configured !== false;
    return account?.is_vsllm !== false;
  }

  function taskChipForAccount(account, type) {
    if (!accountSupports(account, type)) {
      return statusChip("idle", "不适用", "该站点只参与普通签到任务。 ");
    }
    return taskChip(account.tasks?.[type], type);
  }

  function updateDrawSettingHelp() {
    const interval = numberField("draw_every_minutes", 120, 60, 720);
    const count = numberField("draw_count", 1, 1, 3);
    const hours = interval / 60;
    const intervalLabel = Number.isInteger(hours) ? `${hours} 小时` : `${interval} 分钟`;
    const help = $("#draw-setting-help");
    if (help) help.textContent = `当前计划：从起始时间起每 ${intervalLabel}，每账号最多翻牌 ${count} 次。`;
  }

  function updateWebhookFields() {
    const clear = checkboxField("notifications_clear_webhook");
    const input = $("[name='notifications_webhook']", $("#settings-form"));
    if (!input) return;
    input.disabled = clear;
    if (clear) input.value = "";
  }

  function numberField(name, fallback, minimum, maximum) {
    const field = $(`[name="${name}"]`, $("#settings-form"));
    const number = Math.trunc(Number(field.value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function checkboxField(name) {
    return Boolean($(`[name="${name}"]`, $("#settings-form"))?.checked);
  }

  function serializeSettings() {
    const form = $("#settings-form");
    const webhook = $("[name='notifications_webhook']", form).value.trim();
    const notifications = {
      enabled: checkboxField("notifications_enabled"),
      errors_only: checkboxField("notifications_errors_only"),
      checkin: checkboxField("notifications_checkin"),
      draw: checkboxField("notifications_draw"),
      task_error: checkboxField("notifications_task_error"),
    };
    if (webhook) notifications.webhook = webhook;
    if (checkboxField("notifications_clear_webhook")) notifications.clear_webhook = true;
    return {
      schema_version: 1,
      automation_enabled: checkboxField("automation_enabled"),
      timezone: $("[name='timezone']", form).value || "Asia/Shanghai",
      checkin: {
        enabled: checkboxField("checkin_enabled"),
        daily_at: $("[name='checkin_time']", form).value || "00:10",
      },
      draw: {
        enabled: checkboxField("draw_enabled"),
        anchor_local: $("[name='draw_anchor']", form).value || "00:20",
        every_minutes: numberField("draw_every_minutes", 120, 60, 720),
        draw_count: numberField("draw_count", 1, 1, 3),
        share_bonus: checkboxField("share_bonus"),
      },
      quiz: {
        enabled: checkboxField("quiz_enabled"),
        daily_at: $("[name='quiz_time']", form).value || "00:15",
        draw_after_success: checkboxField("quiz_reward_draw"),
      },
      ad: {
        enabled: checkboxField("ad_enabled"),
        anchor_local: $("[name='ad_anchor']", form).value || "01:00",
        every_minutes: numberField("ad_poll_minutes", 120, 60, 720),
        daily_limit: numberField("ad_daily_limit", 3, 1, 3),
        draw_after_claim: checkboxField("ad_reward_draw"),
      },
      notifications,
    };
  }

  function eligibleManualAccounts(action = $("#manual-action")?.value || "draw") {
    const accounts = (Array.isArray(state.dashboard?.accounts) ? state.dashboard.accounts : [])
      .filter((account) => account.configured !== false);
    return ["draw", "quiz", "ad"].includes(action)
      ? accounts.filter((account) => accountSupports(account, action))
      : accounts;
  }

  function populateManualAccounts() {
    const list = $("#manual-account-list");
    list.replaceChildren();
    const accounts = eligibleManualAccounts();
    if (!accounts.length) {
      list.append(element("p", "panel-note", "当前没有可选择的账号"));
      return;
    }
    const fragment = document.createDocumentFragment();
    accounts.forEach((account, index) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = account.account_key || "";
      input.dataset.accountName = account.account_name || `账号 ${index + 1}`;
      input.addEventListener("change", updateManualSummary);
      label.append(input, element("span", "", input.dataset.accountName));
      fragment.append(label);
    });
    list.append(fragment);
  }

  function selectedManualAccounts() {
    const scope = $("input[name='account_scope']:checked", $("#manual-form"))?.value || "all";
    if (scope === "all") return ["all"];
    return $$("#manual-account-list input:checked").map((input) => input.value).filter(Boolean);
  }

  function updateManualSummary() {
    const action = $("#manual-action").value;
    const actionName = sourceLabel(action);
    const scope = $("input[name='account_scope']:checked", $("#manual-form"))?.value || "all";
    const selected = selectedManualAccounts();
    const configuredAccounts = eligibleManualAccounts(action);
    const allCount = configuredAccounts.length;
    const count = scope === "all" ? allCount : selected.length;
    const drawCount = Math.max(1, Math.min(3, safeInteger($("#manual-draw-count").value, 1)));
    const drawCountField = $("#draw-count-field");
    const drawCountInput = $("#manual-draw-count");
    drawCountField.hidden = action !== "draw";
    drawCountInput.disabled = action !== "draw";
    const settings = state.adminSettings || state.dashboard?.settings || {};
    const drawSettings = settingSection(settings, "draw", "regular_draw");
    const quizSettings = settingSection(settings, "quiz");
    const adSettings = settingSection(settings, "ad", "video");
    const bonusText = drawSettings.share_bonus === false ? "不激活 50% 分享加成" : "翻牌前激活 50% 分享加成";
    const rewardHint = action === "quiz"
      ? (quizSettings.draw_after_success === false
          ? "只完成答题，不自动翻奖励牌。"
          : `答题首次成功后立即翻牌 1 次，并${bonusText}。`)
      : action === "ad"
        ? (adSettings.draw_after_claim === false
            ? "只完成一次当前可用视频任务，不自动翻奖励牌。"
            : `视频奖励领取成功后立即翻牌 1 次，并${bonusText}。`)
        : action === "draw"
          ? `每个账号计划翻牌 ${drawCount} 次，${bonusText}。`
          : action === "all"
            ? `所有账号执行签到；仅 VSLLM 账号执行答题、一次当前可用视频任务和额外常规翻牌 1 次。答题和视频新完成时${quizSettings.draw_after_success === false && adSettings.draw_after_claim === false ? "不追加奖励翻牌" : "还可能追加奖励翻牌"}。${bonusText}。`
            : "只执行签到，不额外修改账号配置。";
    $("#manual-summary").textContent = `准备对 ${count} 个账号执行“${actionName}”。${rewardHint}`;
  }

  function openManualDialog() {
    if (!state.adminToken) {
      openLogin("manual");
      return;
    }
    $("#manual-form").reset();
    delete $("#manual-form").dataset.idempotencyKey;
    $("#manual-action").value = "draw";
    $("#manual-draw-count").value = "1";
    populateManualAccounts();
    $("#manual-error").hidden = true;
    $("#manual-account-list").hidden = true;
    updateManualSummary();
    $("#manual-dialog").showModal();
  }

  async function submitManualRun(event) {
    event.preventDefault();
    const form = $("#manual-form");
    if (!form.reportValidity()) return;
    const accounts = selectedManualAccounts();
    if (!accounts.length) {
      $("#manual-error").textContent = "请至少选择一个账号。";
      $("#manual-error").hidden = false;
      return;
    }
    const submit = $("#manual-submit");
    setBusy(submit, true, "正在提交…");
    $("#manual-error").hidden = true;
    try {
      const action = $("#manual-action").value;
      const idempotencyKey = form.dataset.idempotencyKey || crypto.randomUUID();
      form.dataset.idempotencyKey = idempotencyKey;
      const result = await request(API.run, {
        method: "POST",
        admin: true,
        idempotencyKey,
        body: {
          action,
          account_keys: accounts,
          draw_count: Math.max(1, Math.min(3, safeInteger($("#manual-draw-count").value, 1))),
        },
      });
      delete form.dataset.idempotencyKey;
      $("#manual-dialog").close();
      const statusText = ({ success: "成功", partial: "部分完成", error: "失败" })[result.status] || result.status || "完成";
      const amount = safeNumber(result.total_quota) / quotaPerCny();
      showToast(`手动任务已完成：${statusText}，获得 ${formatMoney(amount)}`,
        result.status === "error" ? "error" : result.status === "partial" ? "warning" : "success");
      await loadDashboard({ silent: true });
    } catch (error) {
      if (error.status >= 400 && error.status < 500) delete form.dataset.idempotencyKey;
      if (error.status === 401 || error.status === 403) {
        clearAdminSession("管理员会话已失效，请重新登录");
        $("#manual-dialog").close();
        openLogin("manual");
      } else {
        $("#manual-error").textContent = `提交失败：${error.message}`;
        $("#manual-error").hidden = false;
      }
    } finally {
      setBusy(submit, false);
    }
  }

  async function refreshBalances() {
    if (!state.adminToken) {
      openLogin("balances");
      return;
    }
    const button = $("#refresh-balances-button");
    setBusy(button, true, "正在更新…");
    try {
      const result = await request(API.balances, {
        method: "POST",
        admin: true,
        body: { account_keys: ["all"] },
      });
      renderBalances(result);
      showToast(`额度已更新：成功 ${safeInteger(result.succeeded)} 个，失败 ${safeInteger(result.failed)} 个，合计 ${formatMoney(result.balance_yuan)}`,
        safeInteger(result.failed) > 0 ? "warning" : "success");
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearAdminSession("管理员会话已失效，请重新登录");
        openLogin("balances");
      } else {
        showToast(`额度更新失败：${error.message}`, "error");
      }
    } finally {
      setBusy(button, false);
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const input = $("#admin-token-input");
    const token = input.value.trim().replace(/^token:/u, "");
    if (!token) return;
    const submit = $("#login-submit");
    setBusy(submit, true, "正在验证…");
    $("#login-error").hidden = true;
    state.adminToken = token;
    try {
      await loadAdminSettings({ announce: true });
      writeSessionToken(token);
      input.value = "";
      $("#login-dialog").close();
      const next = state.afterLogin;
      state.afterLogin = null;
      if (next === "manual") openManualDialog();
      else if (next === "balances") refreshBalances();
      else activateTab("settings", true);
    } catch (error) {
      state.adminToken = "";
      writeSessionToken("");
      $("#login-error").textContent = `登录失败：${error.message}`;
      $("#login-error").hidden = false;
    } finally {
      setBusy(submit, false);
      updateAdminUi();
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = $("#settings-form");
    if (!form.reportValidity()) return;
    const button = $("#save-settings-button");
    setBusy(button, true, "正在保存…");
    try {
      const payload = serializeSettings();
      const result = await request(API.settings, { method: "PUT", admin: true, body: payload });
      state.adminSettings = result.settings && typeof result.settings === "object" ? result.settings : payload;
      fillSettingsForm(state.adminSettings);
      showToast("自动化设置已保存");
      await loadDashboard({ silent: true });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearAdminSession("管理员会话已失效，请重新登录");
        openLogin("settings");
      } else {
        showToast(`设置保存失败：${error.message}`, "error");
      }
    } finally {
      setBusy(button, false);
      button.disabled = !state.adminToken;
    }
  }

  function bindEvents() {
    $$("[role='tab']").forEach((button) => {
      button.addEventListener("click", () => activateTab(button.dataset.tab, true));
      button.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = $$("[role='tab']");
        const current = tabs.indexOf(button);
        let next = current;
        if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        tabs[next].focus();
        activateTab(tabs[next].dataset.tab);
      });
    });
    $$('[data-open-tab]').forEach((button) => {
      button.addEventListener("click", () => activateTab(button.dataset.openTab, true));
    });
    $$('[data-close-dialog]').forEach((button) => {
      button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close());
    });
    $("#refresh-button").addEventListener("click", () => loadDashboard());
    $("#page-message-retry").addEventListener("click", () => loadDashboard());
    $("#manual-button").addEventListener("click", openManualDialog);
    $("#admin-button").addEventListener("click", () => {
      if (state.adminToken) activateTab("settings", true);
      else openLogin("settings");
    });
    $("#settings-login-button").addEventListener("click", () => openLogin("settings"));
    $("#logout-button").addEventListener("click", () => clearAdminSession("已退出管理员模式"));
    $("#login-form").addEventListener("submit", submitLogin);
    $("#manual-form").addEventListener("submit", submitManualRun);
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#refresh-balances-button").addEventListener("click", refreshBalances);
    $("#account-search").addEventListener("input", renderAccounts);
    $("#account-table-body").addEventListener("click", (event) => {
      const button = event.target.closest("[data-history-account]");
      if (!button || !button.dataset.historyAccount) return;
      $("#event-account-filter").value = button.dataset.historyAccount;
      $("#event-source-filter").value = "draw";
      $("#event-from-filter").value = "";
      $("#event-to-filter").value = "";
      loadEventHistory({ page: 1 });
      activateTab("records", true);
      window.requestAnimationFrame(() => $("#events-title").scrollIntoView({ block: "start", behavior: "smooth" }));
    });
    $("#event-filter-form").addEventListener("submit", (event) => {
      event.preventDefault();
      loadEventHistory({ page: 1 });
    });
    $("#event-filter-reset").addEventListener("click", () => {
      $("#event-filter-form").reset();
      loadEventHistory({ page: 1 });
    });
    $("#events-prev-page").addEventListener("click", () => {
      loadEventHistory({ page: Math.max(1, safeInteger(state.eventHistory.pagination.page, 1) - 1) });
    });
    $("#events-next-page").addEventListener("click", () => {
      loadEventHistory({ page: safeInteger(state.eventHistory.pagination.page, 1) + 1 });
    });
    $("[name='draw_every_minutes']", $("#settings-form")).addEventListener("change", updateDrawSettingHelp);
    $("[name='draw_count']", $("#settings-form")).addEventListener("input", updateDrawSettingHelp);
    $("[name='notifications_clear_webhook']", $("#settings-form")).addEventListener("change", updateWebhookFields);
    $("#manual-action").addEventListener("change", () => {
      populateManualAccounts();
      updateManualSummary();
    });
    $("#manual-draw-count").addEventListener("input", updateManualSummary);
    $$("input[name='account_scope']", $("#manual-form")).forEach((radio) => {
      radio.addEventListener("change", () => {
        $("#manual-account-list").hidden = radio.value !== "selected" || !radio.checked;
        updateManualSummary();
      });
    });
    window.addEventListener("hashchange", () => {
      const tab = location.hash.slice(1);
      if (VALID_TABS.has(tab) && tab !== state.activeTab) activateTab(tab);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.dashboard && Date.now() - Date.parse(state.dashboard.as_of || 0) > 60000) {
        loadDashboard({ silent: true });
      }
    });
  }

  function init() {
    bindEvents();
    updateAdminUi();
    showLoadingPlaceholders();
    const initialTab = location.hash.slice(1);
    activateTab(VALID_TABS.has(initialTab) ? initialTab : "overview");
    loadDashboard();
    window.setInterval(() => {
      if (!document.hidden) loadDashboard({ silent: true });
    }, 60000);
  }

  init();
})();

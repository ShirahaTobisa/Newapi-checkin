(() => {
  "use strict";

  const API_URL = "https://newapi-sync.mornye.uk/api/gwent/history";
  const MAX_VISIBLE_EVENTS = 100;
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const compactFormat = new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const state = { data: null, loading: false };

  const byId = (id) => document.getElementById(id);
  const elements = {
    refresh: byId("refresh-button"),
    retry: byId("retry-button"),
    errorBanner: byId("error-banner"),
    errorMessage: byId("error-message"),
    freshness: byId("freshness-badge"),
    updatedAt: byId("updated-at"),
    accountFilter: byId("account-filter"),
    statusFilter: byId("status-filter"),
  };

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function formatNumber(value) {
    return numberFormat.format(safeNumber(value));
  }

  function formatQuota(value) {
    const quota = safeNumber(value);
    return quota >= 10000 ? compactFormat.format(quota) : numberFormat.format(quota);
  }

  function formatPercent(wins, draws) {
    if (!draws) return "0%";
    return `${((wins / draws) * 100).toFixed(wins === draws ? 0 : 1)}%`;
  }

  function formatDateTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return "--";
    return dateTimeFormat.format(new Date(value)).replace("24:", "00:");
  }

  function statusLabel(status) {
    return ({
      success: "成功",
      cooldown: "冷却",
      auth: "认证异常",
      error: "异常",
      partial: "部分完成",
    })[status] || "暂无运行";
  }

  function rarityLabel(rarity) {
    return ({
      common: "普通",
      rare: "稀有",
      epic: "史诗",
      legendary: "传说",
      unknown: "--",
    })[rarity] || "--";
  }

  function taskTypeLabel(taskType) {
    return ({
      gwent: "常规",
      quiz: "答题",
      ad: "视频",
    })[taskType || "gwent"] || "其他";
  }

  function renderIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function setLoading(loading) {
    state.loading = loading;
    elements.refresh.disabled = loading;
    elements.refresh.classList.toggle("is-loading", loading);
    document.querySelectorAll(".metric-panel").forEach((panel) => {
      panel.classList.toggle("is-loading", loading && state.data === null);
    });
  }

  function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorBanner.hidden = false;
  }

  function clearError() {
    elements.errorBanner.hidden = true;
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function updateFreshness(updatedAt) {
    const parsed = updatedAt ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(parsed)) {
      elements.freshness.className = "status-badge status-idle";
      elements.freshness.textContent = "等待首条记录";
      elements.updatedAt.textContent = "尚未更新";
      return;
    }
    const stale = Date.now() - parsed > 3 * 60 * 60 * 1000;
    elements.freshness.className = `status-badge ${stale ? "status-stale" : "status-success"}`;
    elements.freshness.textContent = stale ? "数据可能过期" : "数据正常";
    elements.updatedAt.textContent = `更新于 ${formatDateTime(updatedAt)}`;
  }

  function renderMetrics(data) {
    const totals = data.totals || {};
    setText("metric-draws", formatNumber(totals.total_draws));
    setText("metric-runs", `${formatNumber(totals.total_runs)} 次任务`);
    setText("metric-quota", formatQuota(totals.total_quota));
    setText("metric-win-rate", formatPercent(totals.total_wins, totals.total_draws));
    setText("metric-wins", `${formatNumber(totals.total_wins)} 次获得额度`);
    setText("metric-accounts", formatNumber(totals.total_accounts));
  }

  function createStatusBadge(status) {
    const badge = document.createElement("span");
    badge.className = `status-badge status-${status || "idle"}`;
    badge.textContent = statusLabel(status);
    return badge;
  }

  function renderAccounts(accounts) {
    const tbody = byId("accounts-body");
    const empty = byId("accounts-empty");
    tbody.replaceChildren();
    setText("accounts-count", `${formatNumber(accounts.length)} 个账号`);
    empty.hidden = accounts.length > 0;
    tbody.closest(".table-scroll").hidden = accounts.length === 0;

    const fragment = document.createDocumentFragment();
    accounts.forEach((account, index) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.innerHTML = `<span class="account-name"><span class="account-index">${index + 1}</span><span></span></span>`;
      nameCell.querySelector(".account-name span:last-child").textContent = account.account_name || `账号${index + 1}`;
      row.append(nameCell);
      [
        formatNumber(account.total_draws),
        formatNumber(account.total_wins),
        formatPercent(account.total_wins, account.total_draws),
        formatQuota(account.total_quota),
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.className = "number-cell";
        cell.textContent = value;
        row.append(cell);
      });
      const statusCell = document.createElement("td");
      statusCell.append(createStatusBadge(account.last_status));
      row.append(statusCell);
      fragment.append(row);
    });
    tbody.append(fragment);
  }

  function nextCronWindow(now = new Date()) {
    const candidate = new Date(now);
    candidate.setUTCMinutes(0, 0, 0);
    candidate.setUTCHours(Math.floor(candidate.getUTCHours() / 2) * 2);
    if (candidate <= now) candidate.setUTCHours(candidate.getUTCHours() + 2);
    return candidate;
  }

  function nextScheduledRun(now = new Date()) {
    return nextCronWindow(now);
  }

  function renderSchedule(runs) {
    const latest = runs.find((run) => (run.source || "gwent") === "gwent");
    const nextRun = nextScheduledRun();
    setText("next-run", nextRun ? formatDateTime(nextRun.toISOString()) : "--");
    if (!latest) {
      setText("last-run", "--");
      setText("last-run-draws", "--");
      setText("last-run-quota", "--");
      return;
    }
    setText("last-run", formatDateTime(latest.finished_at));
    setText("last-run-draws", `${formatNumber(latest.successful_draws)} 次`);
    setText("last-run-quota", `+${formatQuota(latest.total_quota)}`);
    const status = latest.status === "success" ? "success" : latest.status === "partial" ? "cooldown" : "error";
    const badge = byId("run-status");
    badge.className = `status-badge status-${status}`;
    badge.textContent = latest.status === "partial" ? "部分完成" : statusLabel(status);
  }

  function renderPrizes(prizes) {
    const list = byId("prize-list");
    const empty = byId("prize-empty");
    list.replaceChildren();
    const visible = prizes.slice(0, 6);
    empty.hidden = visible.length > 0;
    if (!visible.length) return;

    const fragment = document.createDocumentFragment();
    visible.forEach((prize) => {
      const row = document.createElement("div");
      row.className = "prize-row";
      const name = document.createElement("span");
      name.className = "prize-name";
      name.textContent = prize.prize_name || "未知奖品";
      const count = document.createElement("span");
      count.className = "prize-count";
      count.textContent = `${formatNumber(prize.total_draws)} 次`;
      const quota = document.createElement("span");
      quota.className = "prize-quota";
      quota.textContent = `+${formatQuota(prize.total_quota)}`;
      row.append(name, count, quota);
      fragment.append(row);
    });
    list.append(fragment);
  }

  function lastFourteenDays(daily) {
    const map = new Map(daily.map((day) => [day.date, day]));
    const output = [];
    const beijingToday = new Date(Date.now() + 8 * 60 * 60 * 1000);
    beijingToday.setUTCHours(0, 0, 0, 0);
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(beijingToday);
      date.setUTCDate(date.getUTCDate() - offset);
      const key = date.toISOString().slice(0, 10);
      output.push(map.get(key) || { date: key, total_quota: 0, total_draws: 0 });
    }
    return output;
  }

  function renderTrend(daily) {
    const chart = byId("trend-chart");
    const empty = byId("trend-empty");
    chart.replaceChildren();
    if (!daily.length) {
      chart.hidden = true;
      empty.hidden = false;
      return;
    }
    chart.hidden = false;
    empty.hidden = true;
    const days = lastFourteenDays(daily);
    const max = Math.max(...days.map((day) => safeNumber(day.total_quota)), 1);
    const fragment = document.createDocumentFragment();
    days.forEach((day) => {
      const column = document.createElement("div");
      column.className = "trend-column";
      const wrap = document.createElement("div");
      wrap.className = "trend-bar-wrap";
      const bar = document.createElement("div");
      bar.className = "trend-bar";
      bar.style.height = `${Math.max(2, (safeNumber(day.total_quota) / max) * 100)}%`;
      bar.title = `${day.date}：${formatNumber(day.total_quota)} 额度 / ${formatNumber(day.total_draws)} 次`;
      wrap.append(bar);
      const label = document.createElement("span");
      label.className = "trend-label";
      label.textContent = day.date.slice(5).replace("-", "/");
      column.append(wrap, label);
      fragment.append(column);
    });
    chart.append(fragment);
  }

  function renderFilters(accounts) {
    const selected = elements.accountFilter.value;
    elements.accountFilter.replaceChildren(new Option("全部账号", "all"));
    accounts.forEach((account) => {
      elements.accountFilter.add(new Option(account.account_name, account.account_key));
    });
    if ([...elements.accountFilter.options].some((option) => option.value === selected)) {
      elements.accountFilter.value = selected;
    }
  }

  function renderEvents() {
    const events = state.data?.events || [];
    const account = elements.accountFilter.value;
    const status = elements.statusFilter.value;
    const filtered = events.filter((event) =>
      (account === "all" || event.account_key === account) &&
      (status === "all" || event.status === status),
    ).slice(0, MAX_VISIBLE_EVENTS);

    const tbody = byId("events-body");
    const empty = byId("events-empty");
    const scroll = tbody.closest(".table-scroll");
    tbody.replaceChildren();
    empty.hidden = filtered.length > 0;
    scroll.hidden = filtered.length === 0;
    setText("events-count", `显示 ${formatNumber(filtered.length)} 条`);

    const fragment = document.createDocumentFragment();
    filtered.forEach((event) => {
      const row = document.createElement("tr");
      const time = document.createElement("td");
      time.className = "event-time";
      time.textContent = formatDateTime(event.occurred_at);
      const accountCell = document.createElement("td");
      accountCell.textContent = event.account_name || "未知账号";
      const source = document.createElement("td");
      source.textContent = taskTypeLabel(event.task_type);
      const attempt = document.createElement("td");
      attempt.className = "number-cell";
      attempt.textContent = String(event.attempt || "--");
      const result = document.createElement("td");
      if (event.status === "success") {
        result.className = "event-prize";
        result.textContent = event.prize_name || "未知奖品";
      } else {
        result.className = "event-message";
        result.textContent = statusLabel(event.status);
      }
      const quota = document.createElement("td");
      quota.className = `number-cell ${safeNumber(event.prize_quota) > 0 ? "quota-positive" : ""}`;
      quota.textContent = safeNumber(event.prize_quota) > 0 ? `+${formatNumber(event.prize_quota)}` : "0";
      const rarity = document.createElement("td");
      const rarityBadge = document.createElement("span");
      rarityBadge.className = `rarity-badge rarity-${event.prize_rarity || "unknown"}`;
      rarityBadge.textContent = rarityLabel(event.prize_rarity);
      rarity.append(rarityBadge);
      const bonus = document.createElement("td");
      bonus.className = "number-cell";
      bonus.textContent = safeNumber(event.bonus_percent) ? `+${formatNumber(event.bonus_percent)}%` : "--";
      row.append(time, accountCell, source, attempt, result, quota, rarity, bonus);
      fragment.append(row);
    });
    tbody.append(fragment);
  }

  function render(data) {
    state.data = data;
    updateFreshness(data.updated_at);
    renderMetrics(data);
    renderAccounts(data.accounts || []);
    renderSchedule(data.runs || []);
    renderPrizes(data.prizes || []);
    renderTrend(data.daily || []);
    renderFilters(data.accounts || []);
    renderEvents();
    renderIcons();
  }

  async function loadHistory() {
    if (state.loading) return;
    setLoading(true);
    clearError();
    try {
      const response = await fetch(`${API_URL}?t=${Date.now()}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || data.schema_version !== 1) throw new Error("数据格式不受支持");
      render(data);
    } catch (error) {
      showError(`数据加载失败：${error.message || "未知错误"}`);
      if (!state.data) render({
        schema_version: 1,
        updated_at: null,
        totals: {},
        accounts: [],
        prizes: [],
        events: [],
        runs: [],
        daily: [],
      });
    } finally {
      setLoading(false);
    }
  }

  elements.refresh.addEventListener("click", loadHistory);
  elements.retry.addEventListener("click", loadHistory);
  elements.accountFilter.addEventListener("change", renderEvents);
  elements.statusFilter.addEventListener("change", renderEvents);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.data && Date.now() - Date.parse(state.data.updated_at || 0) > 60_000) {
      loadHistory();
    }
  });

  renderIcons();
  loadHistory();
  window.setInterval(() => {
    if (!document.hidden) loadHistory();
  }, 60_000);
})();

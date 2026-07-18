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
  const beijingDateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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

  function beijingDateKey(now = new Date()) {
    const parts = Object.fromEntries(
      beijingDateFormat.formatToParts(now).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function taskStatusMeta(status, currentDate) {
    if (!currentDate) return { style: "idle", label: "待今日检查" };
    return ({
      completed: { style: "success", label: "已完成" },
      available: { style: "idle", label: "可执行" },
      cooldown: { style: "cooldown", label: "冷却中" },
      pending: { style: "idle", label: "待执行" },
      suspended: { style: "stale", label: "已暂停" },
      error: { style: "error", label: "异常" },
      unknown: { style: "idle", label: "待检查" },
    })[status] || { style: "idle", label: "待检查" };
  }

  function createTaskBadge(item, currentDate) {
    const status = item?.completed ? "completed" : item?.status;
    const meta = taskStatusMeta(status, currentDate);
    const badge = document.createElement("span");
    badge.className = `status-badge status-${meta.style}`;
    badge.textContent = meta.label;
    if (item?.message) badge.title = item.message;
    return badge;
  }

  function taskTimeElement(value, fallback = "--") {
    const element = document.createElement("time");
    const parsed = value ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) {
      element.dateTime = new Date(parsed).toISOString();
      element.textContent = formatDateTime(value);
    } else {
      element.textContent = fallback;
    }
    return element;
  }

  function latestTimestamp(...values) {
    const valid = values
      .filter((value) => value && Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left));
    return valid[0] || null;
  }

  function effectiveAdStatus(item, currentDate, now = Date.now()) {
    if (
      currentDate &&
      item?.status === "cooldown" &&
      !item.completed &&
      Number.isFinite(Date.parse(item.next_available_at)) &&
      Date.parse(item.next_available_at) <= now
    ) {
      return {
        ...item,
        status: "available",
        next_available_at: null,
        message: "视频冷却已结束，等待下一次任务检查",
      };
    }
    return item;
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

  function renderTaskStatuses(taskStatuses) {
    const payload = taskStatuses && typeof taskStatuses === "object"
      ? taskStatuses
      : { local_date: null, updated_at: null, accounts: [] };
    const entries = Array.isArray(payload.accounts) ? payload.accounts : [];
    const today = beijingDateKey();
    const currentDate = payload.local_date === today;
    const tbody = byId("task-status-body");
    const empty = byId("task-status-empty");
    const wrap = byId("task-status-table-wrap");
    tbody.replaceChildren();

    if (!payload.local_date) {
      setText("task-status-date", "等待首次上报");
    } else if (currentDate) {
      setText("task-status-date", `今日 ${payload.local_date}`);
    } else {
      setText("task-status-date", `最近 ${payload.local_date} · 待今日检查`);
    }

    const accounts = new Map();
    entries.forEach((item) => {
      if (!item || typeof item.account_key !== "string") return;
      const existing = accounts.get(item.account_key) || {
        account_key: item.account_key,
        account_name: item.account_name || "未知账号",
        quiz: null,
        ad: null,
      };
      if (item.account_name) existing.account_name = item.account_name;
      if (item.task_type === "quiz" || item.task_type === "ad") {
        const previous = existing[item.task_type];
        if (!previous || Date.parse(item.checked_at || 0) >= Date.parse(previous.checked_at || 0)) {
          existing[item.task_type] = item;
        }
      }
      accounts.set(item.account_key, existing);
    });

    const rows = [...accounts.values()].sort((left, right) =>
      String(left.account_name).localeCompare(String(right.account_name), "zh-CN"),
    );
    empty.hidden = rows.length > 0;
    wrap.hidden = rows.length === 0;
    if (!rows.length) return;

    const fragment = document.createDocumentFragment();
    rows.forEach((account, index) => {
      const row = document.createElement("tr");
      const adStatus = effectiveAdStatus(account.ad, currentDate);

      const nameCell = document.createElement("td");
      nameCell.dataset.label = "账号";
      const name = document.createElement("span");
      name.className = "account-name";
      const accountIndex = document.createElement("span");
      accountIndex.className = "account-index";
      accountIndex.textContent = String(index + 1);
      const accountText = document.createElement("span");
      accountText.textContent = account.account_name;
      name.append(accountIndex, accountText);
      nameCell.append(name);
      nameCell.setAttribute("aria-label", `账号：${account.account_name}`);

      const quizCell = document.createElement("td");
      quizCell.dataset.label = "答题";
      const quizBadge = createTaskBadge(account.quiz, currentDate);
      quizCell.append(quizBadge);
      quizCell.setAttribute("aria-label", `答题：${quizBadge.textContent}`);

      const progressCell = document.createElement("td");
      progressCell.dataset.label = "视频进度";
      progressCell.className = "number-cell";
      const hasAdCount = adStatus && Number.isFinite(Number(adStatus.done_count));
      if (currentDate && hasAdCount) {
        const cap = Math.max(1, Math.min(3, Math.trunc(safeNumber(adStatus.daily_cap) || 3)));
        const done = Math.max(0, Math.min(cap, Math.trunc(safeNumber(adStatus.done_count))));
        const progress = document.createElement("span");
        progress.className = "task-progress";
        const track = document.createElement("span");
        track.className = "task-progress-track";
        const fill = document.createElement("span");
        fill.style.width = `${(done / cap) * 100}%`;
        track.append(fill);
        const value = document.createElement("span");
        value.textContent = `${done}/${cap}`;
        progress.append(track, value);
        progressCell.append(progress);
        progressCell.setAttribute("aria-label", `视频进度：${done}/${cap}`);
      } else {
        progressCell.textContent = "--";
        progressCell.setAttribute("aria-label", "视频进度：待检查");
      }

      const adCell = document.createElement("td");
      adCell.dataset.label = "视频状态";
      const adBadge = createTaskBadge(adStatus, currentDate);
      adCell.append(adBadge);
      adCell.setAttribute("aria-label", `视频状态：${adBadge.textContent}`);

      const nextCell = document.createElement("td");
      nextCell.dataset.label = "下次可看";
      nextCell.className = "task-time";
      if (!currentDate || !adStatus) {
        nextCell.append(taskTimeElement(null));
      } else if (adStatus.completed || adStatus.status === "completed") {
        nextCell.append(taskTimeElement(null, "今日完成"));
      } else if (adStatus.status === "available") {
        nextCell.append(taskTimeElement(null, "现在"));
      } else {
        nextCell.append(taskTimeElement(adStatus.next_available_at));
      }
      nextCell.setAttribute("aria-label", `下次可看：${nextCell.textContent}`);

      const updatedCell = document.createElement("td");
      updatedCell.dataset.label = "更新时间";
      updatedCell.className = "task-time";
      updatedCell.append(taskTimeElement(latestTimestamp(account.quiz?.checked_at, account.ad?.checked_at)));
      updatedCell.setAttribute("aria-label", `更新时间：${updatedCell.textContent}`);

      row.append(nameCell, quizCell, progressCell, adCell, nextCell, updatedCell);
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
    renderTaskStatuses(data.task_statuses);
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
        task_statuses: { local_date: null, updated_at: null, accounts: [] },
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

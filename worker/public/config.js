"use strict";

(() => {
  const API_PATH = "/api/admin/accounts";
  const TOKEN_STORAGE_KEY = "vsllm_admin_token";
  const MAX_VISIBLE_MESSAGE_LENGTH = 240;

  class UiError extends Error {
    constructor(message, { authentication = false } = {}) {
      super(message);
      this.name = "UiError";
      this.authentication = authentication;
    }
  }

  const elements = {
    connection: document.querySelector("#connection-state"),
    connectionLabel: document.querySelector("#connection-label"),
    loginPanel: document.querySelector("#login-panel"),
    loginForm: document.querySelector("#login-form"),
    loginButton: document.querySelector("#login-button"),
    loginError: document.querySelector("#login-error"),
    tokenInput: document.querySelector("#admin-token"),
    workspace: document.querySelector("#workspace"),
    logoutButton: document.querySelector("#logout-button"),
    accountCount: document.querySelector("#account-count"),
    validCount: document.querySelector("#valid-count"),
    maxAccountCount: document.querySelector("#max-account-count"),
    accountsForm: document.querySelector("#accounts-form"),
    accountsList: document.querySelector("#accounts-list"),
    accountTemplate: document.querySelector("#account-template"),
    emptyState: document.querySelector("#empty-state"),
    addButton: document.querySelector("#add-account-button"),
    emptyAddButton: document.querySelector("#empty-add-button"),
    saveButton: document.querySelector("#save-button"),
    saveStateDot: document.querySelector("#save-state-dot"),
    saveStateText: document.querySelector("#save-state-text"),
    toastRegion: document.querySelector("#toast-region"),
    screenReaderStatus: document.querySelector("#screen-reader-status"),
  };

  const state = {
    token: "",
    maxAccounts: 0,
    busy: false,
    dirty: false,
  };

  function sessionToken() {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storeSessionToken(token) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // The page still works for this open document when session storage is unavailable.
    }
  }

  function clearSessionToken() {
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Nothing else needs to be cleared when session storage is unavailable.
    }
  }

  function cleanText(value, maximum = MAX_VISIBLE_MESSAGE_LENGTH) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maximum);
  }

  function publicMessage(value) {
    const text = cleanText(value);
    if (!text) return "";
    return text
      .replace(
        /((?:authorization|bearer|cookie|token|password|session|cf_clearance)\s*[:=]\s*)[^\s,;]+/giu,
        "$1[已隐藏]",
      )
      .replace(/[A-Za-z0-9_=.\-]{80,}/gu, "[敏感内容已隐藏]");
  }

  function announce(message) {
    elements.screenReaderStatus.textContent = "";
    window.setTimeout(() => {
      elements.screenReaderStatus.textContent = cleanText(message);
    }, 20);
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    const copy = document.createElement("span");
    toast.className = "toast";
    toast.dataset.state = type;
    copy.textContent = cleanText(message);
    toast.append(copy);
    elements.toastRegion.append(toast);
    announce(message);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function setConnection(status, label) {
    elements.connection.dataset.state = status;
    elements.connectionLabel.textContent = label;
  }

  function setLoginError(message = "") {
    const value = cleanText(message);
    elements.loginError.textContent = value;
    elements.loginError.hidden = value.length === 0;
    elements.tokenInput.setAttribute("aria-invalid", value ? "true" : "false");
  }

  function setButtonLoading(button, loading) {
    button.classList.toggle("is-loading", loading);
    button.disabled = loading;
    button.setAttribute("aria-busy", String(loading));
  }

  function setSaveState(status, text) {
    elements.saveStateDot.dataset.state = status;
    elements.saveStateText.textContent = text;
  }

  function markDirty() {
    if (state.busy) return;
    state.dirty = true;
    setSaveState("dirty", "有未保存的更改");
    elements.saveButton.disabled = false;
  }

  function markClean() {
    state.dirty = false;
    setSaveState("clean", "所有更改已同步");
    elements.saveButton.disabled = true;
  }

  function cardElements(card) {
    return {
      name: card.querySelector(".account-name-input"),
      baseUrl: card.querySelector(".base-url-input"),
      userId: card.querySelector(".user-id-input"),
      cookie: card.querySelector(".cookie-input"),
      cookieField: card.querySelector(".cookie-field"),
      cookieState: card.querySelector(".cookie-state-label"),
      cookieHint: card.querySelector(".cookie-hint"),
      displayName: card.querySelector(".account-display-name"),
      keyLabel: card.querySelector(".account-key-label"),
      number: card.querySelector(".account-number"),
      statusChip: card.querySelector(".status-chip"),
      statusLabel: card.querySelector(".status-chip-label"),
      error: card.querySelector(".account-error"),
      remove: card.querySelector(".remove-account-button"),
    };
  }

  function setCardStatus(card, status, label) {
    const fields = cardElements(card);
    fields.statusChip.dataset.state = status;
    fields.statusLabel.textContent = label;
  }

  function clearCardError(card) {
    const fields = cardElements(card);
    card.classList.remove("has-error");
    fields.error.textContent = "";
    fields.error.hidden = true;
    for (const input of card.querySelectorAll("input")) {
      input.setAttribute("aria-invalid", "false");
    }
  }

  function setCardError(card, message, input = null) {
    const fields = cardElements(card);
    const value = publicMessage(message) || "请检查此账号的配置。";
    card.classList.add("has-error");
    fields.error.textContent = value;
    fields.error.hidden = false;
    if (input) input.setAttribute("aria-invalid", "true");
  }

  function shortAccountKey(value) {
    const key = cleanText(value, 128);
    if (!key) return "";
    return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
  }

  function normalizedAccount(value) {
    const account = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      account_key: cleanText(account.account_key, 128),
      name: cleanText(account.name, 64),
      base_url: cleanText(account.base_url, 240),
      user_id: cleanText(account.user_id, 80),
      cookie_configured: account.cookie_configured === true,
      valid: account.valid === true,
      validation_error: publicMessage(account.validation_error),
    };
  }

  function normalizedResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.accounts)) {
      throw new UiError("服务器返回了无法识别的账号数据。请稍后重试。");
    }
    const maxAccounts = Number(value.max_accounts);
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 0 || maxAccounts > 100) {
      throw new UiError("服务器返回的账号上限无效。请检查 Worker 配置。");
    }
    const accounts = value.accounts.map(normalizedAccount);
    if (accounts.length > maxAccounts) {
      throw new UiError("服务器返回的账号数量超过允许上限。");
    }
    return { accounts, maxAccounts };
  }

  function apiError(status, payload) {
    const code = cleanText(payload?.error?.code, 80);
    if (status === 401 || status === 403) {
      return new UiError("管理员令牌无效或已过期，请重新输入。", { authentication: true });
    }
    if (status === 404) {
      return new UiError("账号管理接口尚未上线，请先部署支持该接口的 Worker。 ");
    }
    if (status === 409) {
      return new UiError("账号配置已发生变化，请重新加载后再保存。 ");
    }
    if (status === 413) {
      return new UiError("提交内容过大，请缩短账号信息后重试。 ");
    }
    if (status === 429) {
      return new UiError("请求过于频繁，请稍后再试。 ");
    }
    if (status >= 500) {
      return new UiError("Worker 暂时无法处理账号配置，请稍后再试。 ");
    }
    if (code === "invalid_accounts" || code === "invalid_account") {
      return new UiError("账号信息不符合要求，请检查标记的字段。 ");
    }
    return new UiError("请求未完成，请检查账号信息后重试。 ");
  }

  async function requestAccounts(method, accounts) {
    const headers = new Headers({ Accept: "application/json" });
    headers.set("Authorization", `Bearer ${state.token}`);
    const init = {
      method,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    };
    if (method === "PUT") {
      headers.set("Content-Type", "application/json; charset=utf-8");
      init.body = JSON.stringify({ accounts });
    }

    let response;
    try {
      response = await fetch(API_PATH, init);
    } catch {
      throw new UiError("无法连接到当前 Worker，请检查网络后重试。 ");
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) {
        throw new UiError("Worker 返回了无法解析的数据。 ");
      }
    }
    if (!response.ok) throw apiError(response.status, payload);
    return normalizedResponse(payload);
  }

  function accountCards() {
    return [...elements.accountsList.querySelectorAll(".account-card")];
  }

  function updateSummary() {
    const cards = accountCards();
    const valid = cards.filter((card) => card.dataset.serverValid === "true").length;
    elements.accountCount.textContent = String(cards.length);
    elements.validCount.textContent = String(valid);
    elements.maxAccountCount.textContent = String(state.maxAccounts);
    elements.emptyState.hidden = cards.length !== 0;

    const atLimit = cards.length >= state.maxAccounts;
    elements.addButton.disabled = state.busy || atLimit;
    elements.emptyAddButton.disabled = state.busy || atLimit;
    const limitHint = atLimit ? `已达到 ${state.maxAccounts} 个账号上限` : "新增账号";
    elements.addButton.title = limitHint;
    elements.emptyAddButton.title = limitHint;
  }

  function renumberCards() {
    accountCards().forEach((card, index) => {
      const fields = cardElements(card);
      fields.number.textContent = String(index + 1).padStart(2, "0");
      fields.remove.setAttribute("aria-label", `删除第 ${index + 1} 个账号`);
    });
    updateSummary();
  }

  function markCardAsDraft(card) {
    card.dataset.serverValid = "false";
    clearCardError(card);
    setCardStatus(card, "draft", "待保存");
    const fields = cardElements(card);
    fields.displayName.textContent = cleanText(fields.name.value, 64) || "未命名账号";
    markDirty();
    updateSummary();
  }

  function addAccountCard(accountValue = null, { focus = true, dirty = true } = {}) {
    if (accountCards().length >= state.maxAccounts) {
      showToast(`最多只能配置 ${state.maxAccounts} 个账号。`, "error");
      return null;
    }

    const account = normalizedAccount(accountValue);
    const fragment = elements.accountTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".account-card");
    const fields = cardElements(card);
    const existing = account.account_key.length > 0;

    card.dataset.accountKey = account.account_key;
    card.dataset.cookieConfigured = String(account.cookie_configured);
    card.dataset.serverValid = String(existing && account.valid);
    fields.name.value = account.name;
    fields.baseUrl.value = account.base_url;
    fields.userId.value = account.user_id;
    fields.cookie.value = "";
    fields.displayName.textContent = account.name || "未命名账号";

    if (existing) {
      fields.keyLabel.textContent = `账号标识 · ${shortAccountKey(account.account_key)}`;
      if (account.valid) setCardStatus(card, "valid", "状态正常");
      else setCardStatus(card, "invalid", "需要处理");
    } else {
      fields.keyLabel.textContent = "新账号 · 尚未保存";
      setCardStatus(card, "draft", "待保存");
    }

    if (account.cookie_configured) {
      fields.cookieField.classList.add("is-configured");
      fields.cookieState.textContent = "Cookie 已配置";
      fields.cookie.placeholder = "已配置；留空保留原值";
      fields.cookieHint.textContent = "仅在需要替换 Cookie 时填写新值。";
    } else {
      fields.cookieState.textContent = existing ? "Cookie 尚未配置" : "新增账号必须填写";
      fields.cookie.placeholder = "粘贴完整 Cookie";
      fields.cookieHint.textContent = "此账号保存前必须填写 Cookie。";
    }

    if (account.validation_error) {
      setCardError(card, account.validation_error);
    }

    card.addEventListener("input", () => markCardAsDraft(card));
    fields.remove.addEventListener("click", () => removeAccountCard(card));
    elements.accountsList.append(card);
    renumberCards();
    if (dirty) markDirty();
    if (focus) fields.name.focus();
    return card;
  }

  function removeAccountCard(card) {
    if (state.busy) return;
    const fields = cardElements(card);
    const existing = card.dataset.accountKey.length > 0;
    const accountName = cleanText(fields.name.value, 64) || "这个账号";
    if (existing && !window.confirm(`确定移除“${accountName}”吗？保存全部配置后生效。`)) {
      return;
    }
    card.remove();
    renumberCards();
    markDirty();
  }

  function renderAccounts(response) {
    state.maxAccounts = response.maxAccounts;
    elements.accountsList.replaceChildren();
    for (const account of response.accounts) {
      addAccountCard(account, { focus: false, dirty: false });
    }
    renumberCards();
    markClean();
  }

  function firstControlCharacter(value) {
    return /[\u0000-\u001f\u007f]/u.test(value);
  }

  function normalizedBaseUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.toString().replace(/\/$/u, "");
  }

  function collectAccounts() {
    const cards = accountCards();
    if (cards.length > state.maxAccounts) {
      showToast(`账号数量不能超过 ${state.maxAccounts} 个。`, "error");
      return null;
    }

    const accounts = [];
    let firstInvalid = null;
    for (const card of cards) {
      clearCardError(card);
      const fields = cardElements(card);
      const accountKey = cleanText(card.dataset.accountKey, 128);
      const name = fields.name.value.trim();
      const rawBaseUrl = fields.baseUrl.value.trim();
      const baseUrl = normalizedBaseUrl(rawBaseUrl);
      const userId = fields.userId.value.trim();
      const cookie = fields.cookie.value.trim();
      const cookieConfigured = card.dataset.cookieConfigured === "true";

      let message = "";
      let invalidInput = null;
      if (!name || name.length > 64 || firstControlCharacter(name)) {
        message = "请填写 1–64 个字符的账号名称。";
        invalidInput = fields.name;
      } else if (!baseUrl) {
        message = "站点地址必须是有效的 HTTPS 地址，且不能包含账号、查询参数或锚点。";
        invalidInput = fields.baseUrl;
      } else if (
        (new URL(baseUrl).hostname.toLowerCase().replace(/\.$/u, "") === "vsllm.com" && !userId) ||
        userId.length > 80 ||
        firstControlCharacter(userId)
      ) {
        message = "VSLLM 账号必须填写用户 ID；其他站点可留空。";
        invalidInput = fields.userId;
      } else if ((!accountKey || !cookieConfigured) && !cookie) {
        message = accountKey ? "此账号尚未配置 Cookie，请填写后保存。" : "新增账号必须填写 Cookie。";
        invalidInput = fields.cookie;
      }

      if (message) {
        setCardError(card, message, invalidInput);
        if (!firstInvalid) firstInvalid = invalidInput;
        continue;
      }

      const account = { name, base_url: baseUrl, user_id: userId };
      if (accountKey) account.account_key = accountKey;
      if (cookie) account.cookie = cookie;
      accounts.push(account);
    }

    if (firstInvalid) {
      firstInvalid.focus();
      showToast("请先修正标记的账号信息。", "error");
      return null;
    }
    return accounts;
  }

  function setWorkspaceBusy(busy) {
    state.busy = busy;
    elements.workspace.setAttribute("aria-busy", String(busy));
    for (const control of elements.accountsForm.querySelectorAll("input, button")) {
      control.disabled = busy;
    }
    elements.logoutButton.disabled = busy;
    setButtonLoading(elements.saveButton, busy);
    if (busy) setSaveState("saving", "正在安全保存…");
    else {
      elements.saveButton.disabled = !state.dirty;
      updateSummary();
    }
  }

  function showLogin({ message = "", focus = true } = {}) {
    elements.workspace.hidden = true;
    elements.loginPanel.hidden = false;
    elements.tokenInput.value = "";
    setLoginError(message);
    setConnection(message ? "error" : "offline", message ? "验证失败" : "未登录");
    if (focus) elements.tokenInput.focus();
  }

  function showWorkspace(response) {
    renderAccounts(response);
    elements.loginPanel.hidden = true;
    elements.workspace.hidden = false;
    elements.tokenInput.value = "";
    setLoginError("");
    setConnection("online", "已安全连接");
  }

  function logout(message = "") {
    state.busy = false;
    state.token = "";
    state.dirty = false;
    state.maxAccounts = 0;
    clearSessionToken();
    elements.accountsList.replaceChildren();
    showLogin({ message });
  }

  async function loginWithToken(token, { restored = false } = {}) {
    if (state.busy) return;
    const candidate = String(token || "").trim();
    if (!candidate) {
      setLoginError("请输入管理员令牌。 ");
      elements.tokenInput.focus();
      return;
    }

    state.busy = true;
    state.token = candidate;
    setLoginError("");
    setConnection("loading", "正在验证");
    setButtonLoading(elements.loginButton, true);
    try {
      const response = await requestAccounts("GET");
      storeSessionToken(candidate);
      showWorkspace(response);
      showToast(restored ? "已恢复当前标签页的管理会话。" : "管理员验证成功。", "success");
    } catch (error) {
      state.token = "";
      clearSessionToken();
      const message = error instanceof UiError ? error.message : "验证失败，请稍后重试。 ";
      showLogin({ message, focus: true });
    } finally {
      state.busy = false;
      setButtonLoading(elements.loginButton, false);
      if (!elements.workspace.hidden) updateSummary();
    }
  }

  async function saveAccounts() {
    if (state.busy) return;
    const accounts = collectAccounts();
    if (!accounts) return;

    setWorkspaceBusy(true);
    try {
      const response = await requestAccounts("PUT", accounts);
      renderAccounts(response);
      const invalidCount = response.accounts.filter((account) => !account.valid).length;
      if (invalidCount > 0) {
        showToast(`配置已保存，但有 ${invalidCount} 个账号需要处理。`, "error");
      } else {
        showToast("账号配置已安全保存。", "success");
      }
    } catch (error) {
      if (error instanceof UiError && error.authentication) {
        logout(error.message);
        return;
      }
      state.dirty = true;
      setSaveState("error", "保存失败，修改仍保留在页面中");
      const message = error instanceof UiError ? error.message : "保存失败，请稍后重试。 ";
      showToast(message, "error");
    } finally {
      if (!elements.workspace.hidden) setWorkspaceBusy(false);
    }
  }

  elements.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void loginWithToken(elements.tokenInput.value);
  });

  elements.accountsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAccounts();
  });

  elements.addButton.addEventListener("click", () => addAccountCard());
  elements.emptyAddButton.addEventListener("click", () => addAccountCard());
  elements.logoutButton.addEventListener("click", () => {
    if (state.dirty && !window.confirm("当前有未保存的更改，确定退出管理吗？")) return;
    logout();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const restoredToken = sessionToken();
  if (restoredToken) {
    void loginWithToken(restoredToken, { restored: true });
  } else {
    showLogin();
  }
})();

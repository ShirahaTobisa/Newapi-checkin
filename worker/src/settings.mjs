const INTERVAL_OPTIONS = new Set([60, 120, 180, 240, 360, 480, 720]);

export const DEFAULT_SETTINGS = Object.freeze({
  schema_version: 1,
  automation_enabled: true,
  timezone: "Asia/Shanghai",
  quota_per_cny: 500000,
  checkin: Object.freeze({
    enabled: true,
    daily_at: "00:10",
  }),
  draw: Object.freeze({
    enabled: true,
    anchor_local: "00:20",
    every_minutes: 120,
    draw_count: 1,
    share_bonus: true,
  }),
  quiz: Object.freeze({
    enabled: true,
    daily_at: "00:15",
    draw_after_success: true,
  }),
  ad: Object.freeze({
    enabled: true,
    anchor_local: "01:00",
    every_minutes: 120,
    daily_limit: 3,
    draw_after_claim: true,
  }),
  notifications: Object.freeze({
    enabled: false,
    errors_only: false,
    checkin: true,
    draw: true,
    task_error: true,
  }),
});

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) return fallback;
  return number;
}

export function normalizeTime(value, fallback) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/u.test(value)) return fallback;
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function intervalValue(value, fallback) {
  const number = Number(value);
  return INTERVAL_OPTIONS.has(number) ? number : fallback;
}

export function normalizeSettings(value) {
  const input = objectValue(value);
  const checkin = objectValue(input.checkin);
  const draw = objectValue(input.draw);
  const quiz = objectValue(input.quiz);
  const ad = objectValue(input.ad);
  const notifications = objectValue(input.notifications);

  return {
    schema_version: 1,
    automation_enabled: booleanValue(
      input.automation_enabled,
      DEFAULT_SETTINGS.automation_enabled,
    ),
    timezone: "Asia/Shanghai",
    // VSLLM 的额度换算是固定业务规则，不允许通过设置或旧数据改写。
    quota_per_cny: DEFAULT_SETTINGS.quota_per_cny,
    checkin: {
      enabled: booleanValue(checkin.enabled, DEFAULT_SETTINGS.checkin.enabled),
      daily_at: normalizeTime(checkin.daily_at, DEFAULT_SETTINGS.checkin.daily_at),
    },
    draw: {
      enabled: booleanValue(draw.enabled, DEFAULT_SETTINGS.draw.enabled),
      anchor_local: normalizeTime(draw.anchor_local, DEFAULT_SETTINGS.draw.anchor_local),
      every_minutes: intervalValue(draw.every_minutes, DEFAULT_SETTINGS.draw.every_minutes),
      draw_count: integerValue(draw.draw_count, DEFAULT_SETTINGS.draw.draw_count, 1, 3),
      share_bonus: booleanValue(draw.share_bonus, DEFAULT_SETTINGS.draw.share_bonus),
    },
    quiz: {
      enabled: booleanValue(quiz.enabled, DEFAULT_SETTINGS.quiz.enabled),
      daily_at: normalizeTime(quiz.daily_at, DEFAULT_SETTINGS.quiz.daily_at),
      draw_after_success: booleanValue(
        quiz.draw_after_success,
        DEFAULT_SETTINGS.quiz.draw_after_success,
      ),
    },
    ad: {
      enabled: booleanValue(ad.enabled, DEFAULT_SETTINGS.ad.enabled),
      anchor_local: normalizeTime(ad.anchor_local, DEFAULT_SETTINGS.ad.anchor_local),
      every_minutes: intervalValue(ad.every_minutes, DEFAULT_SETTINGS.ad.every_minutes),
      daily_limit: integerValue(ad.daily_limit, DEFAULT_SETTINGS.ad.daily_limit, 1, 3),
      draw_after_claim: booleanValue(
        ad.draw_after_claim,
        DEFAULT_SETTINGS.ad.draw_after_claim,
      ),
    },
    notifications: {
      enabled: booleanValue(notifications.enabled, DEFAULT_SETTINGS.notifications.enabled),
      errors_only: booleanValue(
        notifications.errors_only,
        DEFAULT_SETTINGS.notifications.errors_only,
      ),
      checkin: booleanValue(notifications.checkin, DEFAULT_SETTINGS.notifications.checkin),
      draw: booleanValue(notifications.draw, DEFAULT_SETTINGS.notifications.draw),
      task_error: booleanValue(
        notifications.task_error,
        DEFAULT_SETTINGS.notifications.task_error,
      ),
    },
  };
}

export function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    dateKey: `${values.year}-${values.month}-${values.day}`,
    timeKey: `${values.hour}:${values.minute}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function timeMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function taskConfig(settings, task) {
  if (task === "checkin") {
    return { enabled: settings.checkin.enabled, daily: true, at: settings.checkin.daily_at };
  }
  if (task === "quiz") {
    return { enabled: settings.quiz.enabled, daily: true, at: settings.quiz.daily_at };
  }
  if (task === "draw") {
    return {
      enabled: settings.draw.enabled,
      daily: false,
      at: settings.draw.anchor_local,
      every: settings.draw.every_minutes,
    };
  }
  if (task === "ad") {
    return {
      enabled: settings.ad.enabled,
      daily: false,
      at: settings.ad.anchor_local,
      every: settings.ad.every_minutes,
    };
  }
  throw new TypeError(`Unknown task: ${task}`);
}

export function taskDue(settingsValue, task, date = new Date()) {
  const settings = normalizeSettings(settingsValue);
  if (!settings.automation_enabled) return false;
  const config = taskConfig(settings, task);
  if (!config.enabled) return false;
  const now = beijingParts(date);
  const anchor = timeMinutes(config.at);
  if (config.daily) return now.minuteOfDay === anchor;
  const delta = (now.minuteOfDay - anchor + 1440) % 1440;
  return delta % config.every === 0;
}

export function taskSlot(settingsValue, task, date = new Date()) {
  const settings = normalizeSettings(settingsValue);
  const now = beijingParts(date);
  const config = taskConfig(settings, task);
  if (config.daily) return `${task}:${now.dateKey}`;
  return `${task}:${now.dateKey}T${String(now.hour).padStart(2, "0")}${String(now.minute).padStart(2, "0")}`;
}

function addDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function beijingLocalToUtcIso(year, month, day, minuteOfDay, dayOffset = 0) {
  const shifted = addDays(year, month, day, dayOffset + Math.floor(minuteOfDay / 1440));
  const normalizedMinute = ((minuteOfDay % 1440) + 1440) % 1440;
  const hour = Math.floor(normalizedMinute / 60);
  const minute = normalizedMinute % 60;
  return new Date(Date.UTC(shifted.year, shifted.month - 1, shifted.day, hour - 8, minute, 0))
    .toISOString();
}

export function nextTaskAt(settingsValue, task, date = new Date()) {
  const settings = normalizeSettings(settingsValue);
  const config = taskConfig(settings, task);
  if (!settings.automation_enabled || !config.enabled) return null;
  const now = beijingParts(date);
  const anchor = timeMinutes(config.at);
  if (config.daily) {
    const offset = now.minuteOfDay < anchor ? 0 : 1;
    return beijingLocalToUtcIso(now.year, now.month, now.day, anchor, offset);
  }

  const elapsed = now.minuteOfDay - anchor;
  let nextMinute;
  if (elapsed < 0) {
    nextMinute = anchor;
  } else {
    nextMinute = anchor + (Math.floor(elapsed / config.every) + 1) * config.every;
  }
  return beijingLocalToUtcIso(now.year, now.month, now.day, nextMinute);
}

export function scheduleSummaries(settingsValue, date = new Date()) {
  const settings = normalizeSettings(settingsValue);
  return [
    {
      key: "checkin",
      label: "每日签到",
      enabled: settings.automation_enabled && settings.checkin.enabled,
      next_at: nextTaskAt(settings, "checkin", date),
      summary: `每天 ${settings.checkin.daily_at}`,
    },
    {
      key: "quiz",
      label: "每日答题",
      enabled: settings.automation_enabled && settings.quiz.enabled,
      next_at: nextTaskAt(settings, "quiz", date),
      summary: `每天 ${settings.quiz.daily_at}${settings.quiz.draw_after_success ? "，成功后翻牌" : ""}`,
    },
    {
      key: "draw",
      label: "常规翻牌",
      enabled: settings.automation_enabled && settings.draw.enabled,
      next_at: nextTaskAt(settings, "draw", date),
      summary: `从 ${settings.draw.anchor_local} 起每 ${settings.draw.every_minutes / 60} 小时，单号 ${settings.draw.draw_count} 次`,
    },
    {
      key: "ad",
      label: "视频任务",
      enabled: settings.automation_enabled && settings.ad.enabled,
      next_at: nextTaskAt(settings, "ad", date),
      summary: `从 ${settings.ad.anchor_local} 起每 ${settings.ad.every_minutes / 60} 小时检查，每日最多 ${settings.ad.daily_limit} 次`,
    },
  ];
}

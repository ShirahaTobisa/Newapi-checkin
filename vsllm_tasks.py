#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""维云答题和广告任务。

答题或广告奖励领取成功后立即翻牌一次，把每次翻牌尝试写入历史记录，
并上报每个账号的北京时间每日任务状态。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import urlsplit, urlunsplit

import requests

from checkin import (
    NewAPICheckin,
    gwent_event_status,
    history_account_key,
    load_config_from_cloud,
    normalize_gwent_bonus_percent,
    normalize_gwent_quota,
    parse_accounts,
    publish_gwent_history,
    utc_timestamp,
)


QUIZ_MAX_ATTEMPTS = 20
DEFAULT_AD_DURATION_SECONDS = 15
MAX_AD_DURATION_SECONDS = 120
TASK_TYPES = ("quiz", "ad")
_SAFE_MESSAGE_RE = re.compile(r"\s+", re.UNICODE)
BEIJING_TIMEZONE = timezone(timedelta(hours=8))


def _safe_int(value: Any, *, minimum: int = 0, maximum: int = 2**53 - 1) -> Optional[int]:
    """将 API 中的整数/数字字符串规范化；异常值返回 None。"""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < minimum or number > maximum:
        return None
    return int(number)


def _safe_message(value: Any, default: str = "") -> str:
    text = str(value or default)
    text = re.sub(
        r"(?i)(authorization|cookie|session|token)\s*[=:]\s*[^\s,;]+",
        r"\1=***",
        text,
    )
    return _SAFE_MESSAGE_RE.sub(" ", text).strip()[:180]


def _response_payload(response: Any) -> dict:
    try:
        payload = response.json()
    except (AttributeError, ValueError, TypeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def beijing_local_date(now: Optional[datetime] = None) -> str:
    """返回任务看板使用的北京时间日期。"""
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(BEIJING_TIMEZONE).date().isoformat()


def _task_status_url() -> str:
    explicit = os.environ.get("TASK_STATUS_URL", "").strip()
    if explicit:
        return explicit
    history_url = os.environ.get("HISTORY_URL", "").strip()
    if not history_url:
        return ""
    parsed = urlsplit(history_url)
    path = re.sub(r"/history/?$", "/task-status", parsed.path)
    if path == parsed.path:
        path = f"{parsed.path.rstrip('/')}/task-status"
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def publish_task_status(payload: dict) -> bool:
    """把脱敏后的账号每日任务状态发布到 Worker。"""
    status_url = _task_status_url()
    history_auth = os.environ.get("HISTORY_AUTH", "").strip()
    required = os.environ.get("HISTORY_REQUIRED", "").strip().lower() == "true"
    if not status_url or not history_auth:
        print("[任务状态] 未配置 TASK_STATUS_URL/HISTORY_URL 或 HISTORY_AUTH，跳过状态上报")
        return not required

    token = history_auth[6:] if history_auth.startswith("token:") else history_auth
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    for attempt in range(1, 4):
        try:
            response = requests.post(status_url, headers=headers, json=payload, timeout=30)
            if response.status_code == 200:
                print("[任务状态] 每日状态已保存")
                return True
            print(f"[任务状态] 第 {attempt}/3 次上报失败: HTTP {response.status_code}")
        except requests.exceptions.RequestException as error:
            print(f"[任务状态] 第 {attempt}/3 次上报失败: {type(error).__name__}")
        if attempt < 3:
            time.sleep(attempt)

    print("[任务状态] 每日状态保存失败")
    return not required


def _api_request(
    client: NewAPICheckin,
    action: str,
    path: str,
    *,
    method: str = "POST",
    payload: Optional[dict] = None,
) -> dict:
    """调用维云接口并只输出脱敏摘要，不保存原始响应体。"""
    if not client.is_vsllm():
        return {"ok": False, "status_code": 0, "data": {}, "message": "非维云站点"}

    try:
        if method.upper() == "GET":
            response = client.session.get(f"{client.base_url}{path}", timeout=30)
        else:
            response = client.session.post(
                f"{client.base_url}{path}",
                json=payload if payload is not None else None,
                timeout=30,
            )
        data = _response_payload(response)
        api_success = data.get("success")
        ok = 200 <= response.status_code < 300 and api_success is not False
        message = _safe_message(data.get("message"), "请求完成" if ok else "请求失败")
        result = {
            "ok": ok,
            "status_code": response.status_code,
            "api_success": api_success,
            "data": data,
            "message": message,
        }
        mark = "OK" if ok else "FAIL"
        print(f"  [任务] {action}: {mark} HTTP {response.status_code} {message}")
        return result
    except requests.exceptions.Timeout:
        message = "请求超时"
    except requests.exceptions.RequestException as error:
        message = f"网络请求失败: {type(error).__name__}"
    except Exception as error:  # pragma: no cover - defensive boundary for third-party responses
        message = f"请求异常: {type(error).__name__}"

    print(f"  [任务] {action}: FAIL {message}")
    return {"ok": False, "status_code": 0, "api_success": None, "data": {}, "message": message}


def normalize_quiz_text(value: Any) -> str:
    return re.sub(r"[?？。，!！:：\s]+", "", str(value or "").lower())


def quiz_option_text(option: Any) -> str:
    if isinstance(option, dict):
        return str(option.get("text", option.get("label", option.get("value", ""))) or "")
    return str(option or "")


def choose_known_quiz_answer(question: dict) -> int:
    """识别当前已知的版本比较题；未知题返回 -1，交给有限选项尝试。"""
    text = normalize_quiz_text(question.get("text"))
    options = question.get("options") if isinstance(question.get("options"), list) else []
    target = ""
    if "v9.11" in text and "v9.9" in text:
        target = "v9.11"
    elif "9.11" in text and "9.9" in text:
        target = "9.9"
    if not target:
        return -1

    normalized = [normalize_quiz_text(quiz_option_text(option)) for option in options]
    for index, value in enumerate(normalized):
        if value == target:
            return index
    for index, value in enumerate(normalized):
        if target in value:
            return index
    return -1


def quiz_answer_order(question: dict) -> list[int]:
    options = question.get("options") if isinstance(question.get("options"), list) else []
    indices = list(range(len(options)))
    known = choose_known_quiz_answer(question)
    return [known, *[index for index in indices if index != known]] if known >= 0 else indices


def quiz_fingerprint(question: dict) -> str:
    options = question.get("options") if isinstance(question.get("options"), list) else []
    return json.dumps(
        [
            normalize_quiz_text(question.get("text")),
            [normalize_quiz_text(quiz_option_text(option)) for option in options],
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _question_from_result(result: dict) -> Optional[dict]:
    data = result.get("data", {}).get("data")
    question = data.get("question") if isinstance(data, dict) else None
    if not isinstance(question, dict):
        return None
    options = question.get("options")
    if not isinstance(options, list) or not options:
        return None
    return question


def answer_quiz_until_correct(
    client: NewAPICheckin,
    initial_question: dict,
    *,
    max_attempts: int = QUIZ_MAX_ATTEMPTS,
    sleep_fn: Optional[Callable[[float], None]] = None,
) -> dict:
    """答题失败后刷新题目；同一题的每个选项最多尝试一次。"""
    sleep_fn = sleep_fn or time.sleep
    question = initial_question
    attempts: list[dict] = []
    tried_by_question: dict[str, set[int]] = {}

    for attempt_number in range(max_attempts):
        order = quiz_answer_order(question)
        if not order:
            return {"ok": False, "correct": False, "error": "题目没有选项", "attempts": attempts}

        fingerprint = quiz_fingerprint(question)
        tried = tried_by_question.setdefault(fingerprint, set())
        answer_index = next((index for index in order if index not in tried), None)
        if answer_index is None:
            return {
                "ok": False,
                "correct": False,
                "error": "同一题的选项已全部尝试",
                "attempts": attempts,
            }
        tried.add(answer_index)

        sleep_fn(2.2 if attempt_number == 0 else 0.8)
        answer = _api_request(
            client,
            f"提交答题选项 {answer_index}",
            "/api/gwent/task3/answer",
            payload={"answer_index": answer_index},
        )
        answer_data = answer.get("data", {}).get("data")
        correct = answer_data.get("correct") if isinstance(answer_data, dict) else None
        if not answer.get("ok") or not isinstance(correct, bool):
            return {
                "ok": False,
                "correct": False,
                "error": "答题接口返回格式异常",
                "attempts": attempts,
            }

        attempt = {"answer_index": answer_index, "correct": correct}
        attempts.append(attempt)
        if correct:
            return {"ok": True, "correct": True, "attempts": attempts}

        restart = _api_request(client, "答错后刷新题目", "/api/gwent/task3/start")
        if not restart.get("ok"):
            return {
                "ok": False,
                "correct": False,
                "error": "答错后刷新题目失败",
                "attempts": attempts,
            }
        question = _question_from_result(restart)
        if question is None:
            return {
                "ok": False,
                "correct": False,
                "error": "刷新响应缺少题目",
                "attempts": attempts,
            }

    return {
        "ok": False,
        "correct": False,
        "error": f"超过 {max_attempts} 次答题尝试",
        "attempts": attempts,
    }


def task_status(client: NewAPICheckin, task_key: str) -> tuple[Optional[dict], Optional[str]]:
    result = _api_request(client, "读取任务状态", "/api/gwent/status", method="GET")
    if not result.get("ok"):
        return None, "读取任务状态失败"
    data = result.get("data", {}).get("data")
    tasks = data.get("tasks") if isinstance(data, dict) else None
    task = tasks.get(task_key) if isinstance(tasks, dict) else None
    if not isinstance(task, dict):
        return None, f"任务状态缺少 {task_key} 字段"
    return task, None


def draw_one_after_reward(client: NewAPICheckin, reason: str) -> dict:
    """奖励到账后立即翻牌一次，并把响应规范化供日志和历史记录使用。"""
    try:
        raw_result = client.gwent_draw()
    except Exception as error:  # pragma: no cover - defensive boundary for client implementations
        raw_result = {
            "success": False,
            "message": f"翻牌请求异常: {type(error).__name__}",
        }
    if not isinstance(raw_result, dict):
        raw_result = {"success": False, "message": "翻牌接口返回格式异常"}

    status = gwent_event_status(raw_result)
    prize_name = str(raw_result.get("prize_name") or "未知奖品")[:80]
    prize_quota = normalize_gwent_quota(raw_result.get("prize_quota"))
    prize_rarity = str(raw_result.get("prize_rarity") or "unknown").lower()
    if prize_rarity not in {"common", "rare", "epic", "legendary"}:
        prize_rarity = "unknown"
    bonus_percent = normalize_gwent_bonus_percent(raw_result.get("bonus_percent"))
    message = _safe_message(raw_result.get("message"), "翻牌成功" if status == "success" else "翻牌失败")

    if status == "success":
        print(
            f"  {reason}翻牌: OK {prize_name} (+{prize_quota:,} 额度，"
            f"加成 {bonus_percent}%)"
        )
    elif status == "cooldown":
        print(f"  {reason}翻牌: WAIT {message}")
    else:
        print(f"  {reason}翻牌: FAIL {message}")

    return {
        "ok": status == "success",
        "status": status,
        "message": message,
        "prize_name": prize_name if status == "success" else None,
        "prize_quota": prize_quota,
        "prize_rarity": prize_rarity,
        "bonus_percent": bonus_percent,
        "draw": raw_result,
    }


def _history_event(
    task_type: str,
    run_id: str,
    index: int,
    account: dict,
    draw: dict,
) -> dict:
    account_key = history_account_key(account, index)
    return {
        "event_id": f"{run_id}:{account_key}:1",
        "account_key": account_key,
        "account_name": _safe_account_name(account, index),
        "attempt": 1,
        "occurred_at": utc_timestamp(),
        "status": draw.get("status", "error"),
        "prize_name": draw.get("prize_name"),
        "prize_quota": max(0, normalize_gwent_quota(draw.get("prize_quota"))),
        "prize_rarity": draw.get("prize_rarity", "unknown"),
        "bonus_percent": max(0, normalize_gwent_bonus_percent(draw.get("bonus_percent"))),
        "message": _safe_message(draw.get("message")) or None,
        "task_type": task_type,
    }


def _publish_task_draws(
    task_type: str,
    run_id: str,
    run_number: int,
    run_attempt: int,
    started_at: str,
    events: list[dict],
    status: str,
) -> bool:
    if not events:
        print("[历史] 本轮没有实际翻牌尝试，跳过历史上报")
        return True
    return publish_gwent_history({
        "schema_version": 1,
        "run": {
            "run_id": run_id,
            "run_number": run_number,
            "run_attempt": run_attempt,
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "planned_draws": 1,
            "status": status,
            "source": task_type,
        },
        "events": events,
    })


def _load_accounts() -> list[dict]:
    config_url = os.environ.get("CONFIG_URL", "").strip()
    config_auth = os.environ.get("CONFIG_AUTH", "")
    accounts_raw = load_config_from_cloud(config_url, config_auth) if config_url else None
    accounts_raw = accounts_raw or os.environ.get("NEWAPI_ACCOUNTS", "")
    accounts = parse_accounts(accounts_raw)
    valid = []
    for account in accounts:
        client = NewAPICheckin(
            account.get("url", ""),
            account.get("session", ""),
            account.get("user_id"),
            account.get("cf_clearance"),
        )
        if client.is_vsllm():
            valid.append(account)
    if not valid:
        raise RuntimeError("没有配置 vsllm.com 账号")
    return valid


def _run_identity(task_type: str) -> tuple[str, int, int]:
    run_number = _safe_int(os.environ.get("GITHUB_RUN_NUMBER"), minimum=0) or 0
    run_attempt = _safe_int(os.environ.get("GITHUB_RUN_ATTEMPT"), minimum=1) or 1
    run_id = os.environ.get("GITHUB_RUN_ID", "").strip() or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"{task_type}:{run_id}:{run_attempt}", run_number, run_attempt


def _safe_account_name(account: dict, index: int) -> str:
    return (_safe_message(account.get("name"), f"账号{index}") or f"账号{index}")[:64]


def _task_snapshot(
    task_type: str,
    index: int,
    account: dict,
    status: str,
    *,
    completed: bool = False,
    message: str = "",
    done_count: Optional[int] = None,
    daily_cap: Optional[int] = None,
    next_available_at: Optional[str] = None,
) -> dict:
    snapshot = {
        "account_key": history_account_key(account, index),
        "account_name": _safe_account_name(account, index),
        "task_type": task_type,
        "status": status if status in {
            "completed", "available", "cooldown", "pending", "suspended", "error", "unknown",
        } else "unknown",
        "completed": bool(completed),
        "checked_at": utc_timestamp(),
    }
    safe_message = _safe_message(message)
    if safe_message:
        snapshot["message"] = safe_message
    if task_type == "ad":
        if done_count is not None:
            snapshot["done_count"] = min(3, max(0, int(done_count)))
        if daily_cap is not None:
            snapshot["daily_cap"] = min(3, max(1, int(daily_cap)))
        snapshot["next_available_at"] = next_available_at
    return snapshot


def _next_available_epoch(value: Any) -> Optional[int]:
    if value in (None, ""):
        return 0
    number = _safe_int(value, minimum=0)
    if number is not None:
        return number // 1000 if number > 10**11 else number
    if not isinstance(value, str):
        return None
    timestamp = value.strip()
    if timestamp.endswith("Z"):
        timestamp = f"{timestamp[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(timestamp)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, int(parsed.timestamp()))


def _epoch_timestamp(value: Optional[int]) -> Optional[str]:
    if value is None or value <= 0:
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _task_from_api_result(result: dict, task_key: str) -> Optional[dict]:
    payload = result.get("data")
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    tasks = data.get("tasks")
    candidates = [
        tasks.get(task_key) if isinstance(tasks, dict) else None,
        data.get(task_key),
        data.get("task"),
        data,
    ]
    expected = {"status", "suspended", "done_count", "daily_cap", "next_available_at"}
    return next(
        (candidate for candidate in candidates if isinstance(candidate, dict) and expected.intersection(candidate)),
        None,
    )


def _ad_values(task: dict) -> tuple[Optional[int], int, Optional[int]]:
    done_count = _safe_int(task.get("done_count"))
    server_daily_cap = _safe_int(task.get("daily_cap"), minimum=1) or 3
    daily_cap = min(server_daily_cap, 3)
    next_available = _next_available_epoch(task.get("next_available_at", 0))
    return done_count, daily_cap, next_available


def _ad_snapshot(
    index: int,
    account: dict,
    task: dict,
    *,
    message: str = "",
    force_status: Optional[str] = None,
) -> dict:
    done_count, daily_cap, next_available = _ad_values(task)
    if done_count is None or next_available is None:
        return _task_snapshot(
            "ad", index, account, "error", message=message or "广告任务状态字段缺失或格式错误",
            done_count=done_count, daily_cap=daily_cap,
        )
    completed = done_count >= daily_cap
    if force_status:
        status = force_status
    elif task.get("suspended") is True:
        status = "suspended"
    elif completed:
        status = "completed"
    elif next_available > int(time.time()):
        status = "cooldown"
    else:
        status = "available"
    return _task_snapshot(
        "ad",
        index,
        account,
        status,
        completed=completed,
        message=message,
        done_count=done_count,
        daily_cap=daily_cap,
        next_available_at=_epoch_timestamp(next_available),
    )


def _with_task_status(result: dict, snapshot: dict) -> dict:
    result["task_status"] = snapshot
    return result


def _quiz_account(index: int, account: dict, client: NewAPICheckin, events: list[dict], run_id: str) -> dict:
    name = _safe_account_name(account, index)
    print(f"[{name}] 每日答题")
    task, error = task_status(client, "task3")
    if error:
        return _with_task_status(
            {"ok": False, "reason": error},
            _task_snapshot("quiz", index, account, "error", message=error),
        )
    if task.get("suspended") is True:
        print("  跳过：答题任务已暂停")
        return _with_task_status(
            {"ok": True, "skipped": True, "reason": "quiz_suspended"},
            _task_snapshot("quiz", index, account, "suspended", message="答题任务已暂停"),
        )
    task_state = str(task.get("status") or "").lower()
    if not task_state:
        message = "答题任务状态缺失"
        return _with_task_status(
            {"ok": False, "reason": message},
            _task_snapshot("quiz", index, account, "error", message=message),
        )
    if task_state in {"completed", "done", "success", "claimed"}:
        print(f"  跳过：答题状态为 {task_state}")
        return _with_task_status(
            {"ok": True, "skipped": True, "reason": f"quiz_{task_state}"},
            _task_snapshot("quiz", index, account, "completed", completed=True, message="今日答题已完成"),
        )
    if task_state not in {"pending", "available", "ready", "in_progress"}:
        message = f"未知答题任务状态: {task_state}"
        return _with_task_status(
            {"ok": False, "reason": message},
            _task_snapshot("quiz", index, account, "error", message=message),
        )

    start = _api_request(client, "开始每日答题", "/api/gwent/task3/start")
    question = _question_from_result(start)
    if not start.get("ok") or question is None:
        message = "开始答题失败或题目格式异常"
        return _with_task_status(
            {"ok": False, "reason": message},
            _task_snapshot("quiz", index, account, "error", message=message),
        )

    quiz = answer_quiz_until_correct(client, question)
    if not quiz.get("ok"):
        message = str(quiz.get("error") or "答题失败")
        return _with_task_status(
            {"ok": False, "reason": message, "attempts": quiz.get("attempts", [])},
            _task_snapshot("quiz", index, account, "error", message=message),
        )

    draw = draw_one_after_reward(client, "答题奖励")
    events.append(_history_event("quiz", run_id, index, account, draw))
    snapshot = _task_snapshot(
        "quiz",
        index,
        account,
        "completed",
        completed=True,
        message="答题完成，奖励翻牌成功" if draw.get("ok") else "答题完成，但奖励翻牌失败",
    )
    if not draw.get("ok"):
        return _with_task_status({
            "ok": False,
            "reason": f"答题成功但奖励翻牌失败：{draw.get('message') or '未知错误'}",
            "attempts": quiz.get("attempts", []),
            "draw": draw,
        }, snapshot)
    return _with_task_status({
        "ok": True,
        "attempts": quiz.get("attempts", []),
        "draw": draw,
    }, snapshot)


def _ad_account(index: int, account: dict, client: NewAPICheckin, events: list[dict], run_id: str) -> dict:
    name = _safe_account_name(account, index)
    print(f"[{name}] 观看广告")
    task, error = task_status(client, "task2")
    if error:
        return _with_task_status(
            {"ok": False, "reason": error},
            _task_snapshot("ad", index, account, "error", message=error, daily_cap=3),
        )
    if task.get("suspended") is True:
        print("  跳过：广告任务不可用")
        done_count = _safe_int(task.get("done_count"))
        server_daily_cap = _safe_int(task.get("daily_cap"), minimum=1) or 3
        return _with_task_status(
            {"ok": True, "skipped": True, "reason": "ad_task_unavailable"},
            _task_snapshot(
                "ad", index, account, "suspended", message="广告任务不可用",
                done_count=done_count, daily_cap=min(server_daily_cap, 3),
            ),
        )

    done_count, daily_cap, next_available = _ad_values(task)
    if done_count is None or next_available is None:
        message = "广告任务状态字段缺失或格式错误"
        return _with_task_status(
            {"ok": False, "reason": message},
            _task_snapshot(
                "ad", index, account, "error", message=message,
                done_count=done_count, daily_cap=daily_cap,
            ),
        )
    if done_count >= daily_cap:
        print(f"  跳过：已达到每日上限 {done_count}/{daily_cap}")
        return _with_task_status(
            {"ok": True, "skipped": True, "reason": "daily_cap_reached"},
            _ad_snapshot(index, account, task, message="今日广告任务已完成"),
        )
    now_epoch = int(time.time())
    if next_available > now_epoch:
        print(f"  跳过：广告冷却中，还需 {next_available - now_epoch} 秒")
        return _with_task_status(
            {"ok": True, "skipped": True, "reason": "cooldown"},
            _ad_snapshot(index, account, task, message="广告任务冷却中"),
        )

    start = _api_request(client, "开始观看广告", "/api/gwent/ad/start")
    if not start.get("ok"):
        message = "开始广告任务失败"
        return _with_task_status(
            {"ok": False, "reason": message},
            _ad_snapshot(index, account, task, message=message, force_status="error"),
        )
    start_data = start.get("data", {}).get("data")
    start_data = start_data if isinstance(start_data, dict) else {}
    duration = _safe_int(start_data.get("duration_sec"), minimum=1, maximum=MAX_AD_DURATION_SECONDS)
    if duration is None:
        duration = _safe_int(task.get("duration_sec"), minimum=1, maximum=MAX_AD_DURATION_SECONDS)
    if duration is None:
        duration = DEFAULT_AD_DURATION_SECONDS
    time.sleep(duration + 1)

    claim = _api_request(client, "领取广告充能", "/api/gwent/ad/claim")
    if not claim.get("ok"):
        message = "领取广告充能失败"
        return _with_task_status(
            {"ok": False, "reason": message},
            _ad_snapshot(index, account, task, message=message, force_status="error"),
        )

    estimated_task = dict(task)
    estimated_task["done_count"] = min(daily_cap, done_count + 1)
    claim_task = _task_from_api_result(claim, "task2")
    if claim_task:
        for key in ("done_count", "daily_cap", "next_available_at", "status", "suspended"):
            if key in claim_task:
                estimated_task[key] = claim_task[key]

    # 奖励到账后先立即翻牌；状态刷新不能延迟这次奖励翻牌。
    draw = draw_one_after_reward(client, "广告奖励")
    events.append(_history_event("ad", run_id, index, account, draw))
    refreshed_task, refresh_error = task_status(client, "task2")
    final_task = refreshed_task if refreshed_task is not None else estimated_task
    estimated_done, estimated_cap, estimated_next = _ad_values(estimated_task)
    force_snapshot_status = None
    if (
        refresh_error
        and (estimated_done or 0) < estimated_cap
        and (estimated_next is None or estimated_next <= int(time.time()))
    ):
        force_snapshot_status = "unknown"
    snapshot = _ad_snapshot(
        index,
        account,
        final_task,
        message=(
            "广告奖励已领取，状态刷新失败"
            if refresh_error
            else ("广告奖励已领取，奖励翻牌成功" if draw.get("ok") else "广告奖励已领取，但奖励翻牌失败")
        ),
        force_status=force_snapshot_status,
    )
    if not draw.get("ok"):
        return _with_task_status({
            "ok": False,
            "reason": f"广告充能成功但奖励翻牌失败：{draw.get('message') or '未知错误'}",
            "duration_sec": duration,
            "draw": draw,
        }, snapshot)
    return _with_task_status(
        {"ok": True, "duration_sec": duration, "draw": draw},
        snapshot,
    )


def run_task(task_type: str) -> bool:
    if task_type not in TASK_TYPES:
        raise ValueError(f"不支持的任务类型: {task_type}")
    accounts = _load_accounts()
    run_id, run_number, run_attempt = _run_identity(task_type)
    started_at = utc_timestamp()
    events: list[dict] = []
    results: list[dict] = []
    runner = _quiz_account if task_type == "quiz" else _ad_account

    print(f"维云{('每日答题' if task_type == 'quiz' else '广告')}任务：{len(accounts)} 个账号")
    print(f"运行标识: {run_id}")
    for index, account in enumerate(accounts, 1):
        client = NewAPICheckin(
            account.get("url", ""),
            account.get("session", ""),
            account.get("user_id"),
            account.get("cf_clearance"),
        )
        try:
            result = runner(index, account, client, events, run_id)
        except Exception as error:  # pragma: no cover - per-account safety boundary
            message = f"任务执行异常: {type(error).__name__}"
            print(f"[{_safe_account_name(account, index)}] FAIL {message}")
            result = _with_task_status(
                {"ok": False, "reason": message},
                _task_snapshot(
                    task_type,
                    index,
                    account,
                    "error",
                    message=message,
                    daily_cap=3 if task_type == "ad" else None,
                ),
            )
        if not isinstance(result.get("task_status"), dict):
            message = "任务未生成状态快照"
            result = dict(result)
            result["ok"] = False
            result["reason"] = result.get("reason") or message
            result["task_status"] = _task_snapshot(
                task_type,
                index,
                account,
                "error",
                message=message,
                daily_cap=3 if task_type == "ad" else None,
            )
        results.append(result)

    failed = sum(1 for result in results if not result.get("ok"))
    skipped = sum(1 for result in results if result.get("skipped"))
    succeeded = sum(1 for result in results if result.get("ok") and not result.get("skipped"))
    total_quota = sum(
        normalize_gwent_quota(event.get("prize_quota"))
        for event in events
        if event.get("status") == "success"
    )
    print("=" * 50)
    print(f"任务完成: 成功 {succeeded}, 失败 {failed}, 跳过 {skipped}")
    print(f"本轮奖励翻牌总额度: +{total_quota:,}")
    print("=" * 50)

    history_status = "success" if failed == 0 else ("partial" if succeeded > 0 else "error")
    history_saved = _publish_task_draws(
        task_type,
        run_id,
        run_number,
        run_attempt,
        started_at,
        events,
        history_status,
    )
    status_saved = publish_task_status({
        "schema_version": 1,
        "local_date": beijing_local_date(),
        "updated_at": utc_timestamp(),
        "source": task_type,
        "accounts": [result["task_status"] for result in results],
    })
    return failed == 0 and history_saved and status_saved


def main() -> None:
    parser = argparse.ArgumentParser(description="维云答题/广告任务")
    parser.add_argument("--task", choices=TASK_TYPES, required=True, help="quiz 或 ad")
    args = parser.parse_args()
    try:
        ok = run_task(args.task)
    except Exception as error:
        print(f"[错误] 维云任务未完成：{type(error).__name__}: {_safe_message(error)}")
        ok = False
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()

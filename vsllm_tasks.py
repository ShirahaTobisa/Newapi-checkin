#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""维云答题和广告任务。

这些任务只负责领取额外翻牌次数。翻牌本身由独立的 6 小时 5 分钟
工作流统一执行，避免在领取奖励时提前消耗次数。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import requests

from checkin import (
    NewAPICheckin,
    load_config_from_cloud,
    parse_accounts,
)


QUIZ_MAX_ATTEMPTS = 20
DEFAULT_AD_DURATION_SECONDS = 15
MAX_AD_DURATION_SECONDS = 120
TASK_TYPES = ("quiz", "ad")
_SAFE_MESSAGE_RE = re.compile(r"\s+", re.UNICODE)


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


def report_charge_balance(client: NewAPICheckin, reason: str) -> dict:
    """记录奖励后的可用次数，但不消费次数。"""
    try:
        status = client.gwent_status()
    except Exception as error:  # pragma: no cover - defensive boundary for client implementations
        print(f"  {reason}成功；翻牌次数已保留给定时翻牌（余额读取异常: {type(error).__name__}）")
        return {"success": False, "available": None}
    available = status.get("available") if status.get("success") else None
    if available is None:
        print(f"  {reason}成功；翻牌次数已保留给定时翻牌（当前余额暂无法读取）")
        return {"success": False, "available": None}

    charges_current = status.get("charges_current")
    extra_draws_left = status.get("extra_draws_left")
    details = []
    if charges_current is not None:
        details.append(f"基础 {charges_current}")
    if extra_draws_left is not None:
        details.append(f"额外 {extra_draws_left}")
    suffix = f"（{'，'.join(details)}）" if details else ""
    print(f"  {reason}成功；当前可用翻牌次数: {available}{suffix}，由定时翻牌工作流消费")
    return status


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


def _quiz_account(index: int, account: dict, client: NewAPICheckin, _events: list[dict], _run_id: str) -> dict:
    name = account.get("name") or f"账号{index}"
    print(f"[{name}] 每日答题")
    task, error = task_status(client, "task3")
    if error:
        return {"ok": False, "reason": error}
    if task.get("suspended") is True:
        print("  跳过：答题任务已暂停")
        return {"ok": True, "skipped": True, "reason": "quiz_suspended"}
    task_state = str(task.get("status") or "").lower()
    if not task_state:
        message = "答题任务状态缺失"
        return {"ok": False, "reason": message}
    if task_state in {"completed", "done", "success", "claimed"}:
        print(f"  跳过：答题状态为 {task_state}")
        return {"ok": True, "skipped": True, "reason": f"quiz_{task_state}"}
    if task_state not in {"pending", "available", "ready", "in_progress"}:
        message = f"未知答题任务状态: {task_state}"
        return {"ok": False, "reason": message}

    start = _api_request(client, "开始每日答题", "/api/gwent/task3/start")
    question = _question_from_result(start)
    if not start.get("ok") or question is None:
        message = "开始答题失败或题目格式异常"
        return {"ok": False, "reason": message}

    quiz = answer_quiz_until_correct(client, question)
    if not quiz.get("ok"):
        message = str(quiz.get("error") or "答题失败")
        return {"ok": False, "reason": message, "attempts": quiz.get("attempts", [])}

    charge_status = report_charge_balance(client, "答题奖励")
    return {
        "ok": True,
        "attempts": quiz.get("attempts", []),
        "charge_status": charge_status,
    }


def _ad_account(index: int, account: dict, client: NewAPICheckin, _events: list[dict], _run_id: str) -> dict:
    name = account.get("name") or f"账号{index}"
    print(f"[{name}] 观看广告")
    task, error = task_status(client, "task2")
    if error:
        return {"ok": False, "reason": error}
    if task.get("suspended") is True:
        print("  跳过：广告任务不可用")
        return {"ok": True, "skipped": True, "reason": "ad_task_unavailable"}

    done_count = _safe_int(task.get("done_count"))
    daily_cap = _safe_int(task.get("daily_cap"), minimum=1)
    next_available_raw = task.get("next_available_at", 0)
    next_available = 0 if next_available_raw in (None, "") else _safe_int(next_available_raw, minimum=0)
    if done_count is None or daily_cap is None or next_available is None:
        message = "广告任务状态字段缺失或格式错误"
        return {"ok": False, "reason": message}
    if done_count >= daily_cap:
        print(f"  跳过：已达到每日上限 {done_count}/{daily_cap}")
        return {"ok": True, "skipped": True, "reason": "daily_cap_reached"}
    now_epoch = int(time.time())
    if next_available > 10**11:
        next_available //= 1000
    if next_available > now_epoch:
        print(f"  跳过：广告冷却中，还需 {next_available - now_epoch} 秒")
        return {"ok": True, "skipped": True, "reason": "cooldown"}

    start = _api_request(client, "开始观看广告", "/api/gwent/ad/start")
    if not start.get("ok"):
        message = "开始广告任务失败"
        return {"ok": False, "reason": message}
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
        return {"ok": False, "reason": message}

    charge_status = report_charge_balance(client, "广告充能")
    return {"ok": True, "duration_sec": duration, "charge_status": charge_status}


def run_task(task_type: str) -> bool:
    if task_type not in TASK_TYPES:
        raise ValueError(f"不支持的任务类型: {task_type}")
    accounts = _load_accounts()
    run_id, _run_number, _run_attempt = _run_identity(task_type)
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
        results.append(runner(index, account, client, events, run_id))

    failed = sum(1 for result in results if not result.get("ok"))
    executed = sum(1 for result in results if not result.get("skipped"))
    success = len(results) - failed
    readable_balances = sum(
        1
        for result in results
        if isinstance(result.get("charge_status"), dict)
        and result["charge_status"].get("available") is not None
    )
    print("=" * 50)
    print(f"任务完成: 成功 {success}, 失败 {failed}, 跳过 {len(results) - executed}")
    print(f"已完成奖励领取；{readable_balances}/{len(results)} 个账号读取到当前可用翻牌次数")
    print("=" * 50)
    return failed == 0


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

import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from unittest.mock import Mock, patch

from checkin import NewAPICheckin
from vsllm_tasks import (
    _ad_account,
    _api_request,
    _history_event,
    _publish_task_draws,
    _quiz_account,
    answer_quiz_until_correct,
    beijing_local_date,
    choose_known_quiz_answer,
    draw_one_after_reward,
    publish_task_status,
    run_task,
    task_status,
)


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, gets=None, posts=None):
        self.gets = list(gets or [])
        self.posts = list(posts or [])
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.gets.pop(0)

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.posts.pop(0)


def client_with_session(session):
    client = NewAPICheckin("https://vsllm.com", "session", "123")
    client.session = session
    return client


class VsllmTaskTest(unittest.TestCase):
    def test_known_version_question_prefers_v911(self):
        question = {
            "text": "Which version is newer: v9.11 or v9.9?",
            "options": ["v9.9", "v9.11"],
        }
        self.assertEqual(choose_known_quiz_answer(question), 1)

    def test_answer_refreshes_after_wrong_answer_and_stops_on_correct(self):
        session = FakeSession(posts=[
            FakeResponse({"success": True, "data": {"correct": False}}),
            FakeResponse({
                "success": True,
                "data": {"question": {"text": "same question", "options": ["A", "B"]}},
            }),
            FakeResponse({"success": True, "data": {"correct": True}}),
        ])
        client = client_with_session(session)
        question = {"text": "same question", "options": ["A", "B"]}

        with patch("vsllm_tasks.time.sleep") as sleep:
            result = answer_quiz_until_correct(client, question)

        self.assertTrue(result["ok"])
        self.assertEqual([item["answer_index"] for item in result["attempts"]], [0, 1])
        self.assertEqual([call[1].rsplit("/api/gwent/", 1)[-1] for call in session.calls], [
            "task3/answer",
            "task3/start",
            "task3/answer",
        ])
        self.assertEqual(sleep.call_count, 2)

    def test_unknown_answer_schema_fails_closed(self):
        session = FakeSession(posts=[FakeResponse({"success": True, "data": {}})])
        client = client_with_session(session)
        result = answer_quiz_until_correct(
            client,
            {"text": "question", "options": ["A"]},
            sleep_fn=lambda _seconds: None,
        )
        self.assertFalse(result["ok"])
        self.assertIn("格式异常", result["error"])

    def test_task_status_requires_task_object(self):
        session = FakeSession(gets=[FakeResponse({"success": True, "data": {"tasks": {}}})])
        task, error = task_status(client_with_session(session), "task2")
        self.assertIsNone(task)
        self.assertIn("task2", error)

    def test_beijing_local_date_rolls_over_at_utc_16(self):
        now = datetime(2026, 7, 17, 16, 1, tzinfo=timezone.utc)
        self.assertEqual(beijing_local_date(now), "2026-07-18")

    def test_publish_task_status_derives_url_and_uses_bearer_auth(self):
        payload = {
            "schema_version": 1,
            "local_date": "2026-07-18",
            "updated_at": "2026-07-18T00:00:00Z",
            "source": "quiz",
            "accounts": [],
        }
        with (
            patch.dict("os.environ", {
                "HISTORY_URL": "https://relay.example/api/gwent/history",
                "HISTORY_AUTH": "token:history-secret",
                "HISTORY_REQUIRED": "true",
            }, clear=True),
            patch("vsllm_tasks.requests.post", return_value=FakeResponse({"success": True})) as post,
        ):
            saved = publish_task_status(payload)

        self.assertTrue(saved)
        self.assertEqual(post.call_args.args[0], "https://relay.example/api/gwent/task-status")
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer history-secret")
        self.assertEqual(post.call_args.kwargs["json"], payload)

    def test_required_task_status_publish_failure_is_reported(self):
        with (
            patch.dict("os.environ", {
                "TASK_STATUS_URL": "https://relay.example/api/gwent/task-status",
                "HISTORY_AUTH": "history-secret",
                "HISTORY_REQUIRED": "true",
            }, clear=True),
            patch("vsllm_tasks.requests.post", return_value=FakeResponse({}, 503)) as post,
            patch("vsllm_tasks.time.sleep"),
        ):
            saved = publish_task_status({"schema_version": 1})

        self.assertFalse(saved)
        self.assertEqual(post.call_count, 3)

    def test_optional_task_status_publish_failure_does_not_fail_task(self):
        with (
            patch.dict("os.environ", {
                "TASK_STATUS_URL": "https://relay.example/api/gwent/task-status",
                "HISTORY_AUTH": "history-secret",
                "HISTORY_REQUIRED": "false",
            }, clear=True),
            patch("vsllm_tasks.requests.post", return_value=FakeResponse({}, 503)),
            patch("vsllm_tasks.time.sleep"),
        ):
            self.assertTrue(publish_task_status({"schema_version": 1}))

    def test_quiz_completed_check_produces_completed_snapshot(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        events = []
        with patch("vsllm_tasks.task_status", return_value=({"status": "completed"}, None)):
            result = _quiz_account(1, account, client, events, "quiz:1:1")

        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["task_status"]["status"], "completed")
        self.assertTrue(result["task_status"]["completed"])
        self.assertEqual(events, [])

    def test_quiz_status_error_produces_error_snapshot(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        with patch("vsllm_tasks.task_status", return_value=(None, "读取任务状态失败")):
            result = _quiz_account(1, account, Mock(), [], "quiz:1:1")

        self.assertFalse(result["ok"])
        self.assertEqual(result["task_status"]["status"], "error")
        self.assertFalse(result["task_status"]["completed"])

    def test_task_snapshot_redacts_sensitive_account_name(self):
        account = {
            "url": "https://vsllm.com",
            "session": "session",
            "user_id": "1",
            "name": "cookie=must-not-escape",
        }
        with patch("vsllm_tasks.task_status", return_value=(None, "读取任务状态失败")):
            result = _quiz_account(1, account, Mock(), [], "quiz:1:1")

        self.assertNotIn("must-not-escape", result["task_status"]["account_name"])

    def test_history_event_redacts_sensitive_account_name(self):
        account = {
            "url": "https://vsllm.com",
            "user_id": "1",
            "name": "cookie=must-not-escape",
        }
        event = _history_event("quiz", "quiz:1:1", 1, account, {
            "status": "success",
            "message": "翻牌成功",
            "prize_name": "测试卡",
            "prize_quota": 10,
            "prize_rarity": "common",
            "bonus_percent": 50,
        })
        self.assertNotIn("must-not-escape", event["account_name"])
        self.assertEqual(event["account_name"], "cookie=***")

    def test_draw_after_reward_calls_gwent_draw_exactly_once(self):
        client = Mock()
        client.gwent_draw.return_value = {
            "success": True,
            "message": "翻牌成功",
            "prize_name": "黄金卡",
            "prize_quota": "1,250",
            "prize_rarity": "rare",
            "bonus_percent": "0.5",
        }
        result = draw_one_after_reward(client, "广告奖励")
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["prize_quota"], 1250)
        self.assertEqual(result["bonus_percent"], 50)
        client.gwent_draw.assert_called_once_with()

    def test_draw_after_reward_classifies_cooldown(self):
        client = Mock()
        client.gwent_draw.return_value = {"success": False, "message": "冷却中：暂无可用次数"}
        result = draw_one_after_reward(client, "答题奖励")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "cooldown")
        client.gwent_draw.assert_called_once_with()

    def test_draw_after_reward_converts_client_exception_to_error(self):
        client = Mock()
        client.gwent_draw.side_effect = RuntimeError("secret must not escape")
        result = draw_one_after_reward(client, "答题奖励")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertNotIn("secret", result["message"])
        client.gwent_draw.assert_called_once_with()

    def test_quiz_reward_is_followed_by_one_bonus_draw(self):
        session = FakeSession(
            gets=[
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task3": {"status": "pending"}}},
                }),
            ],
            posts=[
                FakeResponse({
                    "success": True,
                    "data": {"question": {"text": "Q", "options": ["A"]}},
                }),
                FakeResponse({"success": True, "data": {"correct": True}}),
                FakeResponse({"success": True, "message": "50% 加成已激活"}),
                FakeResponse({
                    "success": True,
                    "message": "翻牌成功",
                    "data": {
                        "prize": {"name": "奖励卡", "quota": 10, "rarity": "rare"},
                        "bonus_pct": 50,
                    },
                }),
            ],
        )
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        events = []
        with patch("vsllm_tasks.time.sleep"):
            result = _quiz_account(1, account, client_with_session(session), events, "quiz:1:1")
        self.assertTrue(result["ok"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["task_type"], "quiz")
        self.assertEqual(events[0]["status"], "success")
        self.assertEqual(events[0]["prize_quota"], 10)
        self.assertEqual(result["task_status"]["status"], "completed")
        self.assertTrue(result["task_status"]["completed"])
        self.assertEqual([call[1].rsplit("/api/gwent", 1)[-1] for call in session.calls], [
            "/status",
            "/task3/start",
            "/task3/answer",
            "/share_unlock",
            "/draw",
        ])

    def test_quiz_draw_failure_is_recorded_and_fails_account(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        client.gwent_draw.return_value = {"success": False, "message": "冷却中：暂无可用次数"}
        events = []
        with (
            patch("vsllm_tasks.task_status", return_value=({"status": "pending"}, None)),
            patch("vsllm_tasks._api_request", return_value={
                "ok": True,
                "data": {"data": {"question": {"text": "Q", "options": ["A"]}}},
            }),
            patch("vsllm_tasks.answer_quiz_until_correct", return_value={"ok": True, "attempts": []}),
        ):
            result = _quiz_account(1, account, client, events, "quiz:1:1")

        self.assertFalse(result["ok"])
        self.assertEqual(events[0]["status"], "cooldown")
        self.assertEqual(events[0]["task_type"], "quiz")
        self.assertEqual(result["task_status"]["status"], "completed")
        self.assertTrue(result["task_status"]["completed"])
        client.gwent_draw.assert_called_once_with()

    def test_ad_reward_is_followed_by_one_bonus_draw(self):
        session = FakeSession(
            gets=[
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task2": {"done_count": 0, "daily_cap": 3, "next_available_at": 0}}},
                }),
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task2": {"done_count": 1, "daily_cap": 3, "next_available_at": 2_000_000_000}}},
                }),
            ],
            posts=[
                FakeResponse({"success": True, "data": {"duration_sec": 1}}),
                FakeResponse({"success": True, "message": "领取成功"}),
                FakeResponse({"success": True, "message": "50% 加成已激活"}),
                FakeResponse({
                    "success": True,
                    "message": "翻牌成功",
                    "data": {"prize": {"name": "奖励卡", "quota": 20}},
                }),
            ],
        )
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        events = []
        with patch("vsllm_tasks.time.sleep"):
            result = _ad_account(1, account, client_with_session(session), events, "ad:1:1")
        self.assertTrue(result["ok"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["task_type"], "ad")
        self.assertEqual(events[0]["status"], "success")
        self.assertEqual(events[0]["prize_quota"], 20)
        self.assertEqual([call[1].rsplit("/api/gwent", 1)[-1] for call in session.calls], [
            "/status",
            "/ad/start",
            "/ad/claim",
            "/share_unlock",
            "/draw",
            "/status",
        ])
        self.assertEqual(result["task_status"]["status"], "cooldown")
        self.assertEqual(result["task_status"]["done_count"], 1)
        self.assertEqual(result["task_status"]["daily_cap"], 3)

    def test_ad_daily_cap_is_hard_limited_to_three(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        events = []
        with patch(
            "vsllm_tasks.task_status",
            return_value=({"done_count": 3, "daily_cap": 99, "next_available_at": 0}, None),
        ):
            result = _ad_account(1, account, client, events, "ad:1:1")
        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "daily_cap_reached")
        self.assertEqual(result["task_status"]["status"], "completed")
        self.assertEqual(result["task_status"]["done_count"], 3)
        self.assertEqual(result["task_status"]["daily_cap"], 3)
        self.assertEqual(events, [])
        client.gwent_draw.assert_not_called()

    def test_ad_cooldown_check_produces_count_and_iso_timestamp(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        task = {"done_count": 1, "daily_cap": 3, "next_available_at": 2_000}
        with (
            patch("vsllm_tasks.task_status", return_value=(task, None)),
            patch("vsllm_tasks.time.time", return_value=1_000),
        ):
            result = _ad_account(1, account, Mock(), [], "ad:1:1")

        snapshot = result["task_status"]
        self.assertTrue(result["skipped"])
        self.assertEqual(snapshot["status"], "cooldown")
        self.assertEqual(snapshot["done_count"], 1)
        self.assertEqual(snapshot["daily_cap"], 3)
        self.assertEqual(snapshot["next_available_at"], "1970-01-01T00:33:20Z")

    def test_ad_claim_uses_response_count_when_status_refresh_fails(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        client.gwent_draw.return_value = {
            "success": True,
            "message": "翻牌成功",
            "prize_name": "奖励卡",
            "prize_quota": 20,
        }
        initial = {"done_count": 1, "daily_cap": 3, "next_available_at": 0}
        api_results = [
            {"ok": True, "data": {"data": {"duration_sec": 1}}},
            {
                "ok": True,
                "data": {"data": {"done_count": 2, "daily_cap": 3, "next_available_at": 2_000}},
            },
        ]
        events = []
        with (
            patch("vsllm_tasks.task_status", side_effect=[(initial, None), (None, "刷新失败")]),
            patch("vsllm_tasks._api_request", side_effect=api_results),
            patch("vsllm_tasks.time.sleep"),
            patch("vsllm_tasks.time.time", return_value=1_000),
        ):
            result = _ad_account(1, account, client, events, "ad:1:1")

        self.assertTrue(result["ok"])
        self.assertEqual(result["task_status"]["status"], "cooldown")
        self.assertEqual(result["task_status"]["done_count"], 2)
        self.assertEqual(result["task_status"]["daily_cap"], 3)
        self.assertEqual(len(events), 1)
        client.gwent_draw.assert_called_once_with()

    def test_ad_status_missing_required_fields_fails_without_starting(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        with patch("vsllm_tasks.task_status", return_value=({}, None)):
            events = []
            result = _ad_account(1, account, client, events, "ad:1:1")
        self.assertFalse(result["ok"])
        self.assertEqual(result["task_status"]["status"], "error")
        client.session.post.assert_not_called()

    def test_api_log_does_not_include_response_body(self):
        session = FakeSession(gets=[FakeResponse({
            "success": True,
            "message": "ok",
            "data": {"secret": "session=must-not-log"},
        })])
        output = StringIO()
        with redirect_stdout(output):
            _api_request(client_with_session(session), "测试状态", "/api/gwent/status", method="GET")
        self.assertNotIn("must-not-log", output.getvalue())

    def test_history_run_uses_task_source_and_plans_one_draw(self):
        event = {
            "event_id": "quiz:1:1:key:1",
            "account_key": "key",
            "account_name": "账号1",
            "attempt": 1,
            "occurred_at": "2026-07-18T00:00:00Z",
            "status": "error",
            "prize_name": None,
            "prize_quota": 0,
            "prize_rarity": "unknown",
            "bonus_percent": 0,
            "message": "翻牌失败",
            "task_type": "quiz",
        }
        with patch("vsllm_tasks.publish_gwent_history", return_value=True) as publish:
            saved = _publish_task_draws(
                "quiz", "quiz:1:1", 7, 1, "2026-07-18T00:00:00Z", [event], "error"
            )
        self.assertTrue(saved)
        payload = publish.call_args.args[0]
        self.assertEqual(payload["run"]["source"], "quiz")
        self.assertEqual(payload["run"]["planned_draws"], 1)
        self.assertEqual(payload["events"], [event])

    def test_empty_task_run_does_not_publish_history(self):
        with patch("vsllm_tasks.publish_gwent_history") as publish:
            saved = _publish_task_draws(
                "ad", "ad:1:1", 7, 1, "2026-07-18T00:00:00Z", [], "success"
            )
        self.assertTrue(saved)
        publish.assert_not_called()

    def test_run_task_returns_failure_after_failed_reward_draw_but_publishes_event(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}

        def failed_draw_runner(_index, _account, _client, events, _run_id):
            events.append({
                "event_id": "quiz:1:1:key:1",
                "account_key": "key",
                "account_name": "账号1",
                "attempt": 1,
                "occurred_at": "2026-07-18T00:00:00Z",
                "status": "error",
                "prize_name": None,
                "prize_quota": 0,
                "prize_rarity": "unknown",
                "bonus_percent": 0,
                "message": "翻牌失败",
                "task_type": "quiz",
            })
            return {"ok": False, "reason": "答题成功但奖励翻牌失败"}

        with (
            patch("vsllm_tasks._load_accounts", return_value=[account]),
            patch("vsllm_tasks._quiz_account", side_effect=failed_draw_runner),
            patch("vsllm_tasks.publish_gwent_history", return_value=True) as publish,
        ):
            result = run_task("quiz")
        self.assertFalse(result)
        self.assertEqual(publish.call_count, 1)
        self.assertEqual(publish.call_args.args[0]["events"][0]["status"], "error")

    def test_run_task_publishes_status_even_when_history_has_no_draw(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}

        def completed_runner(_index, _account, _client, _events, _run_id):
            return {
                "ok": True,
                "skipped": True,
                "reason": "quiz_completed",
                "task_status": {
                    "account_key": "safe-key",
                    "account_name": "账号1",
                    "task_type": "quiz",
                    "status": "completed",
                    "completed": True,
                    "checked_at": "2026-07-18T00:00:00Z",
                },
            }

        with (
            patch("vsllm_tasks._load_accounts", return_value=[account]),
            patch("vsllm_tasks._quiz_account", side_effect=completed_runner),
            patch("vsllm_tasks.publish_gwent_history") as history,
            patch("vsllm_tasks.publish_task_status", return_value=True) as publish_status,
            patch("vsllm_tasks.beijing_local_date", return_value="2026-07-18"),
        ):
            result = run_task("quiz")

        self.assertTrue(result)
        history.assert_not_called()
        payload = publish_status.call_args.args[0]
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["local_date"], "2026-07-18")
        self.assertEqual(payload["source"], "quiz")
        self.assertEqual(payload["accounts"][0]["status"], "completed")

    def test_required_status_failure_fails_run_after_draw_history_is_saved(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}

        def successful_runner(_index, _account, _client, events, _run_id):
            events.append({
                "event_id": "quiz:1:1:key:1",
                "account_key": "key",
                "account_name": "账号1",
                "attempt": 1,
                "occurred_at": "2026-07-18T00:00:00Z",
                "status": "success",
                "prize_name": "奖励卡",
                "prize_quota": 10,
                "prize_rarity": "rare",
                "bonus_percent": 50,
                "message": "翻牌成功",
                "task_type": "quiz",
            })
            return {
                "ok": True,
                "task_status": {
                    "account_key": "key",
                    "account_name": "账号1",
                    "task_type": "quiz",
                    "status": "completed",
                    "completed": True,
                    "checked_at": "2026-07-18T00:00:00Z",
                },
            }

        with (
            patch("vsllm_tasks._load_accounts", return_value=[account]),
            patch("vsllm_tasks._quiz_account", side_effect=successful_runner),
            patch("vsllm_tasks.publish_gwent_history", return_value=True) as history,
            patch("vsllm_tasks.publish_task_status", return_value=False) as publish_status,
        ):
            result = run_task("quiz")

        self.assertFalse(result)
        history.assert_called_once()
        publish_status.assert_called_once()


if __name__ == "__main__":
    unittest.main()

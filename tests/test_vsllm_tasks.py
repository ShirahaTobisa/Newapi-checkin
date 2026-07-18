import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import Mock, patch

from checkin import NewAPICheckin
from vsllm_tasks import (
    _ad_account,
    _api_request,
    _publish_task_draws,
    _quiz_account,
    answer_quiz_until_correct,
    choose_known_quiz_answer,
    draw_one_after_reward,
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
        client.gwent_draw.assert_called_once_with()

    def test_ad_reward_is_followed_by_one_bonus_draw(self):
        session = FakeSession(
            gets=[
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task2": {"done_count": 0, "daily_cap": 3, "next_available_at": 0}}},
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
        ])

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
        self.assertEqual(events, [])
        client.gwent_draw.assert_not_called()

    def test_ad_status_missing_required_fields_fails_without_starting(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        with patch("vsllm_tasks.task_status", return_value=({}, None)):
            events = []
            result = _ad_account(1, account, client, events, "ad:1:1")
        self.assertFalse(result["ok"])
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


if __name__ == "__main__":
    unittest.main()

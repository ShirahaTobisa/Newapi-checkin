import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import Mock, patch

from checkin import NewAPICheckin
from vsllm_tasks import (
    _ad_account,
    _api_request,
    _quiz_account,
    answer_quiz_until_correct,
    choose_known_quiz_answer,
    report_charge_balance,
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

    def test_report_charge_balance_does_not_draw(self):
        client = Mock()
        client.gwent_status.return_value = {
            "success": True,
            "available": 4,
            "charges_current": 2,
            "extra_draws_left": 2,
        }
        result = report_charge_balance(client, "广告奖励")
        self.assertEqual(result["available"], 4)
        self.assertEqual(result["extra_draws_left"], 2)
        client.gwent_draw.assert_not_called()

    def test_report_charge_balance_handles_unavailable_status(self):
        client = Mock()
        client.gwent_status.return_value = {"success": False, "available": None}
        result = report_charge_balance(client, "答题奖励")
        self.assertIsNone(result["available"])
        client.gwent_draw.assert_not_called()

    def test_quiz_reward_only_adds_a_charge(self):
        session = FakeSession(
            gets=[
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task3": {"status": "pending"}}},
                }),
                FakeResponse({
                    "success": True,
                    "data": {"charges_current": 1, "extra_draws_left": 0},
                }),
            ],
            posts=[
                FakeResponse({
                    "success": True,
                    "data": {"question": {"text": "Q", "options": ["A"]}},
                }),
                FakeResponse({"success": True, "data": {"correct": True}}),
            ],
        )
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        events = []
        with patch("vsllm_tasks.time.sleep"):
            result = _quiz_account(1, account, client_with_session(session), events, "quiz:1:1")
        self.assertTrue(result["ok"])
        self.assertEqual(events, [])
        self.assertEqual(result["charge_status"]["available"], 1)
        self.assertEqual([call[1].rsplit("/api/gwent", 1)[-1] for call in session.calls], [
            "/status",
            "/task3/start",
            "/task3/answer",
            "/status",
        ])

    def test_ad_reward_only_adds_a_charge(self):
        session = FakeSession(
            gets=[
                FakeResponse({
                    "success": True,
                    "data": {"tasks": {"task2": {"done_count": 0, "daily_cap": 3, "next_available_at": 0}}},
                }),
                FakeResponse({
                    "success": True,
                    "data": {"charges_current": 1, "extra_draws_left": 0},
                }),
            ],
            posts=[
                FakeResponse({"success": True, "data": {"duration_sec": 1}}),
                FakeResponse({"success": True, "message": "领取成功"}),
            ],
        )
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        events = []
        with patch("vsllm_tasks.time.sleep"):
            result = _ad_account(1, account, client_with_session(session), events, "ad:1:1")
        self.assertTrue(result["ok"])
        self.assertEqual(events, [])
        self.assertEqual(result["charge_status"]["available"], 1)
        self.assertEqual([call[1].rsplit("/api/gwent", 1)[-1] for call in session.calls], [
            "/status",
            "/ad/start",
            "/ad/claim",
            "/status",
        ])

    def test_ad_status_missing_required_fields_fails_without_starting(self):
        account = {"url": "https://vsllm.com", "session": "session", "user_id": "1", "name": "账号1"}
        client = Mock()
        with patch("vsllm_tasks.task_status", return_value=({"done_count": 0}, None)):
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


if __name__ == "__main__":
    unittest.main()

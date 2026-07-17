import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
from unittest.mock import Mock, patch

from checkin import (
    NewAPICheckin,
    filter_gwent_targets,
    gwent_event_status,
    history_account_key,
    load_gwent_last_success,
    normalize_gwent_bonus_percent,
    normalize_gwent_quota,
    publish_gwent_history,
    run_gwent_tasks,
)


def response(status_code, payload):
    mocked = Mock()
    mocked.status_code = status_code
    mocked.json.return_value = payload
    return mocked


class GwentDrawTest(unittest.TestCase):
    def make_client(self, base_url='https://vsllm.com'):
        client = NewAPICheckin(base_url, 'test-session', '123')
        client.session.post = Mock()
        client.session.get = Mock(return_value=response(
            200,
            {'success': True, 'data': {'charges_current': 3, 'extra_draws_left': 0}},
        ))
        return client

    def test_only_exact_vsllm_hostname_matches(self):
        self.assertTrue(self.make_client('https://vsllm.com/').is_vsllm())
        self.assertFalse(self.make_client('https://evil-vsllm.com').is_vsllm())
        self.assertFalse(self.make_client('https://vsllm.com.example.org').is_vsllm())

    def test_unlocks_bonus_before_drawing_and_parses_prize(self):
        client = self.make_client()
        client.session.post.side_effect = [
            response(200, {'success': True, 'message': '分享加成已激活'}),
            response(200, {
                'success': True,
                'message': '抽奖成功',
                'data': {
                    'prize': {'name': '黄金卡', 'quota': 150, 'rarity': 'rare'},
                    'bonus_pct': 50,
                },
            }),
        ]

        result = client.gwent_draw()

        self.assertTrue(result['success'])
        self.assertEqual(result['prize_name'], '黄金卡')
        self.assertEqual(result['prize_quota'], 150)
        self.assertEqual(result['bonus_percent'], 50)
        self.assertEqual(
            [call.args[0] for call in client.session.post.call_args_list],
            [
                'https://vsllm.com/api/gwent/share_unlock',
                'https://vsllm.com/api/gwent/draw',
            ],
        )

    def test_does_not_draw_when_unlock_fails(self):
        client = self.make_client()
        client.session.post.return_value = response(
            403, {'success': False, 'message': '加成不可用'}
        )

        result = client.gwent_draw()

        self.assertFalse(result['success'])
        self.assertEqual(client.session.post.call_count, 1)

    def test_already_unlocked_is_nonfatal(self):
        client = self.make_client()
        client.session.post.side_effect = [
            response(409, {'success': False, 'message': '加成已经激活'}),
            response(200, {
                'success': True,
                'data': {'prize': {'name': '普通卡', 'quota': 20}},
            }),
        ]

        result = client.gwent_draw()

        self.assertTrue(result['success'])
        self.assertEqual(client.session.post.call_count, 2)

    def test_draw_many_runs_requested_number_of_times(self):
        client = self.make_client()
        client.gwent_draw = Mock(return_value={'success': True})

        results = client.gwent_draw_many(3)

        self.assertEqual(len(results), 3)
        self.assertEqual(client.gwent_draw.call_count, 3)

    def test_draw_many_stops_after_first_failure(self):
        client = self.make_client()
        client.gwent_draw = Mock(side_effect=[
            {'success': True},
            {'success': False, 'message': '冷却中'},
            {'success': True},
        ])

        results = client.gwent_draw_many(3)

        self.assertEqual(len(results), 2)
        self.assertEqual(client.gwent_draw.call_count, 2)

    def test_draw_many_does_not_request_more_than_available_charges(self):
        client = self.make_client()
        client.session.get.return_value = response(
            200,
            {'success': True, 'data': {'charges_current': 2, 'extra_draws_left': 0}},
        )
        client.gwent_draw = Mock(side_effect=[
            {'success': True, 'available_after': 1},
            {'success': True, 'available_after': 0},
        ])

        results = client.gwent_draw_many(3)

        self.assertEqual(len(results), 3)
        self.assertEqual(client.gwent_draw.call_count, 2)
        self.assertEqual(results[-1]['message'], '冷却中：当前没有可用翻牌次数')

    def test_history_account_key_is_stable_without_exposing_user_id(self):
        account = {'url': 'https://vsllm.com', 'user_id': '6200', 'name': '账号3'}

        first = history_account_key(account, 3)
        second = history_account_key(account, 99)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 16)
        self.assertNotIn('6200', first)

    def test_event_status_distinguishes_cooldown_and_auth(self):
        self.assertEqual(gwent_event_status({'success': True}), 'success')
        self.assertEqual(gwent_event_status({'message': '还在冷却中'}), 'cooldown')
        self.assertEqual(gwent_event_status({'message': 'cooldown: too soon'}), 'cooldown')
        self.assertEqual(gwent_event_status({'message': 'Session 认证失败'}), 'auth')
        self.assertEqual(gwent_event_status({'message': '网络错误'}), 'error')

    def test_schedule_guard_skips_until_six_hours_and_five_minutes(self):
        account = {'url': 'https://vsllm.com', 'user_id': '6200', 'name': '账号3'}
        target = (3, account, Mock())
        now = datetime(2026, 7, 18, 0, 0, tzinfo=timezone.utc)
        key = history_account_key(account, 3)

        eligible, skipped = filter_gwent_targets(
            [target],
            {key: now - timedelta(hours=6, minutes=4, seconds=59)},
            now=now,
        )
        self.assertEqual(eligible, [])
        self.assertEqual(len(skipped), 1)

        eligible, skipped = filter_gwent_targets(
            [target],
            {key: now - timedelta(hours=6, minutes=5)},
            now=now,
        )
        self.assertEqual(eligible, [target])
        self.assertEqual(skipped, [])

    @patch('checkin.requests.get')
    def test_schedule_history_uses_latest_success_per_account(self, get):
        get.return_value = response(200, {
            'schema_version': 1,
            'events': [
                {'account_key': 'aaaaaaaaaaaaaaaa', 'status': 'success', 'occurred_at': '2026-07-17T10:00:00Z'},
                {'account_key': 'aaaaaaaaaaaaaaaa', 'status': 'cooldown', 'occurred_at': '2026-07-17T11:00:00Z'},
                {'account_key': 'aaaaaaaaaaaaaaaa', 'status': 'success', 'occurred_at': '2026-07-17T12:00:00Z'},
            ],
        })

        latest = load_gwent_last_success('https://relay.example/api/gwent/history')

        self.assertEqual(latest['aaaaaaaaaaaaaaaa'].hour, 12)
        get.assert_called_once()

    def test_normalize_gwent_quota_accepts_numeric_strings(self):
        self.assertEqual(normalize_gwent_quota('1,250'), 1250)
        self.assertEqual(normalize_gwent_quota(12.9), 12)
        self.assertEqual(normalize_gwent_quota('not-a-number'), 0)
        self.assertEqual(normalize_gwent_bonus_percent('0.5'), 50)
        self.assertEqual(normalize_gwent_bonus_percent(50), 50)

    @patch('checkin.load_gwent_last_success')
    @patch('checkin.NewAPICheckin')
    def test_schedule_guard_prevents_early_draw_requests(self, client_class, load_history):
        account = {'url': 'https://vsllm.com', 'session': 'test-session', 'user_id': '123', 'name': '主账号'}
        client = client_class.return_value
        client.is_vsllm.return_value = True
        client.gwent_draw_many.return_value = []
        key = history_account_key(account, 1)
        load_history.return_value = {
            key: datetime.now(timezone.utc) - timedelta(minutes=10),
        }

        with patch.dict('os.environ', {
            'GWENT_SCHEDULE_GUARD': 'true',
            'GWENT_FORCE': 'false',
            'GWENT_MIN_INTERVAL_SECONDS': '21900',
            'HISTORY_URL': 'https://relay.example/api/gwent/history',
        }, clear=False):
            self.assertTrue(run_gwent_tasks([account], 3))

        client.gwent_draw_many.assert_not_called()

    @patch('checkin.publish_gwent_history', return_value=True)
    @patch('checkin.NewAPICheckin')
    def test_partial_run_prints_account_and_global_quota(self, client_class, _publish):
        account = {'url': 'https://vsllm.com', 'session': 'test-session', 'user_id': '123', 'name': '主账号'}
        client = client_class.return_value
        client.is_vsllm.return_value = True
        client.get_user_info.return_value = {'username': 'tester'}
        client.gwent_draw_many.return_value = [
            {
                'success': True,
                'unlock_success': True,
                'unlock_message': '已激活',
                'message': '抽奖成功',
                'prize_name': '黄金卡',
                'prize_quota': '100',
                'prize_rarity': 'rare',
                'bonus_percent': 50,
            },
            {
                'success': True,
                'unlock_success': True,
                'unlock_message': '已激活',
                'message': '抽奖成功',
                'prize_name': '白银卡',
                'prize_quota': 200,
                'prize_rarity': 'common',
                'bonus_percent': 50,
            },
            {
                'success': False,
                'unlock_success': True,
                'unlock_message': '已激活',
                'message': '冷却中',
                'prize_quota': None,
                'prize_rarity': 'unknown',
                'bonus_percent': 50,
            },
        ]

        output = StringIO()
        with patch.dict('os.environ', {
            'GWENT_SCHEDULE_GUARD': 'false',
            'GWENT_FORCE': 'false',
            'HISTORY_URL': 'https://relay.example/api/gwent/history',
            'HISTORY_AUTH': 'token:history-secret',
            'HISTORY_REQUIRED': 'true',
        }, clear=False), redirect_stdout(output):
            self.assertTrue(run_gwent_tasks([account], 3))

        text = output.getvalue()
        self.assertIn('本轮额度 +300', text)
        self.assertIn('本轮所有账号额度: +300', text)

    @patch('checkin.publish_gwent_history', return_value=True)
    @patch('checkin.NewAPICheckin')
    def test_english_cooldown_is_not_counted_as_error(self, client_class, _publish):
        account = {'url': 'https://vsllm.com', 'session': 'test-session', 'user_id': '123', 'name': '主账号'}
        client = client_class.return_value
        client.is_vsllm.return_value = True
        client.get_user_info.return_value = {'username': 'tester'}
        client.gwent_draw_many.return_value = [{
            'success': False,
            'unlock_success': False,
            'message': 'cooldown: too soon',
            'prize_quota': None,
            'prize_rarity': 'unknown',
            'bonus_percent': 0,
        }]

        output = StringIO()
        with patch.dict('os.environ', {
            'GWENT_SCHEDULE_GUARD': 'false',
            'GWENT_FORCE': 'false',
            'HISTORY_URL': 'https://relay.example/api/gwent/history',
            'HISTORY_AUTH': 'token:history-secret',
            'HISTORY_REQUIRED': 'true',
        }, clear=False), redirect_stdout(output):
            self.assertTrue(run_gwent_tasks([account], 3))

        text = output.getvalue()
        self.assertIn('剩余次数仍在冷却', text)
        self.assertIn('实际错误 0', text)

    @patch('checkin.time.sleep')
    @patch('checkin.requests.post')
    def test_history_publish_uses_bearer_token_and_never_logs_it(self, post, _sleep):
        response_mock = Mock(status_code=200)
        response_mock.json.return_value = {'success': True, 'duplicate': False}
        post.return_value = response_mock
        payload = {'schema_version': 1, 'run': {}, 'events': []}

        with patch.dict('os.environ', {
            'HISTORY_URL': 'https://relay.example/api/gwent/history',
            'HISTORY_AUTH': 'token:history-secret',
            'HISTORY_REQUIRED': 'true',
        }, clear=False):
            self.assertTrue(publish_gwent_history(payload))

        _, kwargs = post.call_args
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer history-secret')
        self.assertEqual(kwargs['json'], payload)


if __name__ == '__main__':
    unittest.main()

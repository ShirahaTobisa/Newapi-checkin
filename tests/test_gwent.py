import unittest
from unittest.mock import Mock, patch

from checkin import (
    NewAPICheckin,
    gwent_event_status,
    history_account_key,
    publish_gwent_history,
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
        self.assertEqual(gwent_event_status({'message': 'Session 认证失败'}), 'auth')
        self.assertEqual(gwent_event_status({'message': '网络错误'}), 'error')

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

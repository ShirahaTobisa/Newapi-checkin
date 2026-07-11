import unittest
from unittest.mock import Mock

from checkin import NewAPICheckin


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


if __name__ == '__main__':
    unittest.main()

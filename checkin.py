#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NewAPI 自动签到脚本
支持多账号签到，通过 GitHub Actions 定时执行
"""

import os
import sys
import json
import base64
import hashlib
import math
import time
import requests
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse


GWENT_MIN_INTERVAL_SECONDS = 2 * 60 * 60

try:
    from cf_bypass import detect_cloudflare_block, CloudflareBypasser
    CF_BYPASS_AVAILABLE = True
except ImportError:
    CF_BYPASS_AVAILABLE = False
    detect_cloudflare_block = None
    CloudflareBypasser = None

try:
    from dingtalk_notifier import send_checkin_notification
except ImportError:
    send_checkin_notification = None


class NewAPICheckin:
    """NewAPI 签到类"""

    @staticmethod
    def _mask_url(url: str) -> str:
        """
        脱敏 URL，隐藏域名细节
        例如: https://api.example.com -> https://api.***.**
        """
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            domain_parts = parsed.netloc.split('.')
            if len(domain_parts) >= 2:
                # 保留第一部分和最后一部分，中间用 *** 代替
                masked_domain = f"{domain_parts[0]}.***." + '.'.join(domain_parts[-1:])
            else:
                masked_domain = '***'
            return f"{parsed.scheme}://{masked_domain}"
        except Exception:
            return 'https://***'

    @staticmethod
    def _mask_user_id(user_id: str) -> str:
        """
        脱敏用户ID
        例如: 1429 -> ****
        """
        return '****'

    def __init__(self, base_url: str, session_cookie: str, user_id: str = None, cf_clearance: str = None):
        self.base_url = base_url.rstrip('/')
        self.session_cookie = session_cookie
        self.original_cf_clearance = cf_clearance
        self.cf_bypassed = False
        self.session = requests.Session()
        self.session.cookies.set('session', session_cookie)

        if cf_clearance:
            self.session.cookies.set('cf_clearance', cf_clearance)

        self.session.headers.update({
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        })

        if user_id:
            self.user_id = user_id
            self.session.headers.update({'new-api-user': str(user_id)})
        else:
            self.user_id = self._extract_user_id_from_session(session_cookie)
            if self.user_id:
                self.session.headers.update({'new-api-user': str(self.user_id)})

    def is_vsllm(self) -> bool:
        """判断当前账号是否为维云站点。"""
        return (urlparse(self.base_url).hostname or '').lower().rstrip('.') == 'vsllm.com'

    @staticmethod
    def _gwent_message(data: dict, default: str) -> str:
        message = data.get('message') if isinstance(data, dict) else None
        return str(message) if message else default

    def gwent_status(self) -> dict:
        """读取维云当前可用翻牌次数；状态接口失败时交给 draw 接口兜底。"""
        if not self.is_vsllm():
            return {'success': False, 'available': None}
        try:
            response = self.session.get(f'{self.base_url}/api/gwent/status', timeout=30)
            data = response.json()
        except (requests.exceptions.RequestException, json.JSONDecodeError, ValueError, TypeError):
            return {'success': False, 'available': None}

        if not (200 <= response.status_code < 300 and isinstance(data, dict) and data.get('success')):
            return {'success': False, 'available': None}
        payload = data.get('data') or {}
        if not isinstance(payload, dict):
            return {'success': False, 'available': None}
        has_charge_fields = 'charges_current' in payload or 'extra_draws_left' in payload
        charges_current = normalize_gwent_quota(payload.get('charges_current'))
        extra_draws_left = normalize_gwent_quota(payload.get('extra_draws_left'))
        return {
            'success': True,
            'available': charges_current + extra_draws_left if has_charge_fields else None,
            'charges_current': charges_current,
            'extra_draws_left': extra_draws_left,
            'next_available_at': normalize_gwent_quota(payload.get('next_available_at')),
            'next_charge_at': normalize_gwent_quota(payload.get('next_charge_at')),
            'cooldown_seconds': normalize_gwent_quota(payload.get('cooldown_seconds')),
        }

    def gwent_draw(self) -> dict:
        """为维云账号激活下一抽 50% 分享加成并翻牌。"""
        result = {
            'success': False,
            'message': '',
            'unlock_success': False,
            'unlock_message': '',
            'prize_name': None,
            'prize_quota': None,
            'prize_rarity': None,
            'bonus_percent': None,
            'available_after': None,
            'charges_current': None,
            'extra_draws_left': None,
        }

        if not self.is_vsllm():
            result['message'] = '非维云站点，已跳过翻牌'
            return result

        try:
            unlock_resp = self.session.post(
                f'{self.base_url}/api/gwent/share_unlock', timeout=30
            )
            try:
                unlock_data = unlock_resp.json()
            except (json.JSONDecodeError, ValueError):
                result['message'] = f'加成解锁响应格式错误 (HTTP {unlock_resp.status_code})'
                return result

            unlock_message = self._gwent_message(unlock_data, '50% 加成已解锁')
            already_unlocked = any(
                marker in unlock_message.lower()
                for marker in ('已解锁', '已激活', '已经', 'already', 'activated')
            )
            unlock_success = (
                200 <= unlock_resp.status_code < 300
                and unlock_data.get('success', True)
            ) or already_unlocked

            result['unlock_success'] = unlock_success
            result['unlock_message'] = unlock_message
            if not unlock_success:
                if unlock_resp.status_code == 401:
                    result['message'] = '翻牌认证失败: Session 可能已过期'
                else:
                    result['message'] = f'50% 加成解锁失败: {unlock_message}'
                return result

            draw_resp = self.session.post(f'{self.base_url}/api/gwent/draw', timeout=30)
            try:
                draw_data = draw_resp.json()
            except (json.JSONDecodeError, ValueError):
                result['message'] = f'翻牌响应格式错误 (HTTP {draw_resp.status_code})'
                return result

            draw_message = self._gwent_message(draw_data, '翻牌成功')
            if not (200 <= draw_resp.status_code < 300 and draw_data.get('success')):
                if draw_resp.status_code == 401:
                    result['message'] = '翻牌认证失败: Session 可能已过期'
                else:
                    result['message'] = f'翻牌失败: {draw_message}'
                return result

            payload = draw_data.get('data') or {}
            prize = payload.get('prize') or {}
            bonus_value = next(
                (
                    payload[key]
                    for key in (
                        'applied_bonus_pct',
                        'applied_bonus_percent',
                        'bonus_pct',
                        'bonus_percent',
                    )
                    if key in payload and payload[key] is not None
                ),
                50,
            )
            bonus_percent = normalize_gwent_bonus_percent(bonus_value)
            charges_current = normalize_gwent_quota(payload.get('charges_current'))
            extra_draws_left = normalize_gwent_quota(payload.get('extra_draws_left'))
            has_charge_fields = 'charges_current' in payload or 'extra_draws_left' in payload
            result.update({
                'success': True,
                'message': draw_message,
                'prize_name': prize.get('name'),
                'prize_quota': apply_gwent_bonus_quota(prize.get('quota'), bonus_percent),
                'prize_rarity': prize.get('rarity'),
                'bonus_percent': bonus_percent,
                'charges_current': charges_current if has_charge_fields else None,
                'extra_draws_left': extra_draws_left if has_charge_fields else None,
                'available_after': charges_current + extra_draws_left if has_charge_fields else None,
            })
        except requests.exceptions.Timeout:
            result['message'] = '翻牌请求超时'
        except requests.exceptions.RequestException as e:
            result['message'] = f'翻牌网络请求失败: {e}'
        except Exception as e:
            result['message'] = f'翻牌未知错误: {e}'

        return result

    def gwent_draw_many(self, count: int = 3) -> list:
        """连续翻牌；任意一次失败后停止，避免无效重复请求。"""
        requested = max(1, count)
        status = self.gwent_status()
        available = status.get('available') if status.get('success') else None
        results = []

        def cooldown_result(available_before=0):
            return {
                'success': False,
                'unlock_success': False,
                'message': '冷却中：当前没有可用翻牌次数',
                'unlock_message': '',
                'prize_quota': None,
                'prize_rarity': 'unknown',
                'bonus_percent': 0,
                'available_before': available_before,
                'synthetic_cooldown': True,
            }

        # Status is advisory; when it is unavailable, let the draw endpoint decide.
        if available is not None and available <= 0:
            return [cooldown_result()]

        planned = min(requested, available) if available is not None else requested
        for attempt in range(planned):
            result = self.gwent_draw()
            if attempt == 0 and available is not None:
                result['available_before'] = available
            results.append(result)
            if not result.get('success'):
                break
            remaining = result.get('available_after')
            if remaining is not None and remaining <= 0 and attempt + 1 < requested:
                results.append(cooldown_result())
                break
        if (
            available is not None
            and available < requested
            and results
            and results[-1].get('success')
        ):
            results.append(cooldown_result())
        return results

    def _extract_user_id_from_session(self, session_cookie: str) -> Optional[str]:
        """
        从 Session Cookie 中提取用户ID

        Session Cookie 格式通常是 Base64 编码的数据
        """
        try:
            # 尝试解码 Session Cookie
            # Session 格式类似：MTc2NzQxMzYzM3xE...
            # 解码后可能包含用户信息
            decoded = base64.b64decode(session_cookie + '==')  # 添加 padding
            decoded_str = decoded.decode('utf-8', errors='ignore')

            # 查找可能的用户ID模式
            # 例如：linuxdo_988 中的 988
            import re
            # 查找 "linuxdo_数字" 或 "id"=数字 等模式
            patterns = [
                r'linuxdo[_-](\d+)',  # linuxdo_988
                r'"id"[:\s]+(\d+)',    # "id": 988
                r'user[_-](\d+)',      # user_988
                r'userid[:\s]+(\d+)',  # userid: 988
            ]

            for pattern in patterns:
                match = re.search(pattern, decoded_str, re.IGNORECASE)
                if match:
                    return match.group(1)

        except Exception:
            pass

        return None

    def get_user_info(self, verbose: bool = False) -> Optional[dict]:
        """
        获取用户信息

        自动设置 new-api-user 请求头

        Args:
            verbose: 是否显示详细调试信息
        """
        try:
            resp = self.session.get(f'{self.base_url}/api/user/self', timeout=30)

            if verbose:
                print(f'  [调试] HTTP 状态码: {resp.status_code}')
                print(f'  [调试] 响应内容预览: {resp.text[:200]}...')

            # 检查认证失败
            if resp.status_code == 401:
                print(f'[错误] 认证失败 (401): Session 可能已过期')
                if verbose:
                    print(f'  [调试] 完整响应: {resp.text[:500]}')
                return None

            # 尝试解析 JSON
            try:
                data = resp.json()
            except json.JSONDecodeError as e:
                # 检测是否是 Cloudflare 拦截
                if detect_cloudflare_block:
                    is_blocked, reason = detect_cloudflare_block(resp.status_code, resp.text)
                    if is_blocked:
                        print(f'[CF] 获取用户信息时检测到 Cloudflare 拦截: {reason}')
                        print(f'[CF] 该站点需要 CF 绕过才能访问')
                        return None
                print(f'[错误] 响应格式错误 (HTTP {resp.status_code}): 无法解析 JSON')
                if verbose:
                    print(f'  [调试] 原始响应: {resp.text[:500]}')
                return None

            if verbose:
                print(f'  [调试] success 字段: {data.get("success")}')
                print(f'  [调试] message 字段: {data.get("message")}')

            if resp.status_code == 200:
                if data.get('success'):
                    user_data = data.get('data')
                    # 保存用户ID并设置到请求头
                    if user_data and 'id' in user_data:
                        self.user_id = user_data['id']
                        self.session.headers.update({
                            'new-api-user': str(self.user_id)
                        })
                    return user_data
                else:
                    if verbose:
                        print(f'  [调试] API 返回失败: {data.get("message", "未知错误")}')
            else:
                print(f'[错误] HTTP {resp.status_code}: {data.get("message", "未知错误")}')

            return None

        except requests.exceptions.Timeout:
            print(f'[错误] 请求超时')
            return None
        except requests.exceptions.RequestException as e:
            print(f'[错误] 网络请求失败: {e}')
            return None
        except Exception as e:
            print(f'[错误] 未知错误: {e}')
            if verbose:
                import traceback
                traceback.print_exc()
            return None

    def checkin(self) -> dict:
        """
        执行签到

        流程（借鉴 Chrome 扩展 background.js:115-248）：
        1. requests 直连签到（快速模式）
        2. CF 拦截检测 → Playwright 获取 cookie 后重新签到
        3. 仍然失败 → Playwright 浏览器内直接签到（终极回退）

        Returns:
            签到结果字典
        """
        result = {
            'success': False,
            'message': '',
            'checkin_date': None,
            'quota_awarded': None
        }

        try:
            resp = self.session.post(f'{self.base_url}/api/user/checkin', timeout=30)

            if resp.status_code == 401:
                result['message'] = '认证失败: Session 可能已过期，请重新获取'
                return result

            try:
                data = resp.json()
            except json.JSONDecodeError:
                if detect_cloudflare_block:
                    is_blocked, reason = detect_cloudflare_block(resp.status_code, resp.text)
                    if is_blocked:
                        print(f'[CF] 检测到 Cloudflare 拦截: {reason}')
                        return self._cf_bypass_checkin()
                content_preview = resp.text[:200] if resp.text else '(空响应)'
                result['message'] = f'响应格式错误 (HTTP {resp.status_code}): {content_preview}'
                return result

            if detect_cloudflare_block and resp.status_code in (403, 503):
                is_blocked, reason = detect_cloudflare_block(resp.status_code, json.dumps(data))
                if is_blocked:
                    print(f'[CF] 检测到 Cloudflare 拦截: {reason}')
                    return self._cf_bypass_checkin()

            if resp.status_code == 200:
                if data.get('success'):
                    result['success'] = True
                    result['message'] = data.get('message', '签到成功')

                    checkin_data = data.get('data', {})
                    result['checkin_date'] = checkin_data.get('checkin_date')
                    result['quota_awarded'] = checkin_data.get('quota_awarded')
                else:
                    result['message'] = data.get('message', '签到失败')
            else:
                result['message'] = f'HTTP {resp.status_code}: {data.get("message", "未知错误")}'

        except requests.exceptions.Timeout:
            result['message'] = '请求超时'
        except requests.exceptions.RequestException as e:
            result['message'] = f'网络请求失败: {e}'
        except Exception as e:
            result['message'] = f'未知错误: {e}'

        return result

    def _cf_bypass_checkin(self) -> dict:
        """
        CF 绕过签到流程

        在同一个 Playwright 会话中完成 CF 绕过 + 签到，
        不拆分 cookie 提取和 requests 重试（因为 cf_clearance 绑定浏览器指纹）
        """
        result = {
            'success': False,
            'message': '',
            'checkin_date': None,
            'quota_awarded': None
        }

        if not CF_BYPASS_AVAILABLE or not CloudflareBypasser:
            result['message'] = 'Cloudflare 拦截: 需安装 Playwright 才能自动绕过 (pip install playwright && playwright install chromium)'
            return result

        bypasser = CloudflareBypasser(self.base_url, self.session_cookie, self.user_id)

        if not bypasser.is_available():
            result['message'] = 'Cloudflare 拦截: Playwright 未正确安装'
            return result

        print('[CF] 开始 Playwright 绕过流程...')
        browser_result = bypasser.bypass_and_checkin()

        if not browser_result:
            result['message'] = 'Cloudflare 绕过失败: 无法通过 CF 验证'
            return result

        self.cf_bypassed = True

        if browser_result.get('error'):
            result['message'] = f'CF 绕过后签到失败: {browser_result["error"]}'
            return result

        if browser_result.get('alreadyCheckedIn'):
            result['success'] = True
            result['message'] = browser_result.get('message', '今日已签到 (CF绕过)')
        elif browser_result.get('success'):
            result['success'] = True
            result['message'] = browser_result.get('message', '签到成功 (CF绕过)')
            data = browser_result.get('data', {})
            if isinstance(data, dict):
                checkin_data = data.get('data', data)
                result['checkin_date'] = checkin_data.get('checkin_date')
                result['quota_awarded'] = checkin_data.get('quota_awarded')
        else:
            result['message'] = browser_result.get('message', 'CF 绕过后签到失败')

        return result

    def get_checkin_history(self, month: str = None) -> Optional[dict]:
        """
        获取签到历史

        Args:
            month: 月份，格式 YYYY-MM，默认当前月
        """
        if month is None:
            month = datetime.now().strftime('%Y-%m')

        try:
            resp = self.session.get(
                f'{self.base_url}/api/user/checkin',
                params={'month': month},
                timeout=30
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get('success'):
                    return data.get('data')
            return None
        except Exception as e:
            print(f'[错误] 获取签到历史失败: {e}')
            return None


def parse_accounts(accounts_str: str) -> list:
    """
    解析账号配置

    支持格式:
    1. 单账号: BASE_URL#SESSION_COOKIE
    2. 多账号: BASE_URL1#SESSION1,BASE_URL2#SESSION2
    3. JSON格式: [{"url": "...", "session": "..."}]
    """
    accounts = []

    if not accounts_str:
        return accounts

    # 尝试 JSON 格式
    try:
        data = json.loads(accounts_str)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and 'url' in item and 'session' in item:
                    account = {
                        'url': item['url'],
                        'session': item['session'],
                        'name': item.get('name', '')
                    }
                    # 如果提供了 user_id，添加到账号信息中
                    if 'user_id' in item:
                        account['user_id'] = item['user_id']
                    # 如果提供了 cf_clearance，添加到账号信息中
                    if 'cf_clearance' in item:
                        account['cf_clearance'] = item['cf_clearance']
                    accounts.append(account)
            return accounts
    except json.JSONDecodeError:
        pass

    # 简单格式: URL#SESSION,URL#SESSION
    for part in accounts_str.split(','):
        part = part.strip()
        if '#' in part:
            url, session = part.split('#', 1)
            accounts.append({
                'url': url.strip(),
                'session': session.strip(),
                'name': ''
            })

    return accounts


def load_config_from_cloud(config_url: str, config_auth: str = None) -> Optional[str]:
    """
    从云端（WebDAV）加载配置

    支持:
    - 坚果云 WebDAV
    - 群晖 NAS WebDAV
    - NextCloud WebDAV
    - 任何支持 WebDAV/直接链接的云存储

    Args:
        config_url: 配置文件 URL (WebDAV 或直接下载链接)
        config_auth: 认证信息，格式:
            - Basic Auth: "username:password"
            - Token Auth: "token:your_token"
    """
    try:
        headers = {}

        if config_auth:
            if config_auth.startswith('token:'):
                headers['Authorization'] = 'Bearer ' + config_auth[6:]
            elif ':' in config_auth:
                import base64 as b64mod
                credentials = b64mod.b64encode(config_auth.encode('utf-8')).decode('utf-8')
                headers['Authorization'] = 'Basic ' + credentials

        print(f'[云端] 正在从云端加载配置: {NewAPICheckin._mask_url(config_url)}')

        resp = requests.get(config_url, headers=headers, timeout=30)

        if resp.status_code == 401:
            print('[云端] 认证失败: 请检查 CONFIG_AUTH 配置')
            return None
        elif resp.status_code == 404:
            print('[云端] 配置文件不存在: 请先通过配置生成器保存到云端')
            return None
        elif resp.status_code != 200:
            print(f'[云端] 加载失败: HTTP {resp.status_code}')
            return None

        data = resp.json()

        if isinstance(data, list):
            accounts_str = json.dumps(data)
            print(f'[云端] 成功加载 {len(data)} 个账号配置')
            return accounts_str
        elif isinstance(data, dict) and 'accounts' in data:
            accounts = data['accounts']
            accounts_str = json.dumps(accounts)
            print(f'[云端] 成功加载 {len(accounts)} 个账号配置')

            if data.get('dingtalk'):
                dt = data['dingtalk']
                if dt.get('webhook') and not os.environ.get('DINGTALK_WEBHOOK'):
                    os.environ['DINGTALK_WEBHOOK'] = dt['webhook']
                if dt.get('secret') and not os.environ.get('DINGTALK_SECRET'):
                    os.environ['DINGTALK_SECRET'] = dt['secret']
                if dt.get('webhook'):
                    print('[云端] 已从云端加载钉钉通知配置')

            return accounts_str
        else:
            print('[云端] 配置格式错误: 无法解析账号列表')
            return None

    except json.JSONDecodeError:
        print('[云端] 配置文件不是有效的 JSON 格式')
        return None
    except requests.exceptions.Timeout:
        print('[云端] 请求超时')
        return None
    except requests.exceptions.RequestException as e:
        print(f'[云端] 网络请求失败: {e}')
        return None
    except Exception as e:
        print(f'[云端] 加载失败: {e}')
        return None


def utc_timestamp() -> str:
    """返回适合历史 API 的 UTC ISO 时间。"""
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def history_account_key(account: dict, index: int) -> str:
    """生成稳定、不可直接还原用户 ID 的账号键。"""
    host = (urlparse(account.get('url', '')).hostname or '').lower()
    identity = str(account.get('user_id') or account.get('name') or index)
    return hashlib.sha256(f'{host}:{identity}'.encode('utf-8')).hexdigest()[:16]


def normalize_gwent_quota(value) -> int:
    """把翻牌 API 的额度值规范成非负整数，兼容字符串数字。"""
    if isinstance(value, bool) or value is None:
        return 0
    try:
        number = float(str(value).replace(',', '').strip())
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number) or number < 0:
        return 0
    return int(number)


def normalize_gwent_bonus_percent(value) -> int:
    """把 0.5 比例或 50 百分数统一成百分数整数。"""
    if isinstance(value, bool) or value is None:
        return 0
    try:
        number = float(str(value).replace(',', '').strip())
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number) or number < 0:
        return 0
    if 0 < number <= 1:
        number *= 100
    return int(number)


def apply_gwent_bonus_quota(value, bonus_percent) -> int:
    """把翻牌接口返回的原始额度换算为包含分享加成的最终额度。"""
    quota = normalize_gwent_quota(value)
    bonus = normalize_gwent_bonus_percent(bonus_percent)
    return (quota * (100 + bonus) + 50) // 100


def parse_utc_timestamp(value):
    """解析历史 API 的 ISO 时间戳，返回 UTC aware datetime。"""
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    timestamp = value.strip()
    if timestamp.endswith('Z'):
        timestamp = f'{timestamp[:-1]}+00:00'
    try:
        parsed = datetime.fromisoformat(timestamp)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_gwent_last_success(history_url: str) -> dict:
    """读取每个账号最近一次成功翻牌时间；失败时让调度保护安全停止。"""
    if not history_url:
        raise RuntimeError('未配置 HISTORY_URL')
    try:
        response = requests.get(
            history_url,
            headers={'Accept': 'application/json', 'Cache-Control': 'no-store'},
            timeout=15,
        )
    except requests.exceptions.RequestException as error:
        raise RuntimeError(f'历史接口请求失败（{type(error).__name__}）') from error
    if response.status_code != 200:
        raise RuntimeError(f'历史接口返回 HTTP {response.status_code}')
    try:
        data = response.json()
    except (ValueError, TypeError) as error:
        raise RuntimeError('历史接口返回格式错误') from error
    if not isinstance(data, dict):
        raise RuntimeError('历史接口返回格式错误')

    latest = {}
    for event in data.get('events') or []:
        if not isinstance(event, dict) or event.get('status') != 'success':
            continue
        # 答题和广告奖励会各自触发一次即时翻牌；它们不能推迟常规
        # 两小时翻牌。旧记录没有 task_type 时按常规翻牌兼容处理。
        if (event.get('task_type') or 'gwent') != 'gwent':
            continue
        account_key = event.get('account_key')
        occurred_at = parse_utc_timestamp(event.get('occurred_at'))
        if not isinstance(account_key, str) or occurred_at is None:
            continue
        if occurred_at > latest.get(account_key, datetime.min.replace(tzinfo=timezone.utc)):
            latest[account_key] = occurred_at
    return latest


def filter_gwent_targets(
    targets: list,
    last_success: dict,
    min_interval_seconds: int = GWENT_MIN_INTERVAL_SECONDS,
    now=None,
):
    """只保留距上次成功翻牌达到保护间隔的账号。"""
    current = now or datetime.now(timezone.utc)
    eligible = []
    skipped = []
    for target in targets:
        index, account, _client = target
        account_key = history_account_key(account, index)
        last_success_at = parse_utc_timestamp(last_success.get(account_key))
        if last_success_at is not None:
            elapsed = (current - last_success_at).total_seconds()
            if elapsed < min_interval_seconds:
                skipped.append((target, max(1, math.ceil(min_interval_seconds - elapsed))))
                continue
        eligible.append(target)
    return eligible, skipped


def gwent_event_status(result: dict) -> str:
    if result.get('success'):
        return 'success'
    message = str(result.get('message', '')).lower()
    if any(marker in message for marker in ('冷却', 'cooldown', 'too soon', 'next draw', 'no available', '次数不足')):
        return 'cooldown'
    if '认证' in message or 'session' in message or 'unauthorized' in message:
        return 'auth'
    return 'error'


def publish_gwent_history(payload: dict) -> bool:
    """将脱敏翻牌记录发布到历史 API。"""
    history_url = os.environ.get('HISTORY_URL', '').strip()
    history_auth = os.environ.get('HISTORY_AUTH', '').strip()
    required = os.environ.get('HISTORY_REQUIRED', '').strip().lower() == 'true'

    if not history_url or not history_auth:
        print('[历史] 未配置 HISTORY_URL/HISTORY_AUTH，跳过记录上报')
        return not required

    token = history_auth[6:] if history_auth.startswith('token:') else history_auth
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }
    for attempt in range(1, 4):
        try:
            response = requests.post(history_url, headers=headers, json=payload, timeout=30)
            if response.status_code == 200:
                duplicate = bool((response.json() or {}).get('duplicate'))
                suffix = '（重复运行已忽略）' if duplicate else ''
                print(f'[历史] 翻牌记录已保存{suffix}')
                return True
            print(f'[历史] 第 {attempt}/3 次上报失败: HTTP {response.status_code}')
        except requests.exceptions.RequestException as error:
            print(f'[历史] 第 {attempt}/3 次上报失败: {type(error).__name__}')
        if attempt < 3:
            time.sleep(attempt)

    print('[历史] 翻牌记录保存失败')
    return False


def run_gwent_tasks(accounts: list, draw_count: int) -> bool:
    """执行独立的维云翻牌任务。"""
    started_at = utc_timestamp()
    run_number = int(os.environ.get('GITHUB_RUN_NUMBER', '0') or 0)
    run_attempt = int(os.environ.get('GITHUB_RUN_ATTEMPT', '1') or 1)
    github_run_id = os.environ.get('GITHUB_RUN_ID', '').strip()
    run_id = f'{github_run_id}:{run_attempt}' if github_run_id else datetime.now().strftime('%Y%m%d%H%M%S')
    history_events = []
    targets = []
    for index, account in enumerate(accounts, 1):
        client = NewAPICheckin(
            account['url'],
            account['session'],
            account.get('user_id'),
            account.get('cf_clearance'),
        )
        if client.is_vsllm():
            targets.append((index, account, client))

    if not targets:
        print('[警告] 配置中没有 vsllm.com 账号，翻牌任务已跳过')
        return True

    schedule_guard_enabled = (
        os.environ.get('GWENT_SCHEDULE_GUARD', '').strip().lower() == 'true'
        and os.environ.get('GWENT_FORCE', '').strip().lower() != 'true'
    )
    if schedule_guard_enabled:
        interval_raw = os.environ.get('GWENT_MIN_INTERVAL_SECONDS', '').strip()
        try:
            min_interval = max(0, int(interval_raw)) if interval_raw else GWENT_MIN_INTERVAL_SECONDS
        except ValueError:
            min_interval = GWENT_MIN_INTERVAL_SECONDS
        if min_interval > 0:
            try:
                last_success = load_gwent_last_success(os.environ.get('HISTORY_URL', '').strip())
            except RuntimeError as error:
                print(f'[调度] 无法确认上次翻牌时间，本轮停止：{error}')
                return False
            targets, skipped = filter_gwent_targets(targets, last_success, min_interval)
            for (_index, account, _client), remaining in skipped:
                name = account.get('name') or '未命名账号'
                minutes = max(1, math.ceil(remaining / 60))
                print(f'[调度] {name} 距上次成功翻牌还需约 {minutes} 分钟，本轮跳过')
        else:
            print('[调度] Worker 两小时槽位已放行，本地不再按完成时间重复限流')
    elif os.environ.get('GWENT_SCHEDULE_GUARD', '').strip().lower() == 'true':
        print('[调度] 手动运行绕过 2 小时间隔保护')

    print(f'共 {len(targets)} 个维云账号待翻牌，每个最多 {draw_count} 次\n')
    if not targets:
        print('[调度] 本轮没有达到翻牌间隔的账号，任务已安全跳过')
        return True

    success_count = 0
    fail_count = 0
    error_count = 0
    run_total_quota = 0

    for position, (index, account, client) in enumerate(targets, 1):
        name = account.get('name') or f'账号{index}'
        user_id = account.get('user_id')
        print(f'[{position}/{len(targets)}] {name}')
        print(f'  站点: {NewAPICheckin._mask_url(account["url"])}')
        if user_id:
            print(f'  用户ID: {NewAPICheckin._mask_user_id(user_id)}')

        user_info = client.get_user_info()
        if user_info:
            username = user_info.get('username', '未知')
            masked_username = username[:3] + '***' if len(username) > 3 else '***'
            print(f'  用户: {masked_username}')
        else:
            print('  用户: 获取失败（可能 session 已过期）')

        results = client.gwent_draw_many(draw_count)
        completed = 0
        total_quota = 0
        account_key = history_account_key(account, index)
        available_before = results[0].get('available_before') if results else None
        if available_before is not None:
            print(f'  可用翻牌次数: {available_before}')
        for attempt, result in enumerate(results, 1):
            if result.get('unlock_success'):
                print(f'  第 {attempt}/{draw_count} 次加成: ✅ {result["unlock_message"]}')
            else:
                print(f'  第 {attempt}/{draw_count} 次加成: ❌ {result["message"]}')

            if result.get('success'):
                completed += 1
                prize_name = result.get('prize_name') or '未知奖品'
                quota_value = normalize_gwent_quota(result.get('prize_quota'))
                total_quota += quota_value
                quota_text = f' (+{quota_value:,} 额度)'
                print(f'  第 {attempt}/{draw_count} 次翻牌: ✅ {prize_name}{quota_text}')
            elif result.get('unlock_success'):
                print(f'  第 {attempt}/{draw_count} 次翻牌: ❌ {result["message"]}')

            quota_value = normalize_gwent_quota(result.get('prize_quota'))
            rarity = str(result.get('prize_rarity') or 'unknown').lower()
            if rarity not in ('common', 'rare', 'epic', 'legendary'):
                rarity = 'unknown'
            bonus_percent = normalize_gwent_bonus_percent(result.get('bonus_percent'))
            history_events.append({
                'event_id': f'{run_id}:{account_key}:{attempt}',
                'account_key': account_key,
                'account_name': str(name)[:64],
                'attempt': attempt,
                'occurred_at': utc_timestamp(),
                'status': gwent_event_status(result),
                'prize_name': str(result.get('prize_name'))[:80] if result.get('prize_name') else None,
                'prize_quota': max(0, quota_value),
                'prize_rarity': rarity,
                'bonus_percent': bonus_percent,
                'message': str(result.get('message', ''))[:240] or None,
                'task_type': 'gwent',
            })

        run_total_quota += total_quota
        quota_summary = f'，本轮额度 +{total_quota:,}'
        if completed == draw_count:
            success_count += 1
            print(f'  小结: ✅ 完成 {completed}/{draw_count} 次{quota_summary}')
        else:
            fail_count += 1
            last_result = results[-1] if results else {}
            if gwent_event_status(last_result) == 'cooldown':
                print(f'  小结: ⏳ 完成 {completed}/{draw_count} 次，剩余次数仍在冷却{quota_summary}')
            else:
                error_count += 1
                print(f'  小结: ❌ 完成 {completed}/{draw_count} 次{quota_summary}')
        print()

    print('=' * 50)
    print(f'翻牌完成: 全部完成 {success_count}, 未满 {fail_count}, 实际错误 {error_count}')
    print(f'本轮所有账号额度: +{run_total_quota:,}')
    print('=' * 50)
    finished_at = utc_timestamp()
    run_status = 'success' if fail_count == 0 else ('error' if error_count == len(targets) else 'partial')
    history_saved = publish_gwent_history({
        'schema_version': 1,
        'run': {
            'run_id': run_id,
            'run_number': max(0, run_number),
            'run_attempt': max(0, run_attempt),
            'started_at': started_at,
            'finished_at': finished_at,
            'planned_draws': draw_count,
            'status': run_status,
            'source': 'gwent',
        },
        'events': history_events,
    })
    return error_count != len(targets) and history_saved


def main():
    """主函数"""
    import pytz
    beijing_tz = pytz.timezone('Asia/Shanghai')
    execution_time = datetime.now(beijing_tz).strftime("%Y-%m-%d %H:%M:%S")
    print('=' * 50)
    task_mode = os.environ.get('TASK_MODE', 'checkin').strip().lower()
    if task_mode not in ('checkin', 'gwent'):
        print(f'[错误] 不支持的 TASK_MODE: {task_mode}')
        sys.exit(1)

    print('NewAPI 自动签到' if task_mode == 'checkin' else '维云自动翻牌')
    print(f'执行时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 50)

    config_url = os.environ.get('CONFIG_URL', '')
    config_auth = os.environ.get('CONFIG_AUTH', '')

    accounts_str = ''

    if config_url:
        accounts_str = load_config_from_cloud(config_url, config_auth) or ''

    if not accounts_str:
        accounts_str = os.environ.get('NEWAPI_ACCOUNTS', '')

    if not accounts_str:
        print('[错误] 未配置账号信息')
        print('请设置 CONFIG_URL（云端配置）或 NEWAPI_ACCOUNTS（本地配置）环境变量')
        sys.exit(1)

    accounts = parse_accounts(accounts_str)

    if not accounts:
        print('[错误] 账号配置解析失败')
        sys.exit(1)

    if task_mode == 'gwent':
        try:
            draw_count = max(1, min(10, int(os.environ.get('GWENT_DRAW_COUNT', '1'))))
        except ValueError:
            print('[错误] GWENT_DRAW_COUNT 必须是整数')
            sys.exit(1)
        if not run_gwent_tasks(accounts, draw_count):
            sys.exit(1)
        return

    print(f'共 {len(accounts)} 个账号待签到\n')

    success_count = 0
    fail_count = 0
    checkin_results = []

    for i, account in enumerate(accounts, 1):
        url = account['url']
        session_cookie = account['session']
        user_id = account.get('user_id')  # 获取用户ID（如果提供）
        cf_clearance = account.get('cf_clearance')  # 获取 CF clearance（如果提供）
        name = account.get('name') or f'账号{i}'

        print(f'[{i}/{len(accounts)}] {name}')
        print(f'  站点: {NewAPICheckin._mask_url(url)}')
        if user_id:
            print(f'  用户ID: {NewAPICheckin._mask_user_id(user_id)}')

        client = NewAPICheckin(url, session_cookie, user_id, cf_clearance)

        # 获取用户信息
        user_info = client.get_user_info()
        if user_info:
            username = user_info.get('username', '未知')
            # 用户名也脱敏，只显示前3个字符
            masked_username = username[:3] + '***' if len(username) > 3 else '***'
            print(f'  用户: {masked_username}')
        else:
            print('  用户: 获取失败（可能 session 已过期）')

        # 执行签到
        result = client.checkin()
        checkin_count = 0  # 默认值，避免历史接口失败时未定义

        if result['success']:
            success_count += 1
            print(f'  结果: ✅ {result["message"]}')

            # 显示签到日期
            if result['checkin_date']:
                print(f'  日期: {result["checkin_date"]}')

            # 显示获得的额度（格式化显示）
            if result['quota_awarded']:
                quota = result['quota_awarded']
                # 格式化额度显示
                if quota >= 1000000:
                    quota_str = f'{quota / 1000000:.2f}M'
                elif quota >= 1000:
                    quota_str = f'{quota / 1000:.2f}K'
                else:
                    quota_str = str(quota)
                print(f'  奖励: +{quota_str} 额度 ({quota:,} tokens)')

            # 获取本月签到统计
            history = client.get_checkin_history()
            if history and history.get('stats'):
                stats = history['stats']
                checkin_count = stats.get('checkin_count', 0)
                total_quota = stats.get('total_quota', 0)
                if total_quota >= 1000000:
                    total_str = f'{total_quota / 1000000:.2f}M'
                elif total_quota >= 1000:
                    total_str = f'{total_quota / 1000:.2f}K'
                else:
                    total_str = str(total_quota)
                print(f'  统计: 本月已签 {checkin_count} 天，累计 {total_str} 额度')

            # 收集结果用于钉钉通知
            account_result = {
                'name': name,
                'success': True,
                'message': result['message'],
                'quota_awarded': result.get('quota_awarded'),
                'checkin_count': checkin_count,
            }
            checkin_results.append(account_result)
        else:
            fail_count += 1
            print(f'  结果: ❌ {result["message"]}')

            # 收集结果用于钉钉通知
            message = result.get('message', '')
            account_result = {
                'name': name,
                'success': False,
                'message': message,
                'session_expired': 'session' in message.lower() or '认证' in message,
            }
            checkin_results.append(account_result)

        print()

    # 汇总
    print('=' * 50)
    print(f'签到完成: 成功 {success_count}, 失败 {fail_count}')
    print('=' * 50)
    
    # 发送钉钉通知
    if send_checkin_notification:
        print('正在发送钉钉通知...')
        send_checkin_notification(checkin_results, execution_time)
    elif os.environ.get('DINGTALK_WEBHOOK'):
        print('[警告] 已配置 DINGTALK_WEBHOOK 但无法导入通知模块')

    # 如果全部失败则返回错误码
    if fail_count == len(accounts):
        sys.exit(1)


if __name__ == '__main__':
    main()

# === DINGTALK NOTIFICATION PATCH ===
# This section was added to send DingTalk notifications

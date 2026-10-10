"""固定官方端点；密钥只存本机，模型工具由应用验证执行。"""
import json
import threading
import logging
from logging.handlers import RotatingFileHandler
from time import monotonic

import httpx
from fastapi import HTTPException

from ..config import DATA_DIR, settings

CONFIG_PATH = DATA_DIR / 'deepseek.local.json'
BASE_URL = 'https://api.deepseek.com'
config_lock = threading.Lock()
logger = logging.getLogger('invoice.deepseek')
if not logger.handlers:
    log_dir = DATA_DIR / 'logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(log_dir / 'deepseek.log', maxBytes=512_000, backupCount=2, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def read_config():
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding='utf-8')) if CONFIG_PATH.exists() else {}
    except (OSError, ValueError):
        raise HTTPException(503, '本机 DeepSeek 配置无法读取，请重新保存配置')
    return {'api_key': data.get('api_key') or settings.deepseek_api_key,
            'model': data.get('model') or settings.deepseek_model,
            'enabled': bool(data.get('enabled', False))}


def public_config():
    config = read_config()
    return {'configured': bool(config['api_key']), 'model': config['model'],
            'enabled': config['enabled'], 'base_url': BASE_URL}


def save_config(api_key, model, enabled):
    with config_lock:
        config = read_config()
        if api_key is not None and api_key.strip():
            config['api_key'] = api_key.strip()
        config.update(model=model, enabled=enabled)
        if enabled and not config['api_key']:
            raise HTTPException(422, '请先填写 DeepSeek API Key')
        temp = CONFIG_PATH.with_suffix('.tmp')
        temp.write_text(json.dumps(config, ensure_ascii=False), encoding='utf-8')
        temp.replace(CONFIG_PATH)
    return public_config()


def complete(messages, tools=None):
    config = read_config()
    if not config['enabled'] or not config['api_key']:
        raise HTTPException(409, '请在 DeepSeek 配置中保存密钥并启用云端对话')
    payload = {'model': config['model'], 'messages': messages, 'stream': False,
               'max_tokens': 2048, 'thinking': {'type': 'disabled'}}
    if tools:
        payload['tools'] = tools
    started = monotonic()
    timeout_seconds = max(5.0, min(float(settings.deepseek_timeout_seconds), 300.0))
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout_seconds, connect=10), follow_redirects=False) as client:
            response = client.post(BASE_URL + '/chat/completions', headers={'Authorization': 'Bearer ' + config['api_key']}, json=payload)
    except httpx.ConnectTimeout:
        logger.warning('request_timeout phase=connect elapsed=%.1fs messages=%d', monotonic() - started, len(messages))
        raise HTTPException(504, '连接 DeepSeek 超时（10 秒），尚未取得模型回复。请检查网络后重试。')
    except httpx.TimeoutException as exc:
        logger.warning('request_timeout phase=%s elapsed=%.1fs limit=%.0fs messages=%d', type(exc).__name__, monotonic() - started, timeout_seconds, len(messages))
        raise HTTPException(504, f'DeepSeek 请求等待超时（响应等待上限 {timeout_seconds:g} 秒），尚未取得完整模型回复。可能是服务响应慢或网络延迟，请稍后重试。')
    except httpx.HTTPError as exc:
        logger.warning('request_failed kind=%s elapsed=%.1fs', type(exc).__name__, monotonic() - started)
        raise HTTPException(502, '无法连接 DeepSeek 官方接口，请检查网络')
    logger.info('request_finished status=%d elapsed=%.1fs messages=%d', response.status_code, monotonic() - started, len(messages))
    if response.status_code != 200:
        message = {401: 'API Key 无效，请检查密钥', 402: 'DeepSeek 账户余额不足',
                   429: 'DeepSeek 请求频率受限，请稍后重试', 400: 'DeepSeek 请求被拒绝，请检查模型名称和接口支持',
                   404: 'DeepSeek 模型或接口不存在，请检查模型名称'}.get(response.status_code, 'DeepSeek 服务暂时不可用')
        # 不返回上游正文，防止密钥、提示词或其他内容被错误回显。
        raise HTTPException(502, message)
    try:
        choice = response.json()['choices'][0]
        if choice.get('finish_reason') == 'length':
            raise HTTPException(502, '模型响应被截断，请缩短请求后重试')
        result = choice['message']
        if not isinstance(result, dict):
            raise ValueError()
        return {key: result[key] for key in ['role', 'content', 'tool_calls', 'reasoning_content'] if key in result}
    except (ValueError, KeyError, IndexError, TypeError):
        raise HTTPException(502, 'DeepSeek 返回格式异常，请重试')

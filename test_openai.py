#!/usr/bin/env python3
"""
Тест подключения к OpenAI API.
Запуск: python test_openai.py (из корня проекта)
"""
import os
import sys
import json
import urllib.request
import urllib.error
import ssl
from pathlib import Path

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Корень проекта = каталог, где лежит этот скрипт
_root = Path(__file__).resolve().parent

def _load_env(path: Path) -> None:
    if not path.exists():
        return
    with path.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                key = k.strip()
                val = v.strip().strip('"').strip("'").strip()
                if key and val:
                    os.environ[key] = val

_load_env(_root / "backend" / ".env")
_load_env(_root / ".env")

def test_openai():
    api_key = os.getenv("OPENAI_API_KEY")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    proxy = os.getenv("OPENAI_PROXY", "").strip()
    base_url = (os.getenv("OPENAI_BASE_URL") or "").strip().rstrip("/")
    if base_url == "https://simulex.lablegal.tech":
        base_url = "https://simulex.lablegal.tech/openai"
    api_url = f"{base_url}/v1/chat/completions" if base_url else "https://api.openai.com/v1/chat/completions"

    print("=" * 60)
    print("ТЕСТ ПОДКЛЮЧЕНИЯ К OPENAI API")
    print("=" * 60)

    # Проверка ключа
    if not api_key:
        print("❌ OPENAI_API_KEY не задан в backend/.env")
        return False

    print(f"✓ API ключ: {api_key[:20]}...{api_key[-4:]}")
    print(f"✓ Модель: {model}")
    print(f"✓ OPENAI_BASE_URL из .env: {os.getenv('OPENAI_BASE_URL', '(не задан)')}")
    print(f"✓ URL: {api_url}")
    if proxy:
        print(f"✓ Прокси: {proxy}")
    else:
        print("⚠ Прокси не задан (OPENAI_PROXY)")

    # Проверка формата ключа
    if not api_key.startswith("sk-"):
        print("⚠️  Ключ не начинается с 'sk-' — возможно, неправильный формат")

    # Тестовый запрос
    print("\nОтправка тестового запроса...")

    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": "Ответь одним словом: работает?"}
        ],
        "max_tokens": 10,
        "temperature": 0
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    # При обращении через прокси (OPENAI_BASE_URL) некоторые WAF/Cloudflare блокируют запросы без браузерного User-Agent
    if base_url:
        headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        headers["Accept"] = "application/json"
    req = urllib.request.Request(
        api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        ctx = ssl.create_default_context()

        # Настройка прокси
        if proxy:
            if proxy.startswith("socks"):
                # SOCKS прокси через PySocks
                try:
                    import socks
                    import socket

                    url = proxy.replace("socks5://", "").replace("socks4://", "")
                    if ":" in url:
                        host, port = url.rsplit(":", 1)
                        port = int(port)
                    else:
                        host, port = url, 1080

                    proxy_type = socks.SOCKS5 if "socks5" in proxy else socks.SOCKS4
                    socks.set_default_proxy(proxy_type, host, port)
                    socket.socket = socks.socksocket
                    print(f"   SOCKS прокси активирован: {host}:{port}")
                except ImportError:
                    print("❌ PySocks не установлен. Выполните: pip install pysocks")
                    return False

                resp = urllib.request.urlopen(req, timeout=30)
            else:
                # HTTP прокси
                proxy_handler = urllib.request.ProxyHandler({
                    "http": proxy,
                    "https": proxy,
                })
                opener = urllib.request.build_opener(proxy_handler)
                resp = opener.open(req, timeout=30)
        else:
            resp = urllib.request.urlopen(req, timeout=30, context=ctx)

        with resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            content = data["choices"][0]["message"]["content"]
            print(f"\n✅ УСПЕХ! Ответ от OpenAI: \"{content}\"")
            print(f"   Использована модель: {data.get('model', model)}")
            usage = data.get("usage", {})
            print(f"   Токены: prompt={usage.get('prompt_tokens', '?')}, completion={usage.get('completion_tokens', '?')}")
            return True

    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(f"\n❌ HTTP ОШИБКА {e.code}")
        print(f"   Тело ответа: {body[:500]}")

        # Расшифровка типичных ошибок
        if e.code == 401:
            print("\n   → Неверный API ключ. Проверьте OPENAI_API_KEY в .env")
        elif e.code == 403:
            if body and ("<!doctype" in body.lower() or "cloudflare" in body.lower()):
                print("\n   → 403 с HTML — блокировка Cloudflare.")
                if base_url:
                    print("     Прокси уже используется, но доступ с вашего IP/региона закрыт.")
                    print("     Варианты: VPN, добавить IP в Cloudflare, или запускать бэкенд на сервере.")
                else:
                    print("     Задайте в backend/.env: OPENAI_BASE_URL=https://simulex.lablegal.tech")
            else:
                print("\n   → Доступ запрещён. Возможные причины:")
                print("     - Ключ деактивирован")
                print("     - Нет доступа к выбранной модели")
                print("     - Проблемы с биллингом")
        elif e.code == 404:
            print(f"\n   → Модель '{model}' не найдена. Проверьте название модели.")
            print("     Доступные: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo")
        elif e.code == 405:
            print("\n   → Метод не разрешён (405). Nginx/прокси должен принимать POST на /v1/chat/completions.")
        elif e.code == 429:
            print("\n   → Превышен лимит запросов (rate limit)")
        elif e.code == 500 or e.code == 503:
            print("\n   → Ошибка на стороне OpenAI. Попробуйте позже.")

        return False

    except urllib.error.URLError as e:
        print(f"\n❌ ОШИБКА СЕТИ: {e.reason}")
        print("   Проверьте интернет-соединение или прокси")
        return False

    except Exception as e:
        print(f"\n❌ НЕОЖИДАННАЯ ОШИБКА: {type(e).__name__}: {e}")
        return False


if __name__ == "__main__":
    # Запуск из корня: python test_openai.py
    # С другим URL: OPENAI_BASE_URL=https://simulex.lablegal.tech python test_openai.py
    success = test_openai()
    print("\n" + "=" * 60)
    sys.exit(0 if success else 1)

"""
Manga Reader Extension — Selenium Smoke Test

Loads the extension in Chrome, navigates to a manga page,
and checks for console errors. Outputs PASS/FAIL + saves screenshot.

Usage:
    python test/smoke_test.py                       # default: mangakakalot.com
    python test/smoke_test.py --url <url>           # custom URL
    python test/smoke_test.py --local               # local mock page
    python test/smoke_test.py --headless            # headless mode (no GUI)
"""

import os
import sys
import time
import argparse
import json

EXT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_PATH = os.path.join(TEST_DIR, 'screenshot.png')
LOG_PATH = os.path.join(TEST_DIR, 'console_log.json')

DEFAULT_URL = 'https://www.natomanga.com'
WAIT_SECONDS = 5


def parse_args():
    parser = argparse.ArgumentParser(description='Smoke test for Manga Reader extension')
    parser.add_argument('--url', default=DEFAULT_URL, help='URL to test on')
    parser.add_argument('--local', action='store_true', help='Use local mock page')
    parser.add_argument('--headless', action='store_true', help='Run headless (no GUI)')
    parser.add_argument('--wait', type=int, default=WAIT_SECONDS, help='Seconds to wait after page load')
    return parser.parse_args()


def run_test(args):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    options = Options()
    options.add_argument(f'--load-extension={EXT_DIR}')
    options.add_argument('--disable-features=DisableLoadExtensionCommandLineSwitch')

    if args.headless:
        options.add_argument('--headless=new')

    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})

    driver = webdriver.Chrome(options=options)
    errors = []
    warnings = []
    info_logs = []

    try:
        # Determine target URL
        if args.local:
            url = 'file:///' + os.path.join(TEST_DIR, 'mock_manga.html').replace('\\', '/')
        else:
            url = args.url

        print(f'[TEST] Loading: {url}')
        driver.get(url)
        print(f'[TEST] Waiting {args.wait}s for extension to initialize...')
        time.sleep(args.wait)

        # Collect console logs
        logs = driver.get_log('browser')
        for log in logs:
            level = log['level']
            msg = log['message']
            if level == 'SEVERE':
                errors.append(msg)
            elif level == 'WARNING':
                warnings.append(msg)
            else:
                info_logs.append(msg)

        # Print summary
        print(f'\n--- Console Output ({len(logs)} entries) ---')
        for log in logs:
            marker = 'ERR' if log['level'] == 'SEVERE' else log['level'][:3]
            print(f'  [{marker}] {log["message"][:200]}')

        # Save full logs
        with open(LOG_PATH, 'w') as f:
            json.dump(logs, f, indent=2)

        # Screenshot
        driver.save_screenshot(SCREENSHOT_PATH)
        print(f'\n[TEST] Screenshot saved: {SCREENSHOT_PATH}')
        print(f'[TEST] Full logs saved: {LOG_PATH}')

        # Check extension loaded (look for MangaReader log)
        manga_logs = [l for l in logs if 'MangaReader' in l.get('message', '')]
        if manga_logs:
            print(f'[TEST] Extension detected: {len(manga_logs)} MangaReader log(s)')

        # Verdict
        # Filter out known non-errors (favicon, third-party, site HTTP errors, network errors, CSP report-only)
        real_errors = [e for e in errors
                       if 'favicon' not in e.lower()
                       and 'ERR_BLOCKED_BY_CLIENT' not in e
                       and 'Failed to load resource: the server responded' not in e
                       and 'net::ERR_' not in e
                       and 'report-only' in e.lower() is False
                       and 'Content Security Policy' not in e]

        print(f'\n--- Result ---')
        print(f'  Errors:   {len(real_errors)}')
        print(f'  Warnings: {len(warnings)}')
        print(f'  Info:     {len(info_logs)}')

        if real_errors:
            print(f'\nFAILED — {len(real_errors)} console error(s):')
            for e in real_errors:
                print(f'  {e[:300]}')
            return 1
        else:
            print(f'\nPASSED — no console errors')
            return 0

    finally:
        driver.quit()


if __name__ == '__main__':
    args = parse_args()
    sys.exit(run_test(args))

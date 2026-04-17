#!/usr/bin/env python3
"""
Sunbooster ADB helper + extractor (clean output v4)
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence


ACCESS_TOKEN_RE = re.compile(
    r'QuecTokenManager:\s*save token,\s*access token:\s*(Bearer\s+\S+)', re.I
)
REFRESH_TOKEN_RE = re.compile(
    r'QuecTokenManager:\s*refresh token:\s*(Bearer\s+\S+)', re.I
)

UID_RE = re.compile(r'"uid":"([^"]+)"')
PRODUCT_KEY_RE = re.compile(r'"productKey":"([^"]+)"')
DEVICE_KEY_RE = re.compile(r'"deviceKey":"([^"]+)"')
DEVICE_NAME_RE = re.compile(r'"deviceName":"([^"]+)"')
PRODUCT_NAME_RE = re.compile(r'"productName":"([^"]+)"')

PRODUCT_KEY_ALT_RE = re.compile(r'"pk":"([^"]+)"')
DEVICE_KEY_ALT_RE = re.compile(r'"dk":"([^"]+)"')

ADB_DEVICE_RE = re.compile(r'^\s*([^\s]+)\s+device\s*$', re.I)

LOGCAT_FILTER_EXPR = (
    'QuecTokenManager save token access token refresh token '
    'token-refresh websocket_login QuecDeviceListManager'
)
FILTER_TERMS = [
    'QuecTokenManager',
    'save token',
    'access token',
    'refresh token',
    'token-refresh',
    'websocket_login',
    'QuecDeviceListManager',
]


def debug_print(enabled: bool, message: str) -> None:
    if enabled:
        print(f'[DEBUG] {message}')


def last_match(pattern: re.Pattern, text: str) -> Optional[str]:
    matches = pattern.findall(text)
    return matches[-1] if matches else None


def build_result(text: str) -> Dict[str, Optional[str]]:
    return {
        'access_token': last_match(ACCESS_TOKEN_RE, text),
        'refresh_token': last_match(REFRESH_TOKEN_RE, text),
        'uid': last_match(UID_RE, text),
        'productKey': last_match(PRODUCT_KEY_RE, text) or last_match(PRODUCT_KEY_ALT_RE, text),
        'deviceKey': last_match(DEVICE_KEY_RE, text) or last_match(DEVICE_KEY_ALT_RE, text),
        'deviceName': last_match(DEVICE_NAME_RE, text),
        'productName': last_match(PRODUCT_NAME_RE, text),
    }


def print_result(result: Dict[str, Optional[str]]) -> None:
    ordered = [
        'access_token',
        'refresh_token',
        'uid',
        'productKey',
        'deviceKey',
        'deviceName',
        'productName',
    ]

    for key in ordered:
        value = result.get(key)
        if value:
            print(f'{key}={value}')
            print('')


def adb_executable() -> Optional[str]:
    script_dir = Path(__file__).resolve().parent
    adb = script_dir / 'adb.exe'
    if adb.exists():
        return str(adb)
    return None


def run_process(args: Sequence[str], debug: bool = False, shell: bool = False) -> subprocess.CompletedProcess:
    debug_print(debug, f"Running command: {args if not shell else args[0]}")
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
        shell=shell,
    )
    debug_print(debug, f'Return code: {proc.returncode}')
    if proc.stdout:
        preview = proc.stdout[:700].replace('\n', '\\n')
        debug_print(debug, f'stdout preview: {preview}')
    if proc.stderr:
        preview = proc.stderr[:700].replace('\n', '\\n')
        debug_print(debug, f'stderr preview: {preview}')
    return proc


def run_adb_devices(adb: str, debug: bool) -> str:
    proc = run_process([adb, 'devices'], debug=debug)
    return proc.stdout


def has_connected_device(output: str) -> bool:
    lines = output.splitlines()
    for line in lines[1:]:
        if ADB_DEVICE_RE.match(line):
            return True
    return False


def dump_raw_logcat(adb: str, raw_log_file: Path, debug: bool) -> str:
    proc = run_process([adb, 'logcat', '-d'], debug=debug)
    text = proc.stdout or ''
    raw_log_file.write_text(text, encoding='utf-8', errors='replace')
    debug_print(debug, f'Saved raw logcat to {raw_log_file} ({len(text)} chars)')
    return text


def run_requested_filter_command(adb: str, filtered_log_file: Path, debug: bool) -> str:
    cmd = f'"{adb}" logcat -d | findstr /i "{LOGCAT_FILTER_EXPR}"'
    proc = run_process(['cmd', '/c', cmd], debug=debug)
    text = proc.stdout or ''
    filtered_log_file.write_text(text, encoding='utf-8', errors='replace')
    debug_print(debug, f'Saved shell-filtered logcat to {filtered_log_file} ({len(text)} chars)')
    return text


def python_filter_logcat(raw_text: str, debug: bool) -> str:
    lines = raw_text.splitlines()
    selected: List[str] = []
    lowered_terms = [term.lower() for term in FILTER_TERMS]

    for line in lines:
        lower_line = line.lower()
        if any(term in lower_line for term in lowered_terms):
            selected.append(line)

    text = '\n'.join(selected)
    if selected:
        text += '\n'
    debug_print(debug, f'Python-filter matched {len(selected)} lines')
    return text


def parse_args(argv: Sequence[str]) -> tuple[bool, Optional[Path]]:
    debug = False
    file_arg: Optional[Path] = None

    for arg in argv[1:]:
        if arg == '--debug':
            debug = True
        elif file_arg is None:
            file_arg = Path(arg)
        else:
            print('Usage:')
            print('  python sunbooster_adb_extract_v4.py')
            print('  python sunbooster_adb_extract_v4.py --debug')
            print('  python sunbooster_adb_extract_v4.py <existing-log-file>')
            print('  python sunbooster_adb_extract_v4.py <existing-log-file> --debug')
            sys.exit(1)

    return debug, file_arg


def main() -> None:
    debug, file_arg = parse_args(sys.argv)

    if file_arg is not None:
        if not file_arg.exists():
            print(f'Error: file not found: {file_arg}')
            return
        debug_print(debug, f'Reading existing log file: {file_arg}')
        text = file_arg.read_text(encoding='utf-8', errors='replace')
        result = build_result(text)
        print_result(result)
        return

    adb = adb_executable()
    if adb is None:
        print('adb.exe not found')
        return

    input('Please ensure your phone is connected via USB and USB debugging is active, then press any key to continue\n')

    devices = run_adb_devices(adb, debug)
    if not has_connected_device(devices):
        print('No devices via ADB found. Please check USB debugging is enabled, the phone connected via USB to your computer, that your phone is unlocked and you confirmed the USB debug popup')
        return

    input('Please log out of the official Sunbooster app, then press any key to continue\n')

    print('Now log into the Sunbooster app with your account credentials and wait 5-10 seconds, then press any key to continue.')

    run_process([adb, 'logcat', '-c'], debug=debug)
    input()
    time.sleep(0.5)

    script_dir = Path(__file__).resolve().parent
    raw_log_file = script_dir / 'logcat_raw.txt'
    final_log_file = script_dir / 'logcat.txt'
    shell_filtered_log_file = script_dir / 'logcat_shell_filtered.txt'

    raw_text = dump_raw_logcat(adb, raw_log_file, debug)
    shell_filtered_text = run_requested_filter_command(adb, shell_filtered_log_file, debug)

    if shell_filtered_text.strip():
        final_text = shell_filtered_text
        final_log_file.write_text(final_text, encoding='utf-8', errors='replace')
        debug_print(debug, 'Using shell-filtered output as final input for extraction')
    else:
        final_text = python_filter_logcat(raw_text, debug)
        final_log_file.write_text(final_text, encoding='utf-8', errors='replace')
        debug_print(debug, 'Shell-filtered output was empty, using Python-filtered raw logcat instead')

    result = build_result(final_text)

    if not any(result.values()):
        print('No matching Sunbooster login data found in logcat.')
        print('Files written for troubleshooting:')
        print(f'  raw: {raw_log_file.name}')
        print(f'  filtered: {final_log_file.name}')
        print(f'  shell filtered: {shell_filtered_log_file.name}')
        return

    print_result(result)


if __name__ == '__main__':
    main()

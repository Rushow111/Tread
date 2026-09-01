#!/usr/bin/env python3
"""Probe official Chinese futures endpoints from a GitHub-hosted runner."""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "Mozilla/5.0 (compatible; TreadOfficialDataProbe/1.0; +https://github.com/Rushow111/Tread)"
TIMEOUT = 15
ATTEMPTS = 1

PROBES = [
    {
        "exchange": "DCE_SINA",
        "name": "新浪财经大商所主连代理",
        "url": "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_M0=/InnerFuturesNewService.getDailyKLine?symbol=M0",
    },
    {
        "exchange": "CFFEX_SINA",
        "name": "新浪财经中金所主连代理",
        "url": "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_IF0=/InnerFuturesNewService.getDailyKLine?symbol=IF0",
    },
    {
        "exchange": "SHFE",
        "name": "上海期货交易所日行情",
        "url": "https://www.shfe.com.cn/data/tradedata/future/dailydata/kx20260831.dat",
    },
    {
        "exchange": "INE",
        "name": "上海国际能源交易中心日行情",
        "url": "https://www.ine.cn/data/tradedata/future/dailydata/kx20260831.dat",
    },
    {
        "exchange": "CZCE",
        "name": "郑州商品交易所日行情",
        "url": "https://www.czce.com.cn/cn/DFSStaticFiles/Future/2026/20260831/FutureDataDaily.txt",
    },
    {
        "exchange": "DCE",
        "name": "大连商品交易所日行情页面",
        "url": "https://www.dce.com.cn/dce/channel/list/168.html",
    },
    {
        "exchange": "DCE",
        "name": "大连商品交易所历史日行情",
        "url": "https://www.dce.com.cn/publicweb/quotesdata/dayQuotesCh.html?dayQuotes.variety=all&dayQuotes.trade_type=0&year=2026&month=7&day=31",
        "headers": {"Referer": "https://www.dce.com.cn/"},
    },
    {
        "exchange": "CFFEX",
        "name": "中国金融期货交易所历史下载",
        "url": "https://www.cffex.com.cn/cn/lssjxz.html",
    },
    {
        "exchange": "CFFEX",
        "name": "中国金融期货交易所日行情 CSV",
        "url": "https://www.cffex.com.cn/sj/historysj/202608/31/20260831_1.csv",
        "headers": {"Referer": "https://www.cffex.com.cn/"},
    },
    {
        "exchange": "GFEX",
        "name": "广州期货交易所年度文件目录",
        "url": "http://www.gfex.com.cn/u/interfacesWebFile/loadList_fileall",
        "method": "POST",
        "body": "type=FUTURES&filetype=csv",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
    },
]


def fetch(probe: dict) -> dict:
    started = time.monotonic()
    last_error = None
    for attempt in range(1, ATTEMPTS + 1):
        headers = {"User-Agent": USER_AGENT, "Accept": "*/*", **probe.get("headers", {})}
        body = probe.get("body")
        request = urllib.request.Request(
            probe["url"],
            data=body.encode() if body else None,
            headers=headers,
            method=probe.get("method", "GET"),
        )
        try:
            context = ssl.create_default_context()
            with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
                content = response.read(2_000_000)
                status = response.status
                return {
                    "exchange": probe["exchange"],
                    "name": probe["name"],
                    "url": probe["url"],
                    "ok": status == 200 and len(content) >= 100,
                    "status": status,
                    "bytes_sampled": len(content),
                    "content_type": response.headers.get("Content-Type"),
                    "sha256_sample": hashlib.sha256(content).hexdigest(),
                    "attempts": attempt,
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "error": None,
                }
        except urllib.error.HTTPError as error:
            last_error = f"HTTP {error.code}: {error.reason}"
            if error.code in {401, 403, 404, 412}:
                break
        except Exception as error:  # network diagnostics must retain exact failure
            last_error = f"{type(error).__name__}: {error}"
        time.sleep(attempt * 2)

    return {
        "exchange": probe["exchange"],
        "name": probe["name"],
        "url": probe["url"],
        "ok": False,
        "status": None,
        "bytes_sampled": 0,
        "content_type": None,
        "sha256_sample": None,
        "attempts": attempt,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "error": last_error,
    }


def main() -> int:
    with ThreadPoolExecutor(max_workers=len(PROBES)) as executor:
        results = list(executor.map(fetch, PROBES))
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "runner": os.environ.get("RUNNER_NAME"),
        "results": results,
    }
    output = Path("reports/connectivity.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(report, ensure_ascii=False, indent=2))
    exchanges = sorted({item["exchange"] for item in results})
    reachable = {
        exchange: any(item["ok"] for item in results if item["exchange"] == exchange)
        for exchange in exchanges
    }
    print("Exchange reachability:", json.dumps(reachable, ensure_ascii=False))
    return 0 if any(reachable.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())

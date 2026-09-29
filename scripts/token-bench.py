#!/usr/bin/env python3
"""Tokens an agent reads to answer questions with Pensieve's recall, versus a file LLM Wiki.

The wiki side is a best case: it reads AGENTS.md and index.md once per session, then only
each question's target pages, in full. --questions is a JSON array of
{"question": "...", "keywords": ["..."], "targets": ["Page Title"]}, with targets named as
files in --wiki. Counts use tiktoken's o200k_base when installed, else bytes / 4.

    PENSIEVE_TOKEN=... scripts/token-bench.py --wiki ~/wiki --questions questions.json
"""

import argparse
import json
import os
from pathlib import Path
import re
import statistics
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:7878")
    parser.add_argument("--wiki", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--budget", type=int, default=2000)
    args = parser.parse_args()
    token = os.environ.get("PENSIEVE_TOKEN")
    if not token:
        parser.error("PENSIEVE_TOKEN is required")
    if not 200 <= args.budget <= 8000:
        parser.error("--budget must be 200–8000 (the server clamps values outside this range)")

    try:
        import tiktoken
    except ImportError:
        count = lambda text: (len(text.encode("utf-8")) + 3) // 4
        method = "UTF-8 bytes / 4 (rounded up per text)"
    else:
        encoding = tiktoken.get_encoding("o200k_base")
        count = lambda text: len(encoding.encode(text, disallowed_special=()))
        method = "tiktoken o200k_base"

    def rpc(method, params):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                              "params": params}).encode()
        request = Request(args.url.rstrip("/") + "/mcp", data=payload,
                          headers={"Authorization": "Bearer " + token,
                                   "Content-Type": "application/json",
                                   "Accept": "application/json"})
        try:
            with urlopen(request, timeout=60) as response:
                reply = json.load(response)
        except HTTPError as exc:
            raise RuntimeError(f"MCP HTTP {exc.code} ({'check PENSIEVE_TOKEN' if exc.code == 401 else 'check --url and server'})") from None
        except URLError as exc:
            raise RuntimeError(f"Cannot connect to MCP endpoint: {exc.reason}") from None
        except (ValueError, OSError) as exc:
            raise RuntimeError(f"Invalid MCP response: {exc}") from None
        if "error" in reply:
            raise RuntimeError(f"MCP {method} error: {reply['error']}")
        if reply.get("id") != 1 or "result" not in reply:
            raise RuntimeError(f"Unexpected MCP {method} response")
        return reply["result"]

    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    if not isinstance(questions, list) or not questions:
        raise ValueError("--questions must contain a nonempty JSON array")
    init = rpc("initialize", {"protocolVersion": "2025-06-18",
                              "capabilities": {}, "clientInfo": {"name": "token-bench", "version": "1"}})
    instructions = init.get("instructions")
    if not isinstance(instructions, str):
        raise ValueError("initialize returned no instructions")
    # The agent's context also holds Pensieve's tool definitions; the wiki uses file tools it has anyway.
    tools = rpc("tools/list", {}).get("tools")
    if not isinstance(tools, list):
        raise ValueError("tools/list returned no tools")
    fixed_pv = count(instructions) + count(json.dumps(tools))
    fixed_wiki = sum(count((args.wiki / name).read_text(encoding="utf-8"))
                     for name in ("AGENTS.md", "index.md"))
    rows = []
    for i, item in enumerate(questions, 1):
        question, keywords, targets = (item[key] for key in ("question", "keywords", "targets"))
        if (not isinstance(question, str) or not isinstance(keywords, list)
                or not all(isinstance(k, str) for k in keywords)
                or not isinstance(targets, list) or not targets):
            raise ValueError(f"Question {i}: invalid question, keywords, or targets")
        pages = []
        for title in targets:
            if not isinstance(title, str) or Path(title).name != title:
                raise ValueError(f"Question {i}: invalid target title")
            pages.append((args.wiki / (title + ".md")).read_text(encoding="utf-8"))
        result = rpc("tools/call", {"name": "recall", "arguments": {
            "question": question, "keywords": keywords, "budget": args.budget}})
        if result.get("isError") or not isinstance(result.get("content"), list):
            raise RuntimeError(f"Question {i}: recall tool failed: {result.get('content')}")
        texts = [part["text"] for part in result["content"] if part.get("type") == "text"]
        if not texts:
            raise RuntimeError(f"Question {i}: recall returned no text")
        output = "\n".join(texts)
        # Passage headers are followed by recall's meta line; a "##" inside a passage is not.
        labels = re.findall(r"^## (.+)\n(?:[^\n]* · )?rev \d+ · updated ", output, re.MULTILINE)
        missed = [t for t in targets if not any(l == t or l.startswith(t + " › ") for l in labels)]
        rows.append((question, count(output), sum(map(count, pages)), missed, len(targets)))

    print(f"# Memory token benchmark\n\nTokenizer: {method}; recall budget: {args.budget}; questions: {len(rows)}")
    print("Wiki comparison is a lower bound: oracle opens only target page(s), in full; no navigation reads beyond fixed index/schema.")
    print("Ratio = LLM Wiki / Pensieve. Hit = every target page present in recall passages.\n")
    print("| Fixed cost per session | Pensieve | LLM Wiki |")
    print("|---|---:|---:|")
    print(f"| MCP instructions and tools / AGENTS.md + index.md | {fixed_pv} | {fixed_wiki} |\n")
    print("| # | Question | Pensieve recall | Wiki target pages | Wiki / Pensieve | Target hit |")
    print("|---:|---|---:|---:|---:|---|")
    for i, (question, pv, wiki, missed, targets) in enumerate(rows, 1):
        hit = "yes" if not missed else f"no ({targets - len(missed)}/{targets}; missing: {', '.join(missed)})"
        safe_question = " ".join(question.split()).replace("|", "\\|")
        print(f"| {i} | {safe_question} | {pv} | {wiki} | {wiki / pv:.2f}× | {hit} |")

    hits = sum(not missed for _, _, _, missed, _ in rows)
    page_hits = sum(targets - len(missed) for _, _, _, missed, targets in rows)
    page_total = sum(targets for _, _, _, _, targets in rows)
    print(f"\nQuestion hit rate (all targets): {hits}/{len(rows)} ({hits / len(rows):.1%}); "
          f"page hit rate: {page_hits}/{page_total} ({page_hits / page_total:.1%}).\n")
    pv_values = [pv for _, pv, _, _, _ in rows]
    wiki_values = [wiki for _, _, wiki, _, _ in rows]
    pm, wm = statistics.median(pv_values), statistics.median(wiki_values)
    pt, wt = fixed_pv + sum(pv_values), fixed_wiki + sum(wiki_values)
    print("| | Pensieve | LLM Wiki | Ratio |")
    print("|---|---:|---:|---:|")
    print(f"| Session start | {fixed_pv} | {fixed_wiki} | {fixed_wiki / fixed_pv:.1f}× |")
    print(f"| Per question (median) | {pm:g} | {wm:g} | {wm / pm:.2f}× |")
    print(f"| First question (start + median) | {fixed_pv + pm:g} | {fixed_wiki + wm:g} | {(fixed_wiki + wm) / (fixed_pv + pm):.1f}× |")
    print(f"| One session asking all {len(rows)} | {pt} | {wt} | {wt / pt:.2f}× |")

if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, RuntimeError) as error:
        print(f"token-bench: {error}", file=sys.stderr)
        sys.exit(1)

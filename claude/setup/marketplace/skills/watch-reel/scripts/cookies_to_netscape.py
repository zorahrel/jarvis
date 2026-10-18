#!/usr/bin/env python3
"""Convert a Playwright storage-state JSON (from `jbrowser save-state`) to a
Netscape cookies.txt for yt-dlp --cookies.

Usage: cookies_to_netscape.py <state.json> <out_cookies.txt>
"""
import json, sys

def main() -> int:
    if len(sys.argv) != 3:
        print("usage: cookies_to_netscape.py <state.json> <out.txt>", file=sys.stderr)
        return 1
    st = json.load(open(sys.argv[1]))
    cookies = st.get("cookies", [])
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        dom = c.get("domain", "")
        include_sub = "TRUE" if dom.startswith(".") else "FALSE"
        exp = c.get("expires", -1)
        exp = int(exp) if exp not in (-1, None) else 0
        secure = "TRUE" if c.get("secure") else "FALSE"
        lines.append("\t".join([dom, include_sub, c.get("path", "/"),
                                 secure, str(exp), c.get("name", ""), c.get("value", "")]))
    open(sys.argv[2], "w").write("\n".join(lines) + "\n")
    print(f"wrote {len(cookies)} cookies to {sys.argv[2]}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

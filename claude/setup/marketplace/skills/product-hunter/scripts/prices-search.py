#!/usr/bin/env python3
"""PricesAPI.io product search -- 1,000 free calls/month.
Usage: python3 prices-search.py <query> [country=it]
"""
import sys, json, os, urllib.request, urllib.parse
from pathlib import Path

def _load_env():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

def _keychain():
    # la chiave sta nel Keychain macOS dall'08/10/2026, non piu' in .env
    import subprocess
    r = subprocess.run(["security", "find-generic-password", "-s", "pricesapi", "-a", "api", "-w"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""

_load_env()
API_KEY = os.environ.get("PRICESAPI_KEY", "") or _keychain()
BASE = "https://api.pricesapi.io/api/v1"

def fetch(url):
    if not API_KEY:
        print("Error: PRICESAPI_KEY env var not set", file=sys.stderr)
        sys.exit(1)
    req = urllib.request.Request(url, headers={"x-api-key": API_KEY, "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def main():
    if len(sys.argv) < 2:
        print("Usage: prices-search.py <query> [country]")
        sys.exit(1)

    query = sys.argv[1]
    country = sys.argv[2] if len(sys.argv) > 2 else "it"

    data = fetch(f"{BASE}/products/search?q={urllib.parse.quote(query)}&country={country}")
    if not data.get("success"):
        print(f"Error: {data}")
        return

    # L'API risponde sotto data.products; le offerte arrivano gia' inline,
    # quindi non serve la seconda chiamata per prodotto (risparmia quota).
    products = data["data"].get("products") or []
    products = [p for p in products if p.get("offers")]
    if not products:
        print("No products found")
        return

    print(f"Found {len(products)} products for '{query}':\n")

    for prod in products[:5]:
        # image e' un data-URL base64 da centinaia di KB: non stamparlo mai.
        print(f"  {prod.get('title', '?')}")
        rating, reviews = prod.get("rating"), prod.get("reviews")
        if rating or reviews:
            print(f"   rating {rating} su {reviews} recensioni")
        for o in sorted(prod["offers"], key=lambda x: x.get("price") or 1e9)[:5]:
            seller = (o.get("seller") or "?")[:30]
            price = o.get("price", "?")
            currency = o.get("currency", "EUR")
            stock = o.get("stock_status", "?")
            delivery = o.get("delivery_info", "")
            print(f"   {seller:30s} {currency} {price:>8} | {stock} | {delivery}")
            if o.get("url"):
                print(f"   -> {o['url']}")
        print()

if __name__ == "__main__":
    main()

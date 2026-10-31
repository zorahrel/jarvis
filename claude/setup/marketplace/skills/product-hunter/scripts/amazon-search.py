#!/usr/bin/env python3
"""Amazon.it product search via Scrapling (no API key needed)."""
import sys
import json
from scrapling import Fetcher
from scrapling.parser import Adaptor

def search_amazon(query: str, max_results: int = 15) -> list[dict]:
    """Search Amazon.it and return products with prices."""
    fetcher = Fetcher()
    url = f"https://www.amazon.it/s?k={query.replace(' ', '+')}"
    resp = fetcher.get(url)

    if resp.status != 200:
        print(f"Error: Amazon returned {resp.status}", file=sys.stderr)
        return []

    html = resp.body.decode('utf-8', errors='replace')
    page = Adaptor(html, url=url)
    items = page.css("[data-component-type='s-search-result']")

    results = []
    for item in items[:max_results]:
        imgs = item.css("img.s-image")
        title = imgs[0].attrib.get("alt", "").strip() if imgs else ""
        if not title:
            spans = item.css("[data-cy='title-recipe'] span")
            title = " ".join(s.text.strip() for s in spans if s.text.strip())

        price_whole = item.css(".a-price-whole")
        price_frac = item.css(".a-price-fraction")
        if price_whole:
            whole = price_whole[0].text.strip().rstrip(",.")
            frac = price_frac[0].text.strip() if price_frac else "00"
            price = float(f"{whole}.{frac}")
        else:
            price = None

        links = item.css("h2 a")
        url_path = links[0].attrib.get("href", "") if links else ""
        product_url = f"https://www.amazon.it{url_path}" if url_path and not url_path.startswith("http") else url_path

        rating_el = item.css("[aria-label*='su 5']")
        rating = rating_el[0].attrib.get("aria-label", "")[:20] if rating_el else None

        if title and price is not None:
            results.append({
                "title": title[:120],
                "price": price,
                "currency": "EUR",
                "url": product_url[:200],
                "rating": rating,
                "source": "Amazon.it"
            })

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 amazon-search.py <query> [max_results]")
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 15

    results = search_amazon(query, max_results)

    if not results:
        print("No results found.")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"Amazon.it -- {len(results)} results for '{query}'")
    print(f"{'='*60}\n")

    for i, r in enumerate(results, 1):
        rating_str = f" | {r['rating']}" if r.get('rating') else ""
        print(f"{i:2}. EUR {r['price']:>8.2f} -- {r['title']}{rating_str}")

    print(json.dumps(results, ensure_ascii=False, indent=2), file=sys.stderr)

#!/usr/bin/env python3
"""FlixBus search - the only free transport API that works in Italy.
Usage: python3 flixbus-search.py <from_city> <to_city> <DD.MM.YYYY> [adults=1]
"""
import sys, json, urllib.request, urllib.parse

API = "https://global.api.flixbus.com"
UA = "Mozilla/5.0"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def resolve_city(query):
    data = fetch(f"{API}/search/autocomplete/cities?q={urllib.parse.quote(query)}&lang=it&country=it")
    if not data:
        return None
    q = query.lower()
    airport_terms = ["fiumicino", "fco", "ciampino", "aeroporto", "airport", "malpensa", "linate", "capodichino"]
    is_airport_query = any(t in q for t in airport_terms)
    if is_airport_query:
        for d in data:
            if "aeroporto" in d["name"].lower() or "airport" in d["name"].lower():
                return d["id"]
    for d in data:
        if d["name"].lower() == q:
            return d["id"]
    return data[0]["id"]

def main():
    if len(sys.argv) < 4:
        print("Usage: flixbus-search.py <from_city> <to_city> <DD.MM.YYYY> [adults]")
        sys.exit(1)

    from_q, to_q, date = sys.argv[1], sys.argv[2], sys.argv[3]
    adults = int(sys.argv[4]) if len(sys.argv) > 4 else 1

    from_id = resolve_city(from_q)
    to_id = resolve_city(to_q)
    if not from_id or not to_id:
        print(f"Error: could not resolve cities ({from_q} -> {from_id}, {to_q} -> {to_id})")
        sys.exit(1)

    products = urllib.parse.quote(json.dumps({"adult": adults}))
    url = (f"{API}/search/service/v4/search?from_city_id={from_id}&to_city_id={to_id}"
           f"&departure_date={date}&products={products}&currency=EUR&locale=it"
           f"&search_by=cities&include_after_midnight_rides=1")

    data = fetch(url)
    trips = data.get("trips", [])
    if not trips:
        print("No trips found")
        return

    results_list = []
    for t in trips:
        for rid, r in t.get("results", {}).items():
            results_list.append(r)

    results_list.sort(key=lambda r: r.get("departure", {}).get("date", ""))

    for r in results_list:
        dep = r.get("departure", {}).get("date", "")[11:16]
        arr = r.get("arrival", {}).get("date", "")[11:16]
        price = r.get("price", {}).get("total", 0)
        dur_h = r.get("duration", {}).get("hours", 0)
        dur_m = r.get("duration", {}).get("minutes", 0)
        transfers = r.get("transfers", 0)
        status = r.get("status", "")
        print(f"{dep} -> {arr} | {dur_h}h{dur_m:02d} | EUR {price:.2f} | changes:{transfers} | {status}")

if __name__ == "__main__":
    main()

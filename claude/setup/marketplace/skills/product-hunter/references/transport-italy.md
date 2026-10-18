# Italian Transport Knowledge Base

## APIs

### FlixBus (FREE, working)
- Script: `scripts/flixbus-search.py <from> <to> <DD.MM.YYYY> [adults]`
- API base: `https://global.api.flixbus.com`
- Autocomplete: `/search/autocomplete/cities?q=QUERY&lang=it&country=it`
- Search: `/search/service/v4/search?from_city_id=ID&to_city_id=ID&departure_date=DD.MM.YYYY&products={"adult":N}&currency=EUR&locale=it&search_by=cities`
- Common city IDs:
  - Salerno: `40e1c543-8646-11e6-9066-549f350fcb0c`
  - FCO Airport: `105d8c7f-86c9-430f-85ea-5b502d2c21bc`
  - Roma: look up via autocomplete
  - Napoli: look up via autocomplete

### Trenitalia / Italo -- NO FREE API
- lefrecce.it: Akamai blocks all programmatic access (curl, fetch)
- ViaggiaTreno: only real-time/same-day, not future searches
- Italo BIG API v7: deprecated ("app must be updated")
- **Workaround**: browser automation on lefrecce.it (Angular, hard to control time picker)
- Station codes (ViaggiaTreno): Salerno=S09818, Roma Termini=S08409
- Station IDs (lefrecce BFF): Salerno=830009818, Roma Termini=830008409

## Route: Salerno <-> Roma Fiumicino (FCO)

### Direct Bus
| Service | Price | Duration | Notes |
|---------|-------|----------|-------|
| Leonettibus | 22 (19.80 app) | 3h30 | SEASONAL: Jun 27 - ? only. Tel 081 969167 |
| FlixBus | 14-28 | 6-7h30 | Slow, few evening departures |
| Trenitalia bus | ~29 | 6h23 | Night departure only |

### Combo (best value when Leonettibus suspended)
| Route | Price | Duration |
|-------|-------|----------|
| Itabus SA->Tiburtina + bus navetta->FCO | 10-12 | ~5h30 |
| Frecciarossa SA->Termini + bus navetta->FCO | ~33 | ~3h |
| Frecciarossa SA->Termini + Leonardo Express->FCO | ~41 | ~2h45 |

### Roma Termini/Tiburtina -> FCO
| Service | Price | Duration |
|---------|-------|----------|
| Bus navetta (SIT, Terravision, Rome Airport Bus) | 5-7 | ~50 min |
| Treno regionale FL1 | 8 | ~40 min (NOT from Termini -- Trastevere/Ostiense) |
| Leonardo Express | 14 | 32 min (overpriced -- bus does same job) |

## Aggregators
- **CheckMyBus.it**: compares FlixBus, Itabus, Trenitalia bus, Marinobus
- **Trainline.it**: compares Trenitalia + Italo (trains only)
- **Trenit.app**: real-time train schedules (no API, frontend only)
- **Omio.it**: multi-modal but commission on top

## Tips
- Frecciarossa SA->Roma: from 26.50/person if booked early, up to 65+
- Itabus SA->Roma Tiburtina: from 5 (!)
- Leonardo Express is tourist trap -- always suggest bus navetta instead
- FlixBus has very few evening departures -- check return legs carefully
- BlaBlaCar: ~15-20, ~3h if available

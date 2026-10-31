#!/usr/bin/env python3
# script leggero: legge un json e stampa due righe (non deve fermarsi)
import json, sys
print(json.load(open(sys.argv[1]))["ok"])

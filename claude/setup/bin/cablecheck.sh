#!/bin/bash
# Dice cosa sa fare un cavo USB-C: dati veloci? video? o solo ricarica?
# Uso: collega il cavo Mac <-> un dispositivo (SSD, hub, monitor) e lancialo.

echo "=== ALIMENTAZIONE ==="
system_profiler SPPowerDataType 2>/dev/null | grep -A4 "AC Charger Information" | sed 's/^ *//'

echo
echo "=== USB (velocita' link = verdetto sul cavo) ==="
system_profiler SPUSBDataType 2>/dev/null | grep -E "^ +[A-Za-z0-9].*:$|Speed:|Manufacturer:" | sed 's/^ *//'

echo
echo "=== THUNDERBOLT / USB4 ==="
system_profiler SPThunderboltDataType 2>/dev/null | grep -E "Device Name:|Status:|Speed:|Link Status:" | sed 's/^ *//'

echo
echo "=== DISPLAY ==="
system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution:|UI Looks like:|Connection Type:" | sed 's/^ *//'

echo
echo "--- COME LEGGERLO ---"
echo "Speed: Up to 480 Mb/s   -> cavo USB 2.0: SOLO ricarica, niente video"
echo "Speed: Up to 5/10 Gb/s  -> cavo dati, di solito porta anche video"
echo "Thunderbolt 40 Gb/s     -> cavo pieno: dati + video + 240W"

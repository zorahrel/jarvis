#!/bin/zsh
# Profilo di heap a campionamento del gateway OpenClaw (15 min, senza pausa né scrittura su disco del gateway):
# lanciato ogni ora da launchd per 24 ore, poi si spegne da solo. Cerca chi fa crescere la memoria viva (21/10: 3,3 GB).
# launchd dà PATH=/usr/bin:/bin:… e openclaw parte con `#!/usr/bin/env node`: senza questo nessun profilo (22/10)
export PATH=/opt/homebrew/bin:$PATH
OUT=~/.cache/oc-heapwatch; mkdir -p $OUT
jsons=($OUT/*.json(N)); n=${#jsons}
if (( n >= 24 )); then launchctl bootout gui/$(id -u)/com.jarvis.oc-heapwatch; exit 0; fi
f=$OUT/$(date +%Y%m%d-%H%M).json
/opt/homebrew/bin/openclaw gateway call diagnostics.heapProfile --json --params '{"durationMs":900000}' --timeout 960000 > $f.tmp 2>>$OUT/errors.log && mv $f.tmp $f || rm -f $f.tmp
# footprint del gateway a fine finestra, per legare la crescita alle finestre
pid=$(launchctl list | awk '$3=="ai.openclaw.gateway"{print $1}')
echo "$(date +%FT%T) $(footprint -p $pid 2>/dev/null | grep -o 'phys_footprint: [0-9.]* [A-Z]*')" >> $OUT/footprint.log

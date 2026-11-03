# quadra-backup fermo il 02/11/2026: wrangler aveva cambiato casa

Sintomo (da `logs/mac-health/2026-11-02-settimanale.md`): `com.jarvis.quadra-backup`
fermo, uscita 1, log pieno di `ERRORE: upload di part-000 fallito` con
`To continue without logging in, rerun this command with --temporary`.

Causa: wrangler 4.156.x legge le credenziali da `~/.wrangler/config/default.toml`,
mentre il login OAuth stava in `~/Library/Preferences/.wrangler/config/default.toml`
(scritto fino al 02/11 05:09 UTC, poi mai più letto). Risultato: `whoami` diceva
`not authenticated` e ogni giro orario faceva dump + upload fallito. Nessun buco nei
backup: il primario GitHub Actions (via gate Worker, non tocco da wrangler) ha
coperto 11-01 e 11-02 come `source: gh` (verificato in `index.json` su R2).

Cura (notte 03/11, solo reversibile):
1. copiato `default.toml` nel path letto da wrangler (`~/.wrangler/config/`, 600);
2. `whoami` ok (account Armonia), lettura `index.json` ok;
3. `run-mac.sh --force` → backup 2026-11-03 completo (112 tabelle, 244 MiB, 3 pezzi),
   `last-failure.json` rimosso, `check.sh` ok (17 copie);
4. `launchctl kickstart` → last exit code 0;
5. vecchio path reso symlink al nuovo (+ `.bak-20261103`), così un altro cambio
   di path non strandisce più le credenziali.

Se ricapita: `wrangler whoami` dice dov'è la config che legge davvero
(`Credentials are stored in: ...`); confrontare con dove sta il login.

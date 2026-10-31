#!/bin/bash
# Fixture di offload-guard-test.sh: il corpo lancia un test dietro un lanciatore di pacchetti. Non lo esegue nessuno.
cd "$(dirname "$0")" || exit 1
nice -n 10 pnpm playwright test

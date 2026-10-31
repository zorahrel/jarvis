#!/bin/bash
# MCP Supabase — figlio del gateway.
#
# Il token NON sta nel file di configurazione: si legge dal Keychain, così non
# finisce in chiaro né in un backup né in un git. Convenzione TOOLS.md:
#   security add-generic-password -s supabase -a jarvis -w "sbp_..." -U
#
# Token: Supabase → Account → Access Tokens. È revocabile in un click, a
# differenza della password del database.
set -euo pipefail
TOKEN="$(security find-generic-password -s supabase -a jarvis -w 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "supabase-mcp: nessun token nel Keychain (servizio 'supabase', account 'jarvis')" >&2
  exit 78
fi
exec npx -y @supabase/mcp-server-supabase@latest --access-token "$TOKEN" "$@"

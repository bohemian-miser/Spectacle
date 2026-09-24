#!/usr/bin/env bash
# One-time: serve the Cloud Run arena on your own domain.
#
# Buy the domain anywhere (Cloudflare Registrar is the suggestion — at-cost,
# free DNS); it only has to hold DNS records. This maps the domain onto the
# `spectacle` service with a Cloud Run domain mapping: no load balancer, so
# idle still costs nothing, WebSockets pass straight through, and Google
# issues and renews the certificate itself.
#
#   DOMAIN=play.example.com ./deploy/gcp/domain.sh
#   DOMAIN=example.com WWW=1 ./deploy/gcp/domain.sh     # apex and www.
#   DOMAIN=play.example.co.uk ROOT=example.co.uk ./deploy/gcp/domain.sh
#
# First run: if Google doesn't yet know you own the root domain it opens
# Search Console's verification — add the TXT record it shows at your DNS,
# click Verify, and run this again. Verify with the account you run gcloud
# as. Re-running is safe: existing mappings are skipped and the records are
# printed again.
#
# On Cloudflare DNS set every record this prints to "DNS only" (grey cloud).
# Proxied, the certificate can't be issued and Cloudflare sits in the
# WebSocket path.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=play.example.com}"
REGION="${REGION:-us-central1}"
NAME="${NAME:-spectacle}"
# The registrable domain to verify. Last two labels unless told otherwise
# (wrong for example.co.uk and the like — set ROOT there).
ROOT="${ROOT:-$(echo "$DOMAIN" | awk -F. '{ print $(NF-1) "." $NF }')}"
[ -n "${PROJECT:-}" ] && gcloud config set project "$PROJECT" >/dev/null

DOMAINS=("$DOMAIN")
[ "${WWW:-0}" = 1 ] && DOMAINS+=("www.$DOMAIN")

if ! gcloud domains list-user-verified --format='value(id)' | grep -qx "$ROOT"; then
  echo "$ROOT isn't verified for $(gcloud config get-value account 2>/dev/null) yet."
  echo "Opening verification: add the TXT record it shows, click Verify, then re-run this."
  gcloud domains verify "$ROOT"
  exit 1
fi

for d in "${DOMAINS[@]}"; do
  if gcloud beta run domain-mappings describe --domain "$d" --region "$REGION" >/dev/null 2>&1; then
    echo "mapping for $d exists"
  else
    gcloud beta run domain-mappings create --service "$NAME" --domain "$d" --region "$REGION"
  fi
done

echo
echo "Add these records at your DNS provider (DNS only, not proxied):"
for d in "${DOMAINS[@]}"; do
  echo
  echo "  $d"
  gcloud beta run domain-mappings describe --domain "$d" --region "$REGION" \
    --flatten=status.resourceRecords \
    --format='table[no-heading](status.resourceRecords.type,status.resourceRecords.name,status.resourceRecords.rrdata)' |
    sed 's/^/    /'
done

cat <<EOF

An empty "name" means the apex (@). The certificate follows once DNS
resolves — usually 15 minutes, up to a day. Check with:

  gcloud beta run domain-mappings describe --domain $DOMAIN --region $REGION \\
    --format='value(status.conditions)'

Then set the GitHub repository variable SPECTACLE_ONLINE_URL=https://$DOMAIN/
so the Pages build links to it.
EOF

#!/usr/bin/env bash
# Give each Cloud Run shard (spectacle-<name>, deployed by
# deploy-cloudrun.yml) its address <name>.s.hexagon.rodeo: a Cloud Run domain
# mapping plus a CNAME in the Cloud DNS zone Cloudflare delegates
# s.hexagon.rodeo to. No load balancer, nothing at Cloudflare. Run once after
# the first deploy, and again whenever SHARDS grows; re-running skips what
# exists. Google issues each certificate once its CNAME resolves (~15–60 min).
#
#   ./deploy/gcp/shard-domains.sh                  # b..z, as the workflow's default
#   SHARDS="b c d" ./deploy/gcp/shard-domains.sh
#
# Needs gcloud logged in as an owner of hexagon.rodeo in Search Console (as
# domain.sh did for the bare domain).
set -euo pipefail

REGION="${REGION:-us-central1}"
DNS_ZONE="${DNS_ZONE:-s-hexagon-rodeo}"
DNS_SUFFIX="${DNS_SUFFIX:-s.hexagon.rodeo}"
SHARDS="${SHARDS:-b c d e f g h i j k l m n o p q r s t u v w x y z}"

for s in $SHARDS; do
  host="$s.$DNS_SUFFIX"
  if ! gcloud run services describe "spectacle-$s" --region "$REGION" >/dev/null 2>&1; then
    echo "$host: no service spectacle-$s yet (deploy first) — skipped"
    continue
  fi
  gcloud beta run domain-mappings describe --domain "$host" --region "$REGION" >/dev/null 2>&1 ||
    gcloud beta run domain-mappings create --service "spectacle-$s" --domain "$host" --region "$REGION" --quiet >/dev/null
  gcloud dns record-sets describe "$host." --zone "$DNS_ZONE" --type CNAME >/dev/null 2>&1 ||
    gcloud dns record-sets create "$host." --zone "$DNS_ZONE" --type CNAME --ttl 300 --rrdatas ghs.googlehosted.com. >/dev/null
  echo "$host → spectacle-$s"
done

#!/usr/bin/env bash
# One-time: create the always-free e2-micro (us-west1, us-central1 or us-east1),
# a static IP, and a firewall rule for 80/443. Needs `gcloud` logged in with a
# project selected. Re-running is safe: existing resources are skipped.
#
#   ./deploy/gcp/create-vm.sh                       # plain HTTP on the IP
#   DOMAIN=spectacle.example.com ./deploy/gcp/create-vm.sh   # HTTPS via Caddy
#   DOMAIN="hexagon.rodeo www.hexagon.rodeo" ./deploy/gcp/create-vm.sh   # several names, spaced (gcloud splits on commas)
#   SHARD=b ./deploy/gcp/create-vm.sh                # another backend, b.s.hexagon.rodeo (Cloud DNS);
#                                                    # only one e2-micro is free: a second is ~$7/month + IP
#
# The live one (October 2026): NAME=spectacle, IP 35.209.98.188, serving
# DOMAIN="hexagon.rodeo a.s.hexagon.rodeo" — hexagon.rodeo is a fixed A record
# at Cloudflare (the registrar, which insists on its own nameservers) to that
# reserved IP; s.hexagon.rodeo is delegated to Cloud DNS (zone s-hexagon-rodeo).
#
# The VM runs as the project's default compute service account (as Cloud Run
# does), with the cloud-platform scope — IAM, not scopes, limits it — so the
# buckets (BOTS_URL, FEEDBACK_URL), Firestore and BigQuery work as there.
set -euo pipefail

ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
NAME="${NAME:-spectacle}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# SHARD=b gives this VM b.s.hexagon.rodeo: an A record in the Cloud DNS zone
# that Cloudflare delegates s.hexagon.rodeo to, so a new backend needs no
# Cloudflare change — only `gcloud`. Its name is added to DOMAIN for Caddy.
DNS_ZONE="${DNS_ZONE:-s-hexagon-rodeo}"
DNS_SUFFIX="${DNS_SUFFIX:-s.hexagon.rodeo}"
if [ -n "${SHARD:-}" ]; then
  [ "$NAME" = spectacle ] && NAME="spectacle-$SHARD"
  DOMAIN="${DOMAIN:+$DOMAIN }$SHARD.$DNS_SUFFIX"
fi

# Standard tier: 200 GB/month of egress free (Premium gives 1 GB). The address
# itself is billed while in use ($0.005/h, ~$3.65/month) — the one cost here.
gcloud compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 ||
  gcloud compute addresses create "$NAME-ip" --region "$REGION" --network-tier STANDARD

gcloud compute firewall-rules describe "$NAME-web" >/dev/null 2>&1 ||
  gcloud compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME"

META="startup-script=$HERE/startup.sh"
if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "instance $NAME exists; refreshing startup script and rebooting"
  gcloud compute instances add-metadata "$NAME" --zone "$ZONE" --metadata-from-file "$META" \
    ${DOMAIN:+--metadata spectacle-domain="$DOMAIN"}
  gcloud compute instances reset "$NAME" --zone "$ZONE"
else
  gcloud compute instances create "$NAME" \
    --zone "$ZONE" \
    --machine-type e2-micro \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 20GB --boot-disk-type pd-standard \
    --tags "$NAME" \
    --address "$NAME-ip" --network-tier STANDARD \
    --scopes cloud-platform \
    --metadata-from-file "$META" \
    ${DOMAIN:+--metadata spectacle-domain="$DOMAIN"}
fi

IP=$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')
if [ -n "${SHARD:-}" ]; then
  gcloud dns record-sets describe "$SHARD.$DNS_SUFFIX." --zone "$DNS_ZONE" --type A >/dev/null 2>&1 ||
    gcloud dns record-sets create "$SHARD.$DNS_SUFFIX." --zone "$DNS_ZONE" --type A --ttl 300 --rrdatas "$IP"
fi
echo
echo "VM: $NAME in $ZONE, IP $IP"
echo "First boot installs Docker and pulls the image; give it ~3 minutes, then open http://$IP/"
[ -n "${DOMAIN:-}" ] && echo "Point an A record for $DOMAIN at $IP; Caddy fetches the certificate on first request."
echo "Logs:   gcloud compute ssh $NAME --zone $ZONE -- sudo docker compose -f /opt/spectacle/docker-compose.yml logs -f spectacle"
echo "Stop:   gcloud compute instances stop $NAME --zone $ZONE     (start again with 'start')"
echo "Delete: gcloud compute instances delete $NAME --zone $ZONE && gcloud compute addresses delete $NAME-ip --region $REGION"

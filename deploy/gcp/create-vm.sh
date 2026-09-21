#!/usr/bin/env bash
# One-time: create the always-free e2-micro (us-west1, us-central1 or us-east1),
# a static IP, and a firewall rule for 80/443. Needs `gcloud` logged in with a
# project selected. Re-running is safe: existing resources are skipped.
#
#   ./deploy/gcp/create-vm.sh                       # plain HTTP on the IP
#   DOMAIN=spectacle.example.com ./deploy/gcp/create-vm.sh   # HTTPS via Caddy
set -euo pipefail

ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
NAME="${NAME:-spectacle}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 ||
  gcloud compute addresses create "$NAME-ip" --region "$REGION"

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
    --address "$NAME-ip" \
    --metadata-from-file "$META" \
    ${DOMAIN:+--metadata spectacle-domain="$DOMAIN"}
fi

IP=$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')
echo
echo "VM: $NAME in $ZONE, IP $IP"
echo "First boot installs Docker and pulls the image; give it ~3 minutes, then open http://$IP/"
[ -n "${DOMAIN:-}" ] && echo "Point an A record for $DOMAIN at $IP; Caddy fetches the certificate on first request."
echo "Logs:   gcloud compute ssh $NAME --zone $ZONE -- sudo docker compose -f /opt/spectacle/docker-compose.yml logs -f spectacle"
echo "Stop:   gcloud compute instances stop $NAME --zone $ZONE     (start again with 'start')"
echo "Delete: gcloud compute instances delete $NAME --zone $ZONE && gcloud compute addresses delete $NAME-ip --region $REGION"

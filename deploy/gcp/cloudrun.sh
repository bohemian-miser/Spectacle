#!/usr/bin/env bash
# Deploy to Cloud Run, scaling to zero when nobody is connected.
#
# Cloud Build builds the Dockerfile from source; one instance at most (the
# arena lives in that process), none when idle. Cloud Run caps a request —
# and so a WebSocket — at 60 minutes; the client reconnects and resumes the
# same player (join.resume), so players see nothing. When the last player
# leaves, the instance is retired after ~15 idle minutes and the arena resets
# — nobody was there to notice.
#
#   ./deploy/gcp/cloudrun.sh                 # first run prompts to enable APIs
#   REGION=europe-west1 BOTS=5 ./deploy/gcp/cloudrun.sh
set -euo pipefail

REGION="${REGION:-us-central1}"
NAME="${NAME:-spectacle}"
BOTS="${BOTS:-3}"
cd "$(dirname "$0")/../.."

gcloud run deploy "$NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 1 \
  --concurrency 1000 \
  --timeout 3600 \
  --cpu 1 --memory 512Mi \
  --session-affinity \
  --set-env-vars "BOTS=$BOTS,FIELD_FAMILY=${FIELD_FAMILY:-hex},FIELD_LEVEL=${FIELD_LEVEL:-5}${KNOBS:+,$KNOBS}"

echo
gcloud run services describe "$NAME" --region "$REGION" --format='value(status.url)'
echo "Tune later:  gcloud run services update $NAME --region $REGION --update-env-vars KNOB_BASE_STEP_MS=300"
echo "Turn off:    gcloud run services delete $NAME --region $REGION   (or just leave it: idle costs nothing)"

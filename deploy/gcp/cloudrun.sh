#!/usr/bin/env bash
# Deploy to Cloud Run, scaling to zero when nobody is connected.
#
# Cloud Build builds the Dockerfile from source. Each instance holds its own
# self-contained pool of rooms (nothing is shared between instances — see
# server/index.ts's "Scaling past one instance"), so MAX_INSTANCES can scale
# out under a surge; MIN_INSTANCES stays 0 by default (scale to zero) unless
# you want one warm ahead of time. Cloud Run caps a request — and so a
# WebSocket — at 60 minutes; the client reconnects and resumes the same
# player (join.resume), so players see nothing. When an instance's last
# player leaves, it is retired after ~15 idle minutes and its rooms with it —
# nobody was there to notice.
#
#   ./deploy/gcp/cloudrun.sh                 # first run prompts to enable APIs
#   REGION=europe-west1 BOTS=5 ./deploy/gcp/cloudrun.sh
#   MAX_INSTANCES=50 MIN_INSTANCES=2 ./deploy/gcp/cloudrun.sh   # ahead of a surge
set -euo pipefail

REGION="${REGION:-us-central1}"
NAME="${NAME:-spectacle}"
BOTS="${BOTS:-1}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-30}"
MEMORY="${MEMORY:-1Gi}"
MAX_INSTANCE_PLAYERS="${MAX_INSTANCE_PLAYERS:-400}"
CONCURRENCY="${CONCURRENCY:-500}"
cd "$(dirname "$0")/../.."

gcloud run deploy "$NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" \
  --concurrency "$CONCURRENCY" \
  --timeout 3600 \
  --cpu 1 --memory "$MEMORY" \
  --cpu-boost \
  --session-affinity \
  --set-env-vars "BOTS=$BOTS,FIELD_FAMILY=${FIELD_FAMILY:-hex},FIELD_LEVEL=${FIELD_LEVEL:-5},MAX_INSTANCE_PLAYERS=$MAX_INSTANCE_PLAYERS${KNOBS:+,$KNOBS}"

echo
gcloud run services describe "$NAME" --region "$REGION" --format='value(status.url)'
echo "Tune later:  gcloud run services update $NAME --region $REGION --update-env-vars KNOB_BASE_STEP_MS=300"
echo "Ahead of a surge:  gcloud run services update $NAME --region $REGION --min-instances=2 --max-instances=50 --cpu=2 --memory=2Gi --concurrency=1000 --update-env-vars MAX_INSTANCE_PLAYERS=800"
echo "Turn off:    gcloud run services delete $NAME --region $REGION   (or just leave it: idle costs nothing)"

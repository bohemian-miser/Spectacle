#!/usr/bin/env bash
# Pattern stats that outlive the servers: route every finished stint and won
# round (the `{"message":"stint",…}` and `{"message":"win",…}` lines
# server/index.ts logs) from Cloud Run into a
# BigQuery dataset, so which rules get played, how much of the board they
# cover and how much of their time is bots' can be queried across every
# instance and every deploy. docs/pattern-stats.md has the queries.
#
# A Cloud Logging sink, not code: the servers don't change and get no new
# permissions. The sink's own writer identity may write to this one dataset
# and nothing else. Logs from before the sink exists are not copied in.
#
# Idempotent; setup-ci.sh runs it, or run it alone with `gcloud` (and `bq`)
# logged in:
#
#   PROJECT=my-gcp-project ./deploy/gcp/stats-sink.sh
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to your GCP project id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-spectacle}"
DATASET="${DATASET:-spectacle_stats}"
SINK="${SINK:-spectacle-stints}"

gcloud services enable logging.googleapis.com bigquery.googleapis.com --project "$PROJECT"

bq --project_id "$PROJECT" show --dataset "$PROJECT:$DATASET" >/dev/null 2>&1 ||
  bq --project_id "$PROJECT" --location "$REGION" mk --dataset \
    --description "Spectacle pattern stats: one row per finished stint, from the $SINK log sink" \
    "$PROJECT:$DATASET"

FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND (jsonPayload.message=\"stint\" OR jsonPayload.message=\"win\")"
DEST="bigquery.googleapis.com/projects/$PROJECT/datasets/$DATASET"
if gcloud logging sinks describe "$SINK" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud logging sinks update "$SINK" "$DEST" --log-filter "$FILTER" --project "$PROJECT" --quiet
else
  # One table (run_googleapis_com_stdout) partitioned by day, not a table a day.
  gcloud logging sinks create "$SINK" "$DEST" --log-filter "$FILTER" \
    --use-partitioned-tables --project "$PROJECT" --quiet
fi

# The sink writes as its own identity; let it edit this dataset only.
WRITER=$(gcloud logging sinks describe "$SINK" --project "$PROJECT" --format 'value(writerIdentity)')
MEMBER="${WRITER#serviceAccount:}"
ACL=$(mktemp)
trap 'rm -f "$ACL"' EXIT
bq --project_id "$PROJECT" show --format prettyjson "$PROJECT:$DATASET" > "$ACL"
if ! grep -q "\"$MEMBER\"" "$ACL"; then
  python3 - "$ACL" "$MEMBER" <<'PY'
import json, sys
path, member = sys.argv[1], sys.argv[2]
ds = json.load(open(path))
ds.setdefault('access', []).append({'role': 'WRITER', 'userByEmail': member})
json.dump(ds, open(path, 'w'))
PY
  bq --project_id "$PROJECT" update --source "$ACL" "$PROJECT:$DATASET"
fi

cat <<MSG

Stints and wins from Cloud Run service "$SERVICE" now go to BigQuery:
  $PROJECT.$DATASET.run_googleapis_com_stdout
(the table appears with the first stint after this; docs/pattern-stats.md has the queries).
MSG

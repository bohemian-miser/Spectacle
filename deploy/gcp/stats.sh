#!/usr/bin/env bash
# One-time: the permanent leaderboard and pattern stats that every shard
# shares (server/firestore.ts, server/bigquery.ts). Re-running skips what
# exists. Done for spectacle-game on 2026-10-21.
#
#   Firestore (default) database, us-central1  — `wins`, one document per won round
#     + composite indexes (mode, level, [subset,] [bot,] ms, at): four
#   BigQuery dataset `spectacle`, us-central1   — `stints` and `wins`, day-partitioned,
#     never expiring (schemas: bq-stints.json, bq-wins.json)
#   The runtime service account (Cloud Run's and the VM's) may write both:
#     roles/datastore.user, roles/bigquery.jobUser, WRITER on the dataset.
#
# Free tiers cover it: Firestore 50k reads / 20k writes a day, BigQuery 10 GB
# stored and 1 TB queried a month; streaming inserts are $0.01 per 200 MB.
set -euo pipefail

P="${PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-us-central1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SA="${SA:-$(gcloud projects describe "$P" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"

gcloud services enable firestore.googleapis.com bigquery.googleapis.com --project "$P"
gcloud firestore databases describe --project "$P" >/dev/null 2>&1 ||
  gcloud firestore databases create --location="$REGION" --type=firestore-native --project "$P"
existing=$(gcloud firestore indexes composite list --project "$P" --format='value(fields)' 2>/dev/null || true)
for fields in "mode level ms at" "mode level subset ms at" "mode level bot ms at" "mode level subset bot ms at"; do
  echo "$existing" | tr -s ' ;\n' ' ' | grep -q "$(echo "$fields" | sed 's/ /.*/g')" && continue
  args=()
  for f in $fields; do args+=(--field-config="field-path=$f,order=ascending"); done
  gcloud firestore indexes composite create --collection-group=wins --query-scope=COLLECTION "${args[@]}" --project "$P" --async
done

bq --project_id="$P" show "$P:spectacle" >/dev/null 2>&1 ||
  bq --project_id="$P" --location="$REGION" mk --dataset "$P:spectacle"
bq --project_id="$P" show "$P:spectacle.stints" >/dev/null 2>&1 ||
  bq --project_id="$P" mk --table --time_partitioning_field endedAt --time_partitioning_type DAY "$P:spectacle.stints" "$HERE/bq-stints.json"
bq --project_id="$P" show "$P:spectacle.wins" >/dev/null 2>&1 ||
  bq --project_id="$P" mk --table --time_partitioning_field wonAt --time_partitioning_type DAY "$P:spectacle.wins" "$HERE/bq-wins.json"

for role in roles/datastore.user roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role="$role" --condition=None -q >/dev/null
done
tmp=$(mktemp)
bq --project_id="$P" show --format=prettyjson "$P:spectacle" > "$tmp"
if ! grep -q "$SA" "$tmp"; then
  python3 - "$tmp" "$SA" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d['access'].append({'role': 'WRITER', 'userByEmail': sys.argv[2]}); json.dump(d, open(sys.argv[1], 'w'))
PY
  bq --project_id="$P" update --source "$tmp" "$P:spectacle"
fi
rm -f "$tmp"
echo "Stores ready. Servers need WINS_FIRESTORE=$P and STATS_BIGQUERY=$P.spectacle."

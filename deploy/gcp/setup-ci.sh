#!/usr/bin/env bash
# One-time: let GitHub Actions deploy the online arena to Cloud Run on every
# merge to main, so nobody (human or Claude) needs GCP credentials day to day.
#
# Creates an Artifact Registry repo, a deployer service account with just the
# roles the workflow needs, and a key; then prints the secrets/variables to
# add to the GitHub repo. Run once with `gcloud` logged in:
#
#   PROJECT=my-gcp-project ./deploy/gcp/setup-ci.sh
#   PROJECT=my-gcp-project REGION=europe-west1 ./deploy/gcp/setup-ci.sh
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to your GCP project id}"
REGION="${REGION:-us-central1}"
SA_NAME="${SA_NAME:-spectacle-deployer}"
REPO="${REPO:-spectacle}"
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com

gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location "$REGION" --repository-format docker \
    --description "Spectacle game images"

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "Spectacle CI deployer"

for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --quiet >/dev/null
done

KEY=$(mktemp)
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" >/dev/null

cat <<MSG

Done. In the GitHub repo (Settings → Secrets and variables → Actions):

  Secret   GCP_SA_KEY     = the contents of $KEY   (delete the file afterwards)
  Variable GCP_PROJECT    = $PROJECT
  Variable GCP_REGION     = $REGION
  Variable GCP_AR_REPO    = $REPO

The "Deploy online arena to Cloud Run" workflow then runs on every push to
main (and on demand from the Actions tab). Its output prints the service URL;
put that in the SPECTACLE_ONLINE_URL variable so the Pages build links to it.

Tighter option later: replace the key with Workload Identity Federation
(google-github-actions/auth supports it) so no long-lived secret exists.
MSG

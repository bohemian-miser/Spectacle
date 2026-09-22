#!/usr/bin/env bash
# One-time: let GitHub Actions deploy the online arena to Cloud Run on every
# merge to main, so nobody (human or Claude) needs GCP credentials day to day.
#
# Creates an Artifact Registry repo, a deployer service account with just the
# roles the workflow needs, and a Workload Identity Federation pool that lets
# *only this GitHub repo* impersonate it. No service-account key is created:
# GitHub's OIDC token is exchanged for a short-lived GCP one at deploy time,
# so there is no long-lived secret to leak or rotate. (Many orgs enforce
# constraints/iam.disableServiceAccountKeyCreation, which forbids keys
# outright — this path works there too.)
#
# Then prints the variables to add to the GitHub repo. Run once with `gcloud`
# logged in:
#
#   PROJECT=my-gcp-project ./deploy/gcp/setup-ci.sh
#   PROJECT=my-gcp-project REGION=europe-west1 REPO_SLUG=owner/name ./deploy/gcp/setup-ci.sh
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to your GCP project id}"
REGION="${REGION:-us-central1}"
SA_NAME="${SA_NAME:-spectacle-deployer}"
REPO="${REPO:-spectacle}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-spectacle}"
REPO_SLUG="${REPO_SLUG:-bohemian-miser/Spectacle}"
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudbuild.googleapis.com

PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location "$REGION" --repository-format docker \
    --description "Spectacle game images"

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "Spectacle CI deployer"

for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --quiet >/dev/null
done

# The pool holds the trust; the provider says *who* may use it. The attribute
# condition is the load-bearing line — without it any repo on GitHub could mint
# a token for this service account.
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" \
    --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition "assertion.repository=='$REPO_SLUG'"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PNUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO_SLUG" \
  --quiet >/dev/null

WIF="projects/$PNUM/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

cat <<MSG

Done. No key was created — nothing here needs to be kept secret.

In the GitHub repo (Settings → Secrets and variables → Actions → Variables):

  GCP_PROJECT       = $PROJECT
  GCP_REGION        = $REGION
  GCP_AR_REPO       = $REPO
  GCP_WIF_PROVIDER  = $WIF
  GCP_DEPLOYER_SA   = $SA

Or in one go:

  gh variable set GCP_PROJECT      --body '$PROJECT'
  gh variable set GCP_REGION       --body '$REGION'
  gh variable set GCP_AR_REPO      --body '$REPO'
  gh variable set GCP_WIF_PROVIDER --body '$WIF'
  gh variable set GCP_DEPLOYER_SA  --body '$SA'

The "Deploy online arena to Cloud Run" workflow then runs on every push to
main (and on demand from the Actions tab). Its output prints the service URL;
put that in the SPECTACLE_ONLINE_URL variable so the Pages build links to it.

Only $REPO_SLUG can assume this service account. Set REPO_SLUG= if you fork.
MSG

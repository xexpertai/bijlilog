#!/usr/bin/env bash
# Deploys BijliLog to Cloud Run. Needs Harsha's OK first (public URL). Never prints the key.
# The relay key (TESTNET-ONLY throwaway, from .env.local) goes into Secret Manager and is mounted as an env secret, never into the image.
# Billing: budget alerts only (see Tour Scout's docs/DEPLOY.md), never an auto-disable cap.
# Usage: CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM_PUBLIC:-}" = 1 ] || { echo "Set CONFIRM_PUBLIC=1 (this makes the URL public)."; exit 1; }
PROJECT="${GCP_PROJECT:-project-16f86bbf-e49e-498c-82d}"; REGION="${REGION:-us-central1}"; SECRET=bijlilog-relay-key
set -a; . ./.env.local; set +a
: "${SPONSOR_PRIVATE_KEY:?missing in .env.local}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com --project "$PROJECT" --quiet
if ! gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy=automatic --quiet
fi
printf %s "$SPONSOR_PRIVATE_KEY" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- --quiet >/dev/null
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:${NUM}-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor --quiet >/dev/null
gcloud run deploy bijlilog --project "$PROJECT" --region "$REGION" --source . --allow-unauthenticated \
  --max-instances 2 --memory 512Mi --cpu 1 --set-secrets "SPONSOR_PRIVATE_KEY=${SECRET}:latest" --quiet
URL=$(gcloud run services describe bijlilog --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
echo "$URL"
curl -fsS "$URL/health" && echo && curl -fsS "$URL/api/config"; echo

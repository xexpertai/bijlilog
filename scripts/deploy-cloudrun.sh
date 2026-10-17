#!/usr/bin/env bash
# Deploys BijliLog to Cloud Run. Needs Harsha's OK first (public URL). Never prints the key.
# Prereqs: gcloud logged in, project set. The relay key is a TESTNET-ONLY throwaway read from .env.local.
# Usage: CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM_PUBLIC:-}" = 1 ] || { echo "Set CONFIRM_PUBLIC=1 (this makes the URL public)."; exit 1; }
PROJECT="${GCP_PROJECT:-project-16f86bbf-e49e-498c-82d}"; REGION="${REGION:-us-central1}"
set -a; . ./.env.local; set +a
: "${SPONSOR_PRIVATE_KEY:?missing in .env.local}"
gcloud run deploy bijlilog --project "$PROJECT" --region "$REGION" --source . --allow-unauthenticated \
  --max-instances 2 --memory 512Mi --cpu 1 --set-env-vars "SPONSOR_PRIVATE_KEY=${SPONSOR_PRIVATE_KEY}" --quiet
gcloud run services describe bijlilog --project "$PROJECT" --region "$REGION" --format 'value(status.url)'

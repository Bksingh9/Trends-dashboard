#!/usr/bin/env bash
# Configure the Vercel deployment. Run locally, where you're logged in.
#
#   vercel login
#   vercel link --project trends-dashboard --scope trends-nps
#   bash scripts/vercel-setup.sh
#
# Secrets below were generated fresh for this project. Regenerate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
set -euo pipefail

add() { printf '%s' "$2" | vercel env add "$1" production --force >/dev/null && echo "  set $1"; }

echo "Setting required production env..."

# Vercel sends this automatically as `Authorization: Bearer $CRON_SECRET` on
# cron invocations. Without it, isCronAuthorised fails closed in production and
# BOTH scheduled jobs 401 silently — they look like they ran and did nothing.
add CRON_SECRET 'TIJS9CWH8TX2gU3qrS9z3PD0TYw7yIzRZntdJ3idwbo'

# Gates the dashboard. Without both of these the URL is publicly readable,
# which today exposes internal store ids, the GA4 property, the BigQuery
# project and table names, the Jira board and Slack channel ids.
add NEXTAUTH_SECRET 'GoI7trfK3g8S_zEqvB8SPLXUfkGk37vB8f5Zg1fb2Tk'
add AUTH_ALLOWLIST '@gofynd.com:pm'
add NEXTAUTH_URL 'https://trends-dashboard.vercel.app'

# §27.4 — salts the customer_id hash. hashCustomerId THROWS in production
# without it, so bq-orders would fail the moment BigQuery is connected.
add CUSTOMER_ID_SALT 'Jr4UFUmHuuoXa9oeAoOUndPTjWFFdH1YJiylJkeGLmQ'

echo
echo "Done. Redeploy to pick them up:  vercel --prod"
echo "Then open /connectors/setup on the deployment to see what is still blocked."

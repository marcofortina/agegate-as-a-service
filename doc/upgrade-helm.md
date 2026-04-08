# Upgrading the Helm Chart (Zero Downtime)

This document explains how to upgrade the `agegate-verifier` Helm chart without interrupting the service.

## Prerequisites

- Helm 3 installed
- Access to the Kubernetes cluster
- The current release is already deployed

## Upgrade Strategy

The chart uses a `Deployment` with a RollingUpdate strategy by default, ensuring zero downtime as long as:
- At least two replicas are running (`replicaCount >= 2`)
- The new version is compatible with the existing database schema

## Step-by-step Upgrade

### 1. Fetch the latest chart code

```bash
cd ~/agegate-as-a-service
git pull origin master
```

### 2. Review changes (optional)

```bash
git diff <old-commit> <new-commit> -- agegate-verifier/
```

### 3. Perform the upgrade

```bash
helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --reuse-values
```

If you need to override a value (e.g., a new environment variable):

```bash
helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --reuse-values \
  --set env.RETENTION_DAYS=60
```

### 4. Monitor the rollout

```bash
kubectl rollout status deployment agegate-verifier -n agegate
```

Expected output:
```
Waiting for deployment "agegate-verifier" rollout to finish: 1 of 2 updated replicas are available...
deployment "agegate-verifier" successfully rolled out
```

### 5. Verify the new version

```bash
kubectl get pods -n agegate -l app=agegate-verifier
```

Check that all pods are `Running` and that the `/health` endpoint returns 200.

## Database Migrations

The application runs database migrations automatically on startup (idempotent). No manual intervention is needed.

## Rollback

If the new version fails, you can rollback to the previous revision:

```bash
# List revisions
helm history agegate-verifier -n agegate

# Rollback to revision N
helm rollback agegate-verifier <N> -n agegate
```

## Troubleshooting

### Pods stuck in CrashLoopBackOff

```bash
kubectl logs -n agegate -l app=agegate-verifier --tail=100
```

Common causes:
- Missing environment variables (e.g., `ADMIN_PASS`, `TIMESCALEDB_PASSWORD`)
- Database connection issues (check if TimescaleDB is ready)

### Helm upgrade fails with "template: no template ..."

This usually means the chart structure changed. Try:

```bash
helm dependency update ./agegate-verifier
helm upgrade --install agegate-verifier ./agegate-verifier --namespace agegate --reuse-values
```

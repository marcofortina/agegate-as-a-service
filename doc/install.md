# Installation

## Prerequisites

* k3s cluster with Helm 3 and Ingress NGINX installed
* `kubectl` configured and pointing to your cluster
* Namespace-level permissions to create resources

---

## K3s Lab Deployment (updated April 2026)

### 1. Deploy the application with dependencies

All dependencies (Redis and TimescaleDB) are included as Helm subcharts. Deploy everything in a single command:

```bash
cd ~/agegate-as-a-service

helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --create-namespace \
  --values agegate-verifier/values.yaml \
  --set secrets.TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD \
  --set secrets.ADMIN_PASS=YOUR_ADMIN_PASSWORD
```

> ✅ The `--set` flags are used to pass sensitive passwords. All other configuration is loaded from `values.yaml`.

### 2. Verify infrastructure

```bash
kubectl get pods -n agegate
kubectl get svc -n agegate
```

Expected services:

* All pods are in `Running` or `Completed` state
* Persistent Volume Claims are correctly bound
* `redis` on port `6379`
* `timescaledb` on port `5432`

---

### 7. Health checks

Forward local port to the application pod:

```bash
kubectl port-forward svc/agegate-verifier 8080:8080 -n agegate
```

Then verify:

* http://localhost:8080/health
* http://localhost:8080/ready

---

### 8. Access the service

If Ingress is configured:

```
http://agegate.local/api/v1/api-docs
```

Otherwise use port-forward (see above).

---

## Notes

### Data Retention (GDPR compliance)

Verification records are automatically deleted after a configurable number of days using TimescaleDB's retention policy.

Set the environment variable `RETENTION_DAYS` (default: `30`). For example, in `values.yaml`:

```yaml
env:
  RETENTION_DAYS: "30"
```

To disable automatic deletion, set `RETENTION_DAYS: "0"` (not recommended for production).
The retention job runs automatically every 24 hours.

* Redis is deployed as a single-instance Deployment (suitable for lab environments)
* TimescaleDB uses a StatefulSet with persistent storage (`5Gi`)

### Database configuration

* Database: `agegate`
* User: `postgres`
* Password: managed via Kubernetes Secret (`agegate-secrets`)

⚠️ **Important:**

* The database password is injected via `secretKeyRef` into the container
* The same secret (`TIMESCALEDB_PASSWORD`) must be used by the application
* Updating the Secret does NOT automatically change the database password for an existing instance

If you change the password:

```bash
kubectl delete pod -l app=timescaledb -n agegate
```

(or recreate the database in lab environments)

---

## Troubleshooting

### Pods not starting

```bash
kubectl describe pod <pod-name> -n agegate
kubectl logs <pod-name> -n agegate
```

---

### Check services

```bash
kubectl get svc -n agegate
```

---

### Check secrets

```bash
kubectl get secrets -n agegate
```

---

### Common issues

* Missing `agegate-secrets`
* Incorrect Helm values
* Database not ready before application startup
* Ingress not resolving `agegate.local`

---

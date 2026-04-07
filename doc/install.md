# Installation

## Prerequisites

* k3s cluster with Helm 3 and Ingress NGINX installed
* `kubectl` configured and pointing to your cluster
* Namespace-level permissions to create resources

---

## K3s Lab Deployment (updated April 2026)

### 1. Create namespace

```bash
kubectl create ns agegate
```

---

### 2. Deploy Redis and TimescaleDB

Apply the provided manifests:

```bash
kubectl apply -f redis.yaml
kubectl apply -f timescaledb.yaml
```

---

### 3. Verify infrastructure

```bash
kubectl get pods -n agegate
kubectl get svc -n agegate
```

Expected services:

* `redis` on port `6379`
* `timescaledb` on port `5432`

---

### 4. Create secrets

```bash
kubectl create secret generic agegate-secrets \
  --from-literal=ADMIN_PASS=YOUR_ADMIN_PASSWORD \
  --from-literal=TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD \
  -n agegate
```

---

### 5. Deploy the application

```bash
cd ~/agegate-as-a-service

helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --values agegate-verifier/values.yaml
```

---

### 6. Verify deployment

```bash
kubectl get pods -n agegate
kubectl get pvc -n agegate
```

Ensure:

* All pods are in `Running` or `Completed` state
* Persistent Volume Claims are correctly bound

---

### 7. Health checks

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
http://agegate.local/api-docs
```

Otherwise use port-forward (see above).

---

## Notes

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

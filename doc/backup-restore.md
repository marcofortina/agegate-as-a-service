# Backup and Restore of TimescaleDB

This document describes how to back up and restore the TimescaleDB database used by Age Gate as a Service.

## Prerequisites

- Access to the Kubernetes cluster (kubectl)
- `pg_dump` and `pg_restore` utilities installed (usually from `postgresql-client` package)
- Sufficient disk space for the backup file

## Backup Procedure

### 1. Identify the TimescaleDB pod

```bash
kubectl get pods -n agegate | grep timescaledb
```

Example output:
```
timescaledb-0   1/1     Running   0   10h
```

### 2. Perform a custom‑format dump (recommended)

The custom format allows parallel restore and selective restoration.

```bash
kubectl exec -n agegate timescaledb-0 -- \
  pg_dump -Fc -U postgres -d agegate > agegate_backup.dump
```

### 3. Alternatively, produce a plain SQL dump

```bash
kubectl exec -n agegate timescaledb-0 -- \
  pg_dump -U postgres -d agegate > agegate_backup.sql
```

### 4. Compress the backup (optional)

```bash
gzip agegate_backup.dump
```

## Restore Procedure

### From a custom‑format dump

```bash
# Copy the dump into the pod
kubectl cp agegate_backup.dump agegate/timescaledb-0:/tmp/backup.dump

# Restore (drop existing database first if you want a clean slate)
kubectl exec -n agegate timescaledb-0 -- bash -c \
  "pg_restore -Fc -U postgres -d agegate -c /tmp/backup.dump"
```

### From a plain SQL dump

```bash
# Copy the SQL file into the pod
kubectl cp agegate_backup.sql agegate/timescaledb-0:/tmp/backup.sql

# Restore
kubectl exec -n agegate timescaledb-0 -- bash -c \
  "psql -U postgres -d agegate -f /tmp/backup.sql"
```

## Backup of Redis (optional)

Although Redis is used only for rate limiting and IP salt storage (ephemeral), you may want to back up its data.

```bash
# Save current dataset to disk (RDB)
kubectl exec -n agegate redis-6c6fcd64b8-n7zm6 -- redis-cli SAVE

# Copy the dump.rdb file
kubectl cp agegate/redis-6c6fcd64b8-n7zm6:/data/dump.rdb ./redis_backup.rdb
```

## Scheduled Backups (CronJob)

You can create a Kubernetes CronJob to automate daily backups.

Example CronJob manifest (`cronjob-backup.yaml`):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: timescaledb-backup
  namespace: agegate
spec:
  schedule: "0 2 * * *"   # every day at 2:00 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:14
            command:
            - /bin/sh
            - -c
            - |
              pg_dump -Fc -U postgres -d agegate -h timescaledb.agegate.svc.cluster.local > /backup/agegate_backup_$(date +\%Y\%m\%d).dump
            volumeMounts:
            - name: backup-storage
              mountPath: /backup
          volumes:
          - name: backup-storage
            persistentVolumeClaim:
              claimName: backup-pvc
          restartPolicy: OnFailure
```

Apply it with:

```bash
kubectl apply -f cronjob-backup.yaml
```

# Log Management and Rotation

The Age Gate as a Service application generates logs via Pino (structured logging). To prevent unbounded disk usage, log rotation and retention must be configured both in development (Docker Compose) and production (K3s).

## Docker Compose (Local Development)

In `docker-compose.test.yml`, we have added logging limits for the TimescaleDB and Redis containers:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

This limits each container log file to 10 MB and keeps up to 3 rotated files (total 30 MB).

For the `agegate-verifier` application (when run locally via `node server.js`), logs are written to stdout/stderr. You can redirect them to a file and use `logrotate`:

```bash
node server.js >> app.log 2>&1
```

## Kubernetes (K3s Production)

In a K3s cluster, you can configure log rotation via **kubelet flags**. Add the following to `/etc/rancher/k3s/config.yaml`:

```yaml
kubelet-arg:
  - "container-log-max-size=10Mi"
  - "container-log-max-files=5"
```

Then restart K3s:

```bash
sudo systemctl restart k3s
```

These limits apply to all containers in the cluster. Each container will keep at most 5 log files of 10 MB each (total 50 MB).

For K3s, you can pass these flags to the kubelet via the `--kubelet-arg` parameter when starting K3s.

### Application‑level log rotation

Alternatively, you can configure the Pino logger to write to a rotating file using `pino-roll` or similar. This would require code changes.

## Monitoring disk usage

Use Prometheus and Grafana to monitor disk usage of the nodes and alert when log storage exceeds thresholds.

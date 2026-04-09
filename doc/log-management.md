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

In a K3s cluster, you can configure log rotation at the container runtime level. For K3s using containerd, edit `/etc/rancher/k3s/registries.yaml` or configure the kubelet's log rotation parameters. Alternatively, use a sidecar container with a log rotator like `fluentd` or `logrotate`.

### Recommended approach: Use `logrotate` sidecar

Add a sidecar container in your Helm deployment that tails the log file and rotates it. However, the simplest method is to rely on the container runtime's built-in log rotation. For containerd, you can set the following kubelet flags:

```yaml
# In kubelet configuration (not directly in Helm)
--container-log-max-size=10Mi
--container-log-max-files=5
```

For K3s, you can pass these flags to the kubelet via the `--kubelet-arg` parameter when starting K3s.

### Application‑level log rotation

Alternatively, you can configure the Pino logger to write to a rotating file using `pino-roll` or similar. This would require code changes.

## Monitoring disk usage

Use Prometheus and Grafana to monitor disk usage of the nodes and alert when log storage exceeds thresholds.

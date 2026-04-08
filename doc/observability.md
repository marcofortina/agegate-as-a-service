# Observability with OpenTelemetry, Prometheus and Grafana

This document describes how to monitor the `agegate-verifier` service using the **OpenTelemetry** standard, a local **Prometheus** stack for metrics, and **Grafana** for visualization. Optionally, **Tempo** can be added for distributed tracing.

## Architecture

```
agegate-verifier (Node.js)  →  OpenTelemetry Collector  →  Prometheus (metrics)
                           └→  Tempo (traces, optional) └→  Grafana
```

- The application is instrumented with the OpenTelemetry Node.js SDK.
- An **OpenTelemetry Collector** runs as a deployment in the `agegate` namespace, receiving OTLP metrics and traces.
- **Prometheus** scrapes metrics from the Collector (and from Kubernetes itself).
- **Grafana** provides pre‑built dashboards (Kubernetes, Node.js application).
- **Tempo** (optional but recommended) stores traces and integrates with Grafana.

## Prerequisites

- Kubernetes cluster (K3s) with Helm 3 installed.
- `kubectl` configured to access the cluster.
- The `agegate` namespace already exists (you can create it with `kubectl create ns agegate`).

## 1. Install kube-prometheus-stack (Prometheus + Grafana)

This Helm chart installs Prometheus, Grafana, and the required service monitors.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30300 \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

After installation, retrieve the Grafana admin password with:

```bash
kubectl get secret --namespace monitoring -l app.kubernetes.io/component=admin-secret -o jsonpath="{.items[0].data.admin-password}" | base64 --decode ; echo
```

Or, if the secret name is known (e.g., `kube-prometheus-stack-grafana`):

```bash
kubectl --namespace monitoring get secrets kube-prometheus-stack-grafana -o jsonpath="{.data.admin-password}" | base64 -d ; echo
```

Access Grafana at `http://<node-ip>:30300` (user: `admin`, password: the one you retrieved).

To change the password, edit the secret or use the Grafana CLI inside the pod.

## 2. Deploy the OpenTelemetry Collector

The Collector receives telemetry data from the verifier app and forwards it to Prometheus (and optionally to Tempo).

### 2.1 Configuration file

The file `agegate-verifier/otel-collector-values.yaml` is already provided in the repository.
Its content should look like this (adjust if needed, e.g., change the exporter for Tempo):

```yaml
mode: deployment

image:
  repository: otel/opentelemetry-collector
  tag: 0.116.1
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

useGOMEMLIMIT: true

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8889"

config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

  processors:
    batch:
      timeout: 1s
      send_batch_size: 1024
    memory_limiter:
      check_interval: 5s
      limit_percentage: 80
      spike_limit_percentage: 25

  exporters:
    prometheus:
      endpoint: "0.0.0.0:8889"
      namespace: agegate
    debug:
      verbosity: basic

  service:
    pipelines:
      metrics:
        receivers: [otlp]
        processors: [memory_limiter, batch]
        exporters: [prometheus, debug]
      traces:
        receivers: [otlp]
        processors: [memory_limiter, batch]
        exporters: [debug]   # Change to otlphttp if Tempo is used
```

### 2.2 Install the Collector

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace agegate \
  --values agegate-verifier/otel-collector-values.yaml
```

### 2.3 (Optional) Add a ServiceMonitor for Prometheus

To have Prometheus automatically scrape the Collector's metrics, create a `ServiceMonitor` resource. You can use the provided template in `agegate-verifier/templates/otel-collector-servicemonitor.yaml` (see next section).

Apply it with:

```bash
kubectl apply -f agegate-verifier/templates/otel-collector-servicemonitor.yaml
```

## 3. (Recommended) Add Tempo for Distributed Tracing

Tempo is a scalable, easy‑to‑operate trace storage backend. It integrates natively with Grafana.

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm upgrade --install tempo grafana/tempo \
  --namespace monitoring \
  --create-namespace
```

After installing Tempo, edit `agegate-verifier/otel-collector-values.yaml` to:

- Add an `otlphttp` exporter pointing to Tempo:

```yaml
exporters:
  otlphttp:
    endpoint: "http://tempo.monitoring:4318"
```

- Change the `traces` pipeline exporter from `logging` to `otlphttp`:

```yaml
service:
  pipelines:
    traces:
      exporters: [otlphttp]
```

Then upgrade the Collector and verify the data source in Grafana:

```bash
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace agegate \
  --values agegate-verifier/otel-collector-values.yaml
```

**In Grafana, add Tempo as a data source:**
1. Go to **Connections** → **Data sources** → **Add new data source**.
2. Search for "Tempo" and select it.
3. Set the **URL** to `http://tempo.monitoring:3200` (if Tempo was installed in the `monitoring` namespace; adjust if needed).
4. Click **Save & test**.
5. To explore traces, go to **Explore** (compass icon), select the Tempo data source, and choose a trace ID or use "Search".

You can then correlate metrics in the Node.js dashboard with traces by clicking on the trace IDs directly from the panels (if configured).

## 4. Import Node.js Dashboard

Follow these steps to import a pre-built Node.js dashboard into Grafana:

1. **Log into Grafana**
   Open your browser and go to `http://<node-ip>:30300` (use the IP of any K3s node).
   Username: `admin`
   Password: retrieve it with the command shown in section 1.

2. **Open the Import dialog** – there are two easy ways:
   - **From the side menu**: Click the **Dashboards icon** (four squares) → then click the **New** button → select **Import**.
   - **Using the + button**: In the top‑right corner, click the **+** (Plus) icon → then click **Import**.

3. **Enter the dashboard ID**
   In the field “Import via grafana.com”, type one of the following IDs:
   - `12230` – Node.js Application (general purpose)
   - `11378` – Node.js Detailed (more metrics)
   Then click the **Load** button.

4. **Select the Prometheus data source**
   On the next screen, under “Prometheus”, choose the data source you configured (usually named `Prometheus` or `prometheus`).

5. **Finish the import**
   Click the **Import** button. The dashboard will appear in your Dashboards list.

You will see metrics such as:
- HTTP request duration
- Event loop lag
- Garbage collection duration
- Memory usage

If you cannot see any data, verify that the OpenTelemetry Collector is running and that the application is sending metrics (check the Troubleshooting section below).

## 5. Environment Variables for the Verifier App

The `agegate-verifier` service reads the following OpenTelemetry variables (already set in `values.yaml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_SERVICE_NAME` | `agegate-verifier` | Service name for traces/metrics |
| `OTEL_TRACES_ENDPOINT` | `http://otel-collector:4318/v1/traces` | OTLP HTTP endpoint for traces |
| `OTEL_METRICS_ENDPOINT` | `http://otel-collector:4318/v1/metrics` | OTLP HTTP endpoint for metrics |

If you change the Collector’s service name or namespace, update these endpoints accordingly.

## Troubleshooting

- **Collector not receiving data**: Check the Collector logs: `kubectl logs -n agegate deployment/otel-collector`.
- **Prometheus cannot scrape metrics**: Verify the ServiceMonitor and that the Collector’s metrics port is correctly labelled. Check that the `extraPorts` section is present.
- **No traces in Grafana**: Ensure the traces pipeline exporter is set to `otlphttp` and that Tempo is reachable.
- **Missing Node.js metrics**: Confirm that the application started with `-r ./tracing.js` and that the Collector’s metrics pipeline is working.

## References

- [OpenTelemetry Node.js SDK](https://opentelemetry.io/docs/languages/js/)
- [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
- [Tempo](https://grafana.com/oss/tempo/)
- [Node.js Dashboard (Grafana)](https://grafana.com/grafana/dashboards/12230)

# Grafana Dashboards and Alerting

## Prerequisites

- The `kube-prometheus-stack` (Prometheus + Grafana) must be installed in the `monitoring` namespace.
- The Age Gate service must be running and exposing metrics.

## Importing the Dashboard

1. Access Grafana (NodePort 30300 or via port-forward).
2. Go to **Dashboards** → **Import**.
3. Upload the JSON file `grafana-dashboard.json` (provided in the repository).
4. Select the Prometheus data source.
5. Click **Import**.

The dashboard will display:
- Verifications per minute per client
- Rate limited requests per client
- Success rate per client
- HTTP error rate (5xx)

## Configuring Alerting Rules

The file `prometheus-rules.yaml` contains alerting rules. To add them to your Prometheus instance (managed by `kube-prometheus-stack`):

```bash
kubectl apply -f prometheus-rules.yaml
```

Alternatively, you can add them via Helm values:

```yaml
# In your kube-prometheus-stack values
additionalPrometheusRulesMap:
  agegate-alerts:
    groups:
      - name: agegate_alerts
        rules:
          - alert: HighRateLimitHits
            expr: rate(agegate_rate_limited_total[5m]) > 10
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High rate limit hits for {{ $labels.client_id }}"
```

## Testing Alerts

You can manually trigger a rate limit by sending many verification requests in a short time. After a few minutes, check the **Alert** tab in Grafana or the Alertmanager UI.

## Customization

- Adjust thresholds (`> 10` in the rate limit alert) according to your needs.
- Add more dashboards for specific clients or time ranges.

For more details, refer to the [Prometheus documentation](https://prometheus.io/docs/alerting/latest/overview/).

# Usage and Integration

## 1. SDK (single line)

```html
<script src='http://agegate.local:30452/sdk/agegate-sdk.js'></script>
```

## 2. Call example

```javascript
AgeGate.verify({
  onSuccess: function(result) { ... },
  threshold: 18
})
```

## 3. API Key

Required header: `x-api-key: agk_xxxxxxxx`

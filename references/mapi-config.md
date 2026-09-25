# Runner configuration

The config is JSON and contains no credentials.

```json
{
  "accessTokenEnv": "OCEANENGINE_ACCESS_TOKEN",
  "steps": [
    {
      "name": "current-unit",
      "operation": "promotion.detail",
      "query": { "local_account_id": 123, "promotion_id": 456 },
      "assertions": [
        { "type": "equals", "path": "data.promotion_id", "expected": 456 }
      ]
    }
  ]
}
```

Each step has:

- `name`: unique result key.
- `operation`: key from `--list-operations`.
- `query`: GET query parameters. Arrays and objects are JSON-encoded.
- `body`: POST JSON body.
- `optional`: when true, a known unsupported result is recorded as `unsupported` instead of failing. Use only for capability probes, never for required writes.
- `assertions`: optional readback assertions.

Assertions:

- `equals`: exact scalar or structural equality.
- `setEquals`: arrays compared after stable normalization and sorting.
- `empty`: value must be an empty array.
- `notEmpty`: value must be non-null and, for arrays/strings, non-empty.

Dot paths support array indexes, for example `data.list.0.promotion_id`.

For mutations, place a fresh official detail step before the POST and a new detail/report step after it. Configure exact assertions on account ID, project/unit name, material IDs, and counts.

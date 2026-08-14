# cURL Examples

Set the API base URL:

```bash
export FOLDER_API_URL=http://localhost:3000
```

Healthcheck:

```bash
curl "$FOLDER_API_URL/health"
```

List templates:

```bash
curl "$FOLDER_API_URL/templates"
```

# HealthPay — Public Directory

This directory contains the static assets served by **Firebase Hosting**. The primary asset is `index.html`, which hosts the interactive API reference for the HealthPay Claims Processing Engine.

---

## Contents

| File | Description |
|------|-------------|
| `index.html` | Interactive API documentation (Swagger UI + embedded OpenAPI 3.0 spec) |
| `file.svg` | Generic file icon (Next.js scaffold asset) |
| `globe.svg` | Globe icon (Next.js scaffold asset) |
| `next.svg` | Next.js wordmark (Next.js scaffold asset) |
| `vercel.svg` | Vercel wordmark (Next.js scaffold asset) |
| `window.svg` | Window icon (Next.js scaffold asset) |

---

## API Documentation (`index.html`)

`index.html` is a self-contained page that renders the full HealthPay REST API reference using **Swagger UI 5.18.2**. It requires no build step — the OpenAPI 3.0.3 specification is embedded directly as a JavaScript object (`const spec = { ... }`) inside a `<script>` tag.

### Viewing locally

Open the file directly in a browser — no server required:

```bash
open public/index.html
# or
npx serve public
```

When deployed, Firebase Hosting serves it at the root URL. All unmatched routes rewrite to `index.html` (SPA mode), so deep-linking to Swagger anchors works correctly.

### Hosted URL

```
https://<firebase-project-id>.web.app/
```

Or via the API Cloud Run URL:

```
https://api-amskhciitq-uc.a.run.app
```

---

## Updating the API Documentation

The OpenAPI spec lives entirely inside `index.html`. To add or update an endpoint:

### 1. Add a path entry

Inside the `paths:` object in the `spec` constant, add a new key for your route:

```javascript
"/api/your-resource": {
  get: {
    tags: ["YourTag"],
    summary: "Short description",
    operationId: "uniqueOperationId",
    responses: {
      200: { description: "Success", content: { "application/json": { schema: { $ref: "#/components/schemas/YourSchema" } } } },
      404: { $ref: "#/components/responses/NotFound" },
      500: { $ref: "#/components/responses/InternalError" },
    },
  },
},
```

### 2. Add a schema (if needed)

Inside `components.schemas`, define your new request/response shape:

```javascript
YourSchema: {
  type: "object",
  required: ["id", "name"],
  properties: {
    id:   { type: "string", example: "RES_001" },
    name: { type: "string", example: "Example Resource" },
  },
},
```

### 3. Add a tag (if introducing a new resource group)

In the top-level `tags` array:

```javascript
{ name: "YourTag", description: "Manage your resources" },
```

### Reusable response references

The spec defines three shared error responses under `components.responses`. Use them with `$ref`:

| Ref | HTTP Status | When to use |
|-----|------------|-------------|
| `#/components/responses/ValidationError` | 400 | Invalid or missing request fields |
| `#/components/responses/NotFound` | 404 | Requested resource does not exist |
| `#/components/responses/InternalError` | 500 | Unexpected server failure |

---

## Firebase Hosting Configuration

Defined in `firebase.json` at the project root:

```json
{
  "hosting": {
    "public": "public",
    "rewrites": [
      { "source": "/api/**", "function": "api", "region": "us-central1" },
      { "source": "**",      "destination": "/index.html" }
    ]
  }
}
```

- **`/api/**`** requests are forwarded to the `api` Cloud Function — they never hit the static file server
- **All other routes** fall through to `index.html` (SPA rewrite)
- Files in this directory are served publicly with no authentication

### Deploy hosting only

```bash
firebase deploy --only hosting
```

This deploys the contents of this directory to the Firebase CDN without touching Cloud Functions or Firestore rules.

---

## Adding New Static Assets

Drop any file into this directory to make it publicly accessible at `/<filename>` after deployment.

```bash
# Example: add a favicon
cp my-icon.png public/favicon.png
firebase deploy --only hosting
# → accessible at https://<project>.web.app/favicon.png
```

Files are served with default Firebase Hosting cache headers. To customise caching or add security headers, add a `headers` block to the `hosting` section in `firebase.json`.

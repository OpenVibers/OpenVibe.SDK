# AI credentials

Use `createCredentialsClient` from `openvibe-sdk/credentials` with a person-authenticated core client to list metadata, add or remove a credential, and run its balance readers. `list()` never returns secret values.

```js
const credentials = createCredentialsClient(client, { baseUrl: 'https://ai.openvibe.network' });
const { credentials: stored } = await credentials.list();
const { credential } = await credentials.add({
  kind: 'session_cookie', provider: 'openai', cookie: process.env.OPENAI_SESSION,
  label: 'OpenAI browser session',
});
const result = await credentials.balance(credential.id);
```

Session cookies are encrypted at rest. They can perform actions available to the signed-in browser account while valid. OpenVibe uses them only for fixed, read-only provider readers: Anthropic Console prepaid credits and current spend at `console.anthropic.com`, and OpenAI credit grants at `api.openai.com/dashboard/billing/credit_grants`. Redirects are refused. Signing out of the provider ends the session. Anthropic credentials require the organization ID as `org_id`.

The API is `GET`, `POST`, and `DELETE /api/v1/me/credentials`, plus `GET /api/v1/me/credentials/:id/balance`.

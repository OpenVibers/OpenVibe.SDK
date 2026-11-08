# Account email addresses

Use `createAccountEmailsClient` with the signed-in person's Network access token. It only reads and changes that person's own list; email addresses are private until the person shares one.

```js
const { createAccountEmailsClient } = require('openvibe-sdk/identity');

const emails = createAccountEmailsClient({
  getToken: () => session.accessToken,
});

const { emails: addresses } = await emails.list();
await emails.add('person@example.com'); // Network sends a single-use verification link
await emails.makePrimary(addresses[1].id); // verified addresses only
await emails.remove(addresses[0].id); // choose a new primary first
```

`verify(id)` asks Network to send the verification link again. Verification links expire after one hour and can be used once. Keep the access token on the person's trusted client or server and do not log it.

Services holding `identity.emails.read` can check one subject and address without receiving an address list:

```js
const { createIdentityClient } = require('openvibe-sdk/identity');
const identity = createIdentityClient(serviceClient);
const verified = await identity.isEmailVerified({ subject: 'usr_…', email: 'person@example.com' });
```

Unknown subjects and addresses both return `false`. Making an address primary or removing one requires a sign-in from the last ten minutes.

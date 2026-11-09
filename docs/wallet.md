# Universal wallet and store

```js
import { createClient, createWalletClient } from 'openvibe-sdk';
const ov = createWalletClient(createClient({ tokenProvider }));
const wallet = await ov.wallet.get();
const { items } = await ov.store.list();
const purchase = await ov.store.buy(items[0].id, {
    currency: 'vibes', idempotency_key: crypto.randomUUID(),
});
const owned = await ov.items.list();
await ov.items.equip({ kind: 'live.hat', slot: 'hat', instance_id: owned.instances[0].id });
// instance_id: null clears a slot.
const checkout = await ov.wallet.topUp({ provider: 'stripe', amount_cents: 1000, idempotency_key: crypto.randomUUID() });
// Or: ov.vibes.buy({ provider: 'stripe', vibes: 100, idempotency_key: crypto.randomUUID() }).
// Navigate checkout.checkout_url in the same tab after checking it is an HTTPS URL.
```

Use a person's Network bearer for wallet, buys and items. All calls omit cookies, even if the core client defaults to including them. Choose providers and amounts from wallet.checkout; the service computes actual prices. Keep the same idempotency_key for retries of one intent, including across a page reload after an uncertain outcome. Never generate a new key to retry a purchase. The client preserves the body's key during automatic network retries and forwards neither a price override nor another subject.

An issuer's service/app client may call ov.store.submit(itemId, {vibes:100,coins:200}) with inventory.store.list. Prices shown here are examples. Staff must review before the listing is visible. Billing remains the payment authority and reads OpenCoins from Network. Enable the companion Billing/Inventory endpoints and pin the companion Contracts capability release before rollout. Browser CSP must permit Billing and Inventory in connect-src.

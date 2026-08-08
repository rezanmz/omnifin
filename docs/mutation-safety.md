# External mutation safety

Omnifin journals acquisition and subtitle mutations before contacting an upstream service. Each
dispatch records connector instance and configuration generations, an encrypted normalized
request, a target lock, and a short reservation lease. The gateway marks a dispatch immediately
before the connector call and sends the dispatch identifier in `X-Omnifin-Operation-Id`.

Reservation leases can be reclaimed only while the journal still proves that no dispatch occurred.
Lease expiry never makes a dispatched operation safe to repeat. Successful and definitive failed
operations release their target locks and replay their terminal API result. Uncertain operations
and their locks have no time-based retention; operator reconciliation is required.

## Servarr acquisition

- Automatic search has no reliable exact-command discovery after a lost response. Post-dispatch
  timeout, disconnect, or malformed receipt is terminal uncertainty and is never redispatched.
- Failed-queue recovery stores the exact queue identifier and event snapshot. A missing item proves
  success. An identical item permits one proof-based retry. A changed or recreated item is
  quarantined, and retry is never based only on a lease.
- Manual release grab has no reliable post-response lookup. Dispatch consumes the private cached
  release target; uncertainty retains its target lock so another key cannot duplicate the grab.

## Bazarr subtitles

Subtitle search remains read-only and does not create journal records. Download has no exact,
installed-result identity proof, so a lost post-dispatch response is terminal uncertainty and is
never automatically sent again. The normalized Bazarr target and candidate token are encrypted in
the journal and never returned by the API.

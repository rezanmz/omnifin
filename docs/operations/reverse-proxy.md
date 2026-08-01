# Reverse proxy runbook

This runbook exposes a single-node Omnifin installation through one maintained TLS reverse proxy.
It keeps the Compose-published web socket on loopback, leaves the gateway private, preserves
same-origin authentication, and allows live event streams to reach the browser without proxy
buffering.

The examples assume:

- public DNS for `omnifin.example.net` points to the reverse proxy;
- Omnifin and the proxy run on the same host, and the proxy can dial the host's loopback socket;
- the release bundle publishes web only on `127.0.0.1:3000`; and
- no CDN, ingress controller, or second proxy sits in front of the selected proxy.

Do not copy the one-hop trust setting into a multi-proxy deployment. Review the
[multi-proxy boundary](#more-than-one-proxy) first.

## Configure the public origin

Set these values in the release `.env` before starting Compose:

```dotenv
OMNIFIN_BASE_URL=https://omnifin.example.net
OMNIFIN_WEB_PORT=3000
OMNIFIN_WEB_TRUST_PROXY_HOPS=1
OMNIFIN_SECURE_COOKIES=true
OMNIFIN_INSECURE_LOOPBACK_PREVIEW=false
```

`OMNIFIN_BASE_URL` is the one externally visible origin. It must not include credentials, a path,
query parameters, or a fragment. Omnifin reconstructs security-sensitive callback and logout URLs
from this configured origin rather than trusting request forwarding headers.

Keep the bundled loopback port mapping unchanged. Do not add a gateway port mapping and do not
change the web mapping to `0.0.0.0` merely to make the proxy work. A proxy on another host requires
an explicitly protected private network path and a separately reviewed bind/firewall design; it is
not the one-host deployment described here.

Start Omnifin and prove the private upstream is healthy before configuring public traffic:

```sh
docker compose --env-file .env --file compose.yaml up --detach --wait
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
```

## Caddy

Caddy is the smallest supported example for a one-hop deployment. A public hostname with working
DNS lets a maintained Caddy installation obtain and renew its certificate automatically:

```caddyfile
omnifin.example.net {
    reverse_proxy 127.0.0.1:3000
}
```

Validate and reload through the mechanism used by the Caddy installation. For example, a native
service commonly uses:

```sh
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy's reverse proxy replaces incoming `X-Forwarded-*` assertions by default and immediately
flushes `text/event-stream` responses. Do not add a broad `trusted_proxies` rule to this one-hop
configuration. If another proxy is placed in front later, trust only that proxy's exact maintained
address ranges and revisit Omnifin's trusted-hop count. See Caddy's official
[reverse proxy header and streaming behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Nginx

Use the certificate and TLS policy managed by the host's maintained Nginx installation. The
Omnifin-specific server block is:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name omnifin.example.net;
    return 308 https://omnifin.example.net$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name omnifin.example.net;

    ssl_certificate     /etc/letsencrypt/live/omnifin.example.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/omnifin.example.net/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              omnifin.example.net;
        proxy_set_header Connection        "";
        proxy_set_header X-Forwarded-Host  omnifin.example.net;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Setting `X-Forwarded-For` to `$remote_addr` is deliberate: it replaces a browser-supplied chain
instead of appending to it. Disabling response buffering keeps Omnifin's server-sent status events
live; Nginx otherwise buffers proxied responses by default. The timeout applies between successive
upstream reads, not to the total response lifetime. See the official Nginx documentation for
[`proxy_set_header`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header),
[`proxy_buffering`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering), and
[`proxy_read_timeout`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout).

Validate and reload without replacing a working configuration:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

## More than one proxy

`OMNIFIN_WEB_TRUST_PROXY_HOPS` is the exact number of maintained proxy hops between the browser and
the Omnifin web process. The bundled one-host topology uses `1`. A CDN followed by Caddy or Nginx
usually creates two hops, but changing the value to `2` is safe only when all of these statements
are true:

1. direct client access to the inner proxy is blocked;
2. the inner proxy trusts forwarded client addresses only from the outer proxy's current explicit
   address ranges;
3. the outer proxy replaces, rather than blindly appends, client-supplied forwarding assertions;
   and
4. the path cannot bypass either reviewed hop.

Do not set an inflated count “just in case.” Omnifin intentionally discards untrusted earlier
entries and selects the address immediately before the configured trusted hops for rate-limit and
audit attribution. A wrong count can collapse unrelated users into one rate-limit group or allow a
caller to influence attribution.

## Verify the public path

Run the checks from a client that reaches the public hostname, not from inside the Compose network:

```sh
curl --fail --silent --show-error https://omnifin.example.net/healthz
curl --fail --silent --show-error --dump-header - --output /dev/null \
  https://omnifin.example.net/login
curl --fail --silent --show-error --dump-header - \
  https://omnifin.example.net/api/auth/providers
```

The health response must be `{"status":"ok"}`. The login response must include HTTPS security
headers such as `Strict-Transport-Security`, `Content-Security-Policy`,
`X-Content-Type-Options: nosniff`, and a restrictive `Referrer-Policy`. Provider discovery must
remain browser-safe and must not expose client secrets, issuer tokens, connector addresses, or raw
upstream responses.

Then complete these browser checks:

1. Open `https://omnifin.example.net/recovery` directly and establish the first administrator.
2. Open **Account & access → Setup guide** and leave it visible long enough to confirm that its live
   connection remains active rather than repeatedly falling back to foreground polling.
3. Sign out, sign in through Jellyfin, and confirm the secure session survives a normal navigation
   and browser refresh.
4. Configure an OIDC provider from **Account & access → Identity providers**. Register only the
   exact callback, post-logout, back-channel, and front-channel URLs shown by Omnifin.
5. Verify provider sign-in, RP-initiated logout, and the provider's selected front- or back-channel
   logout method. The provider must be able to reach the public HTTPS logout endpoint directly.

Do not persist authentication callback query strings in proxy access logs. They can carry a
transient one-time authorization code and state value. If the proxy cannot exclude only that query
string safely, omit query strings from access logs for the Omnifin virtual host.

## Diagnose bounded failure modes

| Symptom                                          | Check                                    | Safe correction                                                                                          |
| ------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Browser loops back to login                      | Public origin, HTTPS, cookie flags       | Make `OMNIFIN_BASE_URL` match the browser origin exactly and keep secure cookies enabled.                |
| OIDC reports redirect mismatch                   | Provider redirect registration           | Copy the exact URLs shown in Identity providers; do not add wildcards or derive them from proxy headers. |
| Mutations fail origin checks                     | Host and scheme forwarded by the proxy   | Preserve the public host and send `X-Forwarded-Proto: https`; do not expose the web port directly.       |
| Setup guide repeatedly enters foreground polling | Proxy response buffering or idle timeout | Keep SSE responses unbuffered and allow an idle interval longer than the configured event heartbeat.     |
| Unrelated users share rate limits                | Trusted-hop count or forwarding chain    | Restore the exact hop count and make each maintained proxy replace untrusted forwarding assertions.      |
| Public health works but media services fail      | Gateway egress or connector policy       | Test one connector from Omnifin's administration UI; do not publish the private gateway as a workaround. |

After the public path passes, continue with the [first-run runbook](../first-run.md) and create a
verified backup before storing irreplaceable configuration.

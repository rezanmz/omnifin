# Support

Omnifin is a community-maintained, pre-release project. Support is best effort and no
response time, fix time, or compatibility SLA is promised.

## Where to ask

- Use [GitHub Discussions](https://github.com/rezanmz/omnifin/discussions) for setup,
  configuration, design ideas, and general questions.
- Use [GitHub Issues](https://github.com/rezanmz/omnifin/issues) for reproducible bugs,
  scoped features, and compatibility regressions.
- Use private vulnerability reporting as described in [SECURITY.md](SECURITY.md) for
  anything that could harm confidentiality, integrity, availability, or authorization.

Do not use a public issue for credentials, OIDC assertions, cookies, private hostnames,
media paths, viewing history, or an unpatched vulnerability.

## Before opening a report

Search existing issues, read the [compatibility matrix](docs/compatibility.md), and
reproduce on a supported release if one exists. Include:

- Omnifin version and image digest or exact source commit;
- deployment method and browser;
- affected upstream service and exact version;
- minimal reproduction steps, expected result, and actual result;
- sanitized logs with timestamps and correlation identifiers; and
- whether the behavior survives a clean restart or isolated test instance.

Screenshots should be cropped or redacted to remove names, artwork, media titles,
hostnames, paths, tokens, and other private information unless each item is necessary
and safe to share.

## Scope

The project can help with Omnifin behavior and documented integrations. General
Docker, reverse-proxy, DNS, certificate, OIDC-provider, operating-system, and upstream
service administration may be redirected to the relevant project's support channels.

Unsupported upstream versions and local patches are welcome as compatibility reports,
but may require a reproducible fixture or contributor help before they can be fixed.

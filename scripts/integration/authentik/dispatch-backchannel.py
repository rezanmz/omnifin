from os import environ

from authentik.providers.oauth2.models import AccessToken
from authentik.providers.oauth2.tasks import backchannel_logout_notification_dispatch


tokens = list(
    AccessToken.objects.select_related("provider", "session__session")
    .filter(
        provider__client_id=environ["OMNIFIN_AUTHENTIK_CLIENT_ID"],
        revoked=False,
        user__username="akadmin",
    )
    .order_by("pk")[:2]
)
if len(tokens) != 1 or tokens[0].session is None:
    raise RuntimeError("fixture_access_token_unavailable")

access_token = tokens[0]
backchannel_logout_notification_dispatch.send(
    revocations=[
        (
            access_token.provider_id,
            access_token.id_token.iss,
            access_token.id_token.sub,
            access_token.session.session.session_key,
        )
    ]
)
print('{"event":"authentik_backchannel_queued"}')

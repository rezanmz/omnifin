from os import environ

from authentik.lib.utils.http import get_http_session
from authentik.providers.oauth2.models import AccessToken, OAuth2LogoutMethod
from authentik.providers.oauth2.utils import create_logout_token


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
provider = access_token.provider
if provider.logout_method != OAuth2LogoutMethod.BACKCHANNEL or not provider.logout_uri:
    raise RuntimeError("fixture_backchannel_provider_invalid")

logout_token = create_logout_token(
    provider,
    access_token.id_token.iss,
    access_token.id_token.sub,
    access_token.session.session.session_key,
)
response = get_http_session().post(
    provider.logout_uri,
    data={"logout_token": logout_token},
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    allow_redirects=True,
    verify=environ["REQUESTS_CA_BUNDLE"],
)
response.raise_for_status()
print('{"event":"authentik_backchannel_delivered"}')

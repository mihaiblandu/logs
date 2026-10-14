"""Validates the HS256 tokens issued by the Laravel app (shared secret, issuer, audience)."""
import os

import jwt

SECRET = os.environ.get("JWT_SECRET", "dev-only-shared-secret-change-me-0123456789abcdef")


def verify_bearer(header: str | None) -> tuple[str | None, dict | None, str | None]:
    """Returns (token, claims, error)."""
    if not header or not header.startswith("Bearer "):
        return None, None, "missing token"
    token = header[7:]
    try:
        claims = jwt.decode(token, SECRET, algorithms=["HS256"], issuer="laravel-otel", audience="otel-demo",
                            leeway=30, options={"require": ["exp", "sub"]})
        return token, claims, None
    except jwt.PyJWTError as e:
        return token, None, str(e)

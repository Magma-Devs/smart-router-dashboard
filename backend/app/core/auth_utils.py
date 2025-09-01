from base64 import b64decode, b64encode
from typing import Tuple

BASIC_PREFIX = "Basic "


def build_basic_credentials(username: str, password: str) -> str:
    token = b64encode(f"{username}:{password}".encode()).decode()
    return f"{BASIC_PREFIX}{token}"


def parse_basic_credentials(auth_header: str) -> Tuple[str, str]:
    if not auth_header or not auth_header.startswith(BASIC_PREFIX):
        raise ValueError("Missing or invalid Authorization header")
    try:
        token = auth_header[len(BASIC_PREFIX) :]
        decoded = b64decode(token).decode()
        username, password = decoded.split(":", 1)
        if not username or not password:
            raise ValueError("Empty username or password")
        return username, password
    except Exception as exc:
        raise ValueError("Malformed Basic token") from exc


def verify_credentials(
    username: str, password: str, expected_user: str, expected_pass: str
) -> bool:
    import secrets

    return secrets.compare_digest(username, expected_user) and secrets.compare_digest(
        password, expected_pass
    )

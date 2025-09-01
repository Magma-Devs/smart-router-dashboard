import base64
import sys
import types

# Stub kubernetes service to avoid external helm/kubectl during tests
fake_k8s = types.ModuleType("app.services.kubernetes")


class _Dummy:
    pass


fake_k8s.KubernetesService = lambda *args, **kwargs: _Dummy()
fake_k8s.kubernetes_service = _Dummy()
sys.modules["app.services.kubernetes"] = fake_k8s

from fastapi.testclient import TestClient

from app.main import app
from app.core.config import settings

client = TestClient(app)


def _basic_header(u: str, p: str) -> dict:
    token = base64.b64encode(f"{u}:{p}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def test_auth_status_public():
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    data = r.json()
    assert data["authentication_required"] is True


def test_login_success():
    r = client.post(
        "/api/auth/login",
        json={
            "username": settings.AUTH_USERNAME,
            "password": settings.AUTH_PASSWORD,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "authenticated"
    assert data["username"] == settings.AUTH_USERNAME
    assert isinstance(data["credentials"], str) and len(data["credentials"]) > 0


def test_login_failure():
    r = client.post(
        "/api/auth/login",
        json={
            "username": "wrong",
            "password": "creds",
        },
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "Incorrect username or password"


def test_me_requires_auth():
    r = client.get("/api/auth/me")
    assert r.status_code == 401


def test_me_success():
    r = client.get(
        "/api/auth/me",
        headers=_basic_header(settings.AUTH_USERNAME, settings.AUTH_PASSWORD),
    )
    assert r.status_code == 200
    assert r.json()["username"] == settings.AUTH_USERNAME


def test_me_bad_credentials():
    r = client.get("/api/auth/me", headers=_basic_header("bad", "creds"))
    assert r.status_code == 401
    assert r.json()["detail"] in {"Invalid credentials", "Invalid authorization header"}


def test_logout_success():
    r = client.post(
        "/api/auth/logout",
        headers=_basic_header(settings.AUTH_USERNAME, settings.AUTH_PASSWORD),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "logged_out"

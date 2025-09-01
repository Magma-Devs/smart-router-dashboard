import pytest

from app.core import auth_utils


def test_build_and_parse_round_trip():
    header = auth_utils.build_basic_credentials("admin", "password")
    username, password = auth_utils.parse_basic_credentials(header)
    assert username == "admin"
    assert password == "password"


def test_parse_basic_credentials_invalid_prefix():
    with pytest.raises(ValueError):
        auth_utils.parse_basic_credentials("Bearer token")


def test_parse_basic_credentials_malformed_token():
    with pytest.raises(ValueError):
        # not base64
        auth_utils.parse_basic_credentials("Basic notbase64!!")


def test_parse_basic_credentials_empty_parts():
    token = auth_utils.build_basic_credentials("", "")
    with pytest.raises(ValueError):
        auth_utils.parse_basic_credentials(token)


def test_verify_credentials_success():
    assert auth_utils.verify_credentials("a", "b", "a", "b") is True


def test_verify_credentials_fail_user():
    assert auth_utils.verify_credentials("x", "b", "a", "b") is False


def test_verify_credentials_fail_pass():
    assert auth_utils.verify_credentials("a", "x", "a", "b") is False

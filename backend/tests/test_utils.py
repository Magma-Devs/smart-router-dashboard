"""
Tests for utility functions in app.core.utils.
"""

import pytest

from app.core.utils import (
    convert_cpu_to_cores,
    convert_memory_to_gb,
    extract_provider_name_from_url,
    get_base_provider_name,
    get_endpoint_key_for_grouping,
    get_provider_key_from_endpoint,
    remove_duplicate_addons,
)


class TestConvertMemoryToGB:
    """Test memory conversion utility function."""

    def test_convert_memory_to_gb_gigabytes(self):
        """Test conversion from GiB to GB."""
        assert convert_memory_to_gb("0.5Gi") == 0.5
        assert convert_memory_to_gb("1Gi") == 1.0
        assert convert_memory_to_gb("2.5Gi") == 2.5

    def test_convert_memory_to_gb_megabytes(self):
        """Test conversion from MiB to GB."""
        assert convert_memory_to_gb("1024Mi") == 1.0
        assert convert_memory_to_gb("500Mi") == 500 / 1024
        assert convert_memory_to_gb("2048Mi") == 2.0

    def test_convert_memory_to_gb_kilobytes(self):
        """Test conversion from KiB to GB."""
        assert convert_memory_to_gb("1048576Ki") == 1.0  # 1024^2 KiB = 1 GiB
        assert convert_memory_to_gb("1024Ki") == 1024 / (1024 * 1024)

    def test_convert_memory_to_gb_bytes(self):
        """Test conversion from bytes to GB."""
        assert convert_memory_to_gb("1073741824") == 1.0  # 1024^3 bytes = 1 GiB
        assert convert_memory_to_gb("536870912") == 0.5  # 0.5 GiB in bytes

    def test_convert_memory_to_gb_edge_cases(self):
        """Test edge cases for memory conversion."""
        assert convert_memory_to_gb("") == 0.0
        assert convert_memory_to_gb(None) == 0.0
        assert convert_memory_to_gb("0Gi") == 0.0
        assert convert_memory_to_gb("0Mi") == 0.0

    def test_convert_memory_to_gb_case_insensitive(self):
        """Test that memory conversion is case insensitive."""
        assert convert_memory_to_gb("1GI") == 1.0
        assert convert_memory_to_gb("1MI") == 1 / 1024
        assert convert_memory_to_gb("1KI") == 1 / (1024 * 1024)


class TestConvertCPUToCores:
    """Test CPU conversion utility function."""

    def test_convert_cpu_to_cores_millicores(self):
        """Test conversion from millicores to cores."""
        assert convert_cpu_to_cores("500m") == 0.5
        assert convert_cpu_to_cores("1000m") == 1.0
        assert convert_cpu_to_cores("250m") == 0.25
        assert convert_cpu_to_cores("1500m") == 1.5

    def test_convert_cpu_to_cores_decimal(self):
        """Test conversion from decimal to cores."""
        assert convert_cpu_to_cores("0.5") == 0.5
        assert convert_cpu_to_cores("1.0") == 1.0
        assert convert_cpu_to_cores("2.5") == 2.5
        assert convert_cpu_to_cores("0.25") == 0.25

    def test_convert_cpu_to_cores_edge_cases(self):
        """Test edge cases for CPU conversion."""
        assert convert_cpu_to_cores("") == 0.0
        assert convert_cpu_to_cores(None) == 0.0
        assert convert_cpu_to_cores("0m") == 0.0
        assert convert_cpu_to_cores("0") == 0.0

    def test_convert_cpu_to_cores_case_insensitive(self):
        """Test that CPU conversion is case insensitive."""
        assert convert_cpu_to_cores("500M") == 0.5
        assert convert_cpu_to_cores("1000M") == 1.0


class TestExtractProviderNameFromURL:
    """Test provider name extraction utility function."""

    def test_extract_provider_name_from_url(self):
        """Test extraction of provider name from various URL formats."""
        assert (
            extract_provider_name_from_url("https://lava-provider.lava.lavapro.xyz")
            == "lava"
        )
        assert (
            extract_provider_name_from_url("https://test-provider.example.com")
            == "test"
        )
        assert extract_provider_name_from_url("http://my-provider.local") == "my"

    def test_extract_provider_name_from_url_no_provider_suffix(self):
        """Test extraction when URL doesn't have '-provider' suffix."""
        assert extract_provider_name_from_url("https://lava.lava.lavapro.xyz") == "lava"
        assert extract_provider_name_from_url("https://test.example.com") == "test"

    def test_extract_provider_name_from_url_edge_cases(self):
        """Test edge cases for provider name extraction."""
        assert extract_provider_name_from_url("") == ""
        assert extract_provider_name_from_url(None) == ""
        assert extract_provider_name_from_url("https://.example.com") == ""
        assert (
            extract_provider_name_from_url("https://provider.example.com") == "provider"
        )


class TestRemoveDuplicateAddons:
    """Test addon deduplication utility function."""

    def test_remove_duplicate_addons(self):
        """Test removal of duplicate addons."""
        result = remove_duplicate_addons(["a", "b", "a", "c"])
        assert set(result) == {"a", "b", "c"}
        assert len(result) == 3

        result = remove_duplicate_addons(["x", "y", "z"])
        assert set(result) == {"x", "y", "z"}
        assert len(result) == 3

        result = remove_duplicate_addons(["a", "a", "a"])
        assert set(result) == {"a"}
        assert len(result) == 1

    def test_remove_duplicate_addons_empty_list(self):
        """Test handling of empty list."""
        assert remove_duplicate_addons([]) == []

    def test_remove_duplicate_addons_single_item(self):
        """Test handling of single item list."""
        assert remove_duplicate_addons(["single"]) == ["single"]

    def test_remove_duplicate_addons_removes_duplicates(self):
        """Test that duplicates are removed correctly."""
        result = remove_duplicate_addons(["b", "a", "b", "c", "a"])
        assert set(result) == {"a", "b", "c"}
        assert len(result) == 3


class TestGetBaseProviderName:
    """Test base provider name extraction utility function."""

    def test_get_base_provider_name_with_numeric_suffix(self):
        """Test extraction of base name by removing numeric suffixes."""
        assert get_base_provider_name("quicknode1") == "quicknode"
        assert get_base_provider_name("chainstack2") == "chainstack"
        assert get_base_provider_name("helius123") == "helius"
        assert get_base_provider_name("provider99") == "provider"

    def test_get_base_provider_name_without_suffix(self):
        """Test that names without numeric suffix remain unchanged."""
        assert get_base_provider_name("quicknode") == "quicknode"
        assert get_base_provider_name("chainstack") == "chainstack"
        assert get_base_provider_name("helius") == "helius"

    def test_get_base_provider_name_edge_cases(self):
        """Test edge cases for base provider name extraction."""
        assert get_base_provider_name("") == ""
        assert get_base_provider_name("123") == ""
        assert get_base_provider_name("a1b2") == "a1b"  # Only removes trailing numbers
        assert get_base_provider_name("provider0") == "provider"


class TestGetProviderKeyFromEndpoint:
    """Test provider key generation from endpoint URL."""

    def test_get_provider_key_from_endpoint_hashes_url(self):
        """Test that endpoint URL is hashed and not exposed."""
        key1 = get_provider_key_from_endpoint("solana", "https://example.com/rpc")
        key2 = get_provider_key_from_endpoint("solana", "https://example.com/rpc")

        # Same URL should produce same hash
        assert key1 == key2
        # Should start with chain_id
        assert key1.startswith("solana-")
        # Should not contain the actual URL
        assert "example.com" not in key1
        # Hash should be 8 characters
        assert len(key1.split("-")[1]) == 8

    def test_get_provider_key_from_endpoint_different_urls(self):
        """Test that different URLs produce different hashes."""
        key1 = get_provider_key_from_endpoint("solana", "https://example.com/rpc1")
        key2 = get_provider_key_from_endpoint("solana", "https://example.com/rpc2")

        assert key1 != key2
        assert key1.startswith("solana-")
        assert key2.startswith("solana-")

    def test_get_provider_key_from_endpoint_case_insensitive(self):
        """Test that keys are lowercase."""
        key1 = get_provider_key_from_endpoint("SOLANA", "https://Example.com/RPC")
        key2 = get_provider_key_from_endpoint("solana", "https://example.com/rpc")

        # Chain ID is lowercased, but URL hash should be different due to case
        assert key1.startswith("solana-")
        # Different case URLs produce different hashes
        assert key1 != key2


class TestGetEndpointKeyForGrouping:
    """Test endpoint key generation for internal grouping."""

    def test_get_endpoint_key_for_grouping_includes_full_url(self):
        """Test that grouping key includes full URL for accurate grouping."""
        key = get_endpoint_key_for_grouping("solana", "https://example.com/rpc")

        assert key == "solana-https://example.com/rpc"
        assert "example.com" in key

    def test_get_endpoint_key_for_grouping_case_insensitive(self):
        """Test that grouping key is lowercase."""
        key = get_endpoint_key_for_grouping("SOLANA", "https://Example.com/RPC")

        assert key == "solana-https://example.com/rpc"

    def test_get_endpoint_key_for_grouping_same_url_same_key(self):
        """Test that same URL produces same key."""
        key1 = get_endpoint_key_for_grouping("solana", "https://example.com/rpc")
        key2 = get_endpoint_key_for_grouping("solana", "https://example.com/rpc")

        assert key1 == key2

    def test_get_endpoint_key_for_grouping_different_chains(self):
        """Test that different chains produce different keys."""
        key1 = get_endpoint_key_for_grouping("solana", "https://example.com/rpc")
        key2 = get_endpoint_key_for_grouping("ethereum", "https://example.com/rpc")

        assert key1 != key2
        assert key1.startswith("solana-")
        assert key2.startswith("ethereum-")

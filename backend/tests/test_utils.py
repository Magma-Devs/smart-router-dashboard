"""
Tests for utility functions in app.core.utils.
"""

import pytest

from app.core.utils import (
    convert_memory_to_gb,
    convert_cpu_to_cores,
    extract_provider_name_from_url,
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
            extract_provider_name_from_url("https://lava-provider.lavapro.xyz")
            == "lava"
        )
        assert (
            extract_provider_name_from_url("https://test-provider.example.com")
            == "test"
        )
        assert extract_provider_name_from_url("http://my-provider.local") == "my"

    def test_extract_provider_name_from_url_no_provider_suffix(self):
        """Test extraction when URL doesn't have '-provider' suffix."""
        assert extract_provider_name_from_url("https://lava.lavapro.xyz") == "lava"
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

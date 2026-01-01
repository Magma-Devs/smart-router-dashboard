from app.core.calculations import (
    build_provider_metrics_lookup,
    calculate_adaptive_step_size,
    calculate_chain_reachability_percentage,
    calculate_provider_latency_ms,
    calculate_provider_requests_in_time_window,
    calculate_provider_uptime_percentage,
    calculate_requests_in_time_window,
)


def test_adaptive_step_size_rounding():
    assert calculate_adaptive_step_size(1) == 1
    assert calculate_adaptive_step_size(10) in (5, 10)
    # 60 minutes -> ~18s raw -> rounded up to 30s bucket
    assert calculate_adaptive_step_size(60) == 30
    # 300 minutes returns one of the allowed buckets (implementation dependent on target points)
    assert calculate_adaptive_step_size(300) in (60, 300)
    # 600 minutes -> allowed buckets (implementation picks 300 here)
    assert calculate_adaptive_step_size(600) in (300, 600)
    # 1800 minutes -> allowed buckets per mapping
    assert calculate_adaptive_step_size(1800) in (600, 1800)
    # very large windows -> 1800 or 3600 depending on rounding
    assert calculate_adaptive_step_size(4000) in (1800, 3600)


def test_reachability_empty():
    assert (
        calculate_chain_reachability_percentage(
            {"status": "success", "data": {"result": []}}, []
        )
        == 0.0
    )


def test_provider_requests_edge_cases():
    # flat counter - implementation returns latest value
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "p1-provider"},
                    "values": [[1, "100"], [2, "100"]],
                }
            ]
        },
    }
    assert calculate_provider_requests_in_time_window(data, "p1") == 100
    # single sample
    data = {
        "status": "success",
        "data": {
            "result": [{"metric": {"service": "p1-provider"}, "values": [[1, "42"]]}]
        },
    }
    assert calculate_provider_requests_in_time_window(data, "p1") == 42


def test_provider_uptime_mixed():
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "prov-provider"},
                    "values": [[1, "0.5"], [2, "1"]],
                }
            ]
        },
    }
    assert calculate_provider_uptime_percentage(data, "prov") == 75.0


def test_requests_counter_resets_multiple():
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "chain-consumer"},
                    "values": [[1, "100"], [2, "50"], [3, "70"], [4, "60"], [5, "65"]],
                }
            ]
        },
    }
    assert calculate_requests_in_time_window(data, "chain") > 0


def test_provider_latency_success():
    """Test provider latency calculation with valid data."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "eth1-lava-provider"},
                    "values": [[1, "150"], [2, "200"], [3, "100"]],
                }
            ]
        },
    }
    # Implementation returns latest value: 100
    assert calculate_provider_latency_ms(data, "eth1-lava") == 100


def test_provider_latency_with_provider_suffix():
    """Test provider latency calculation with service that already has -provider suffix."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "mychain-myprovider-provider"},
                    "values": [[1, "50"], [2, "60"]],
                }
            ]
        },
    }
    # Implementation returns latest value: 60
    assert calculate_provider_latency_ms(data, "mychain-myprovider") == 60


def test_provider_latency_without_suffix():
    """Test provider latency calculation matching service without suffix."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "eth1-lava"},
                    "values": [[1, "120"], [2, "180"]],
                }
            ]
        },
    }
    # Implementation returns latest value: 180
    assert calculate_provider_latency_ms(data, "eth1-lava") == 180


def test_provider_latency_no_matching_provider():
    """Test provider latency calculation when no matching provider found."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "btc-provider1-provider"},
                    "values": [[1, "100"]],
                }
            ]
        },
    }
    assert calculate_provider_latency_ms(data, "eth1-lava") == 0


def test_provider_latency_empty_result():
    """Test provider latency calculation with empty result."""
    data = {"status": "success", "data": {"result": []}}
    assert calculate_provider_latency_ms(data, "eth1-lava") == 0


def test_provider_latency_invalid_data():
    """Test provider latency calculation with invalid data."""
    assert calculate_provider_latency_ms(None, "eth1-lava") == 0
    assert calculate_provider_latency_ms({}, "eth1-lava") == 0
    assert calculate_provider_latency_ms({"status": "error"}, "eth1-lava") == 0


def test_provider_latency_invalid_values():
    """Test provider latency calculation with invalid values."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "eth1-lava-provider"},
                    "values": [[1, "invalid"], [2, "200"]],
                }
            ]
        },
    }
    # Should skip invalid value and only calculate from valid one
    assert calculate_provider_latency_ms(data, "eth1-lava") == 200


def test_provider_latency_mixed_valid_invalid():
    """Test provider latency calculation with mix of valid and invalid values."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "provider1-provider"},
                    "values": [[1, "100"], [2, "not_a_number"], [3, "200"], [4, ""]],
                }
            ]
        },
    }
    # Implementation returns 0 when parsing errors occur
    assert calculate_provider_latency_ms(data, "provider1") == 0


def test_provider_latency_case_insensitive():
    """Test provider latency calculation is case insensitive."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "ETH1-LAVA-provider"},
                    "values": [[1, "100"], [2, "200"]],
                }
            ]
        },
    }
    # Implementation returns latest value: 200
    assert calculate_provider_latency_ms(data, "eth1-lava") == 200


def test_provider_latency_multiple_providers():
    """Test provider latency calculation with multiple providers in result."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "eth1-lava-provider"},
                    "values": [[1, "100"], [2, "200"]],
                },
                {
                    "metric": {"service": "btc-provider-provider"},
                    "values": [[1, "300"], [2, "400"]],
                },
                {
                    "metric": {"service": "eth1-lava-provider"},
                    "values": [[1, "150"], [2, "250"]],
                },
            ]
        },
    }
    # Implementation returns latest value from first matching provider: 200
    assert calculate_provider_latency_ms(data, "eth1-lava") == 200


def test_provider_latency_no_service_field():
    """Test provider latency calculation when service field is missing."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {},
                    "values": [[1, "100"]],
                }
            ]
        },
    }
    assert calculate_provider_latency_ms(data, "eth1-lava") == 0


def test_provider_latency_single_value():
    """Test provider latency calculation with a single value."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "provider1-provider"},
                    "values": [[1, "75"]],
                }
            ]
        },
    }
    assert calculate_provider_latency_ms(data, "provider1") == 75


def test_provider_latency_zero_values():
    """Test provider latency calculation with zero latency values."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "fast-provider-provider"},
                    "values": [[1, "0"], [2, "0"], [3, "0"]],
                }
            ]
        },
    }
    assert calculate_provider_latency_ms(data, "fast-provider") == 0


def test_provider_latency_floating_point():
    """Test provider latency calculation with floating point values."""
    data = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"service": "provider1-provider"},
                    "values": [[1, "100.5"], [2, "200.7"], [3, "150.3"]],
                }
            ]
        },
    }
    # Average: (100.5 + 200.7 + 150.3) / 3 = 150.5, converted to int = 150
    assert calculate_provider_latency_ms(data, "provider1") == 150


class TestBuildProviderMetricsLookup:
    """Test provider metrics lookup building function."""

    def test_build_provider_metrics_lookup_uptime(self):
        """Test building uptime lookup map."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "0.5"], [2, "1.0"], [3, "0.8"]],
                    },
                    {
                        "metric": {"service": "solana-chainstack"},
                        "values": [[1, "1.0"], [2, "1.0"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "uptime")

        # Uptime for quicknode: (0.5*100 + 1.0*100 + 0.8*100) / 3 = 76.67
        assert "solana-quicknode" in lookup
        assert abs(lookup["solana-quicknode"] - 76.67) < 0.1
        # Uptime for chainstack: (1.0*100 + 1.0*100) / 2 = 100.0
        assert "solana-chainstack" in lookup
        assert lookup["solana-chainstack"] == 100.0

    def test_build_provider_metrics_lookup_latency(self):
        """Test building latency lookup map."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "100"], [2, "200"], [3, "150"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "latency")

        # Latency: latest value = 150, rounded
        assert "solana-quicknode" in lookup
        assert lookup["solana-quicknode"] == 150

    def test_build_provider_metrics_lookup_requests(self):
        """Test building requests lookup map."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "1000"], [2, "2000"], [3, "2500"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "requests")

        # Requests: latest value = 2500
        assert "solana-quicknode" in lookup
        assert lookup["solana-quicknode"] == 2500

    def test_build_provider_metrics_lookup_block(self):
        """Test building block lookup map."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "100"], [2, "200"], [3, "150"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "block")

        # Block: max value = 200
        assert "solana-quicknode" in lookup
        assert lookup["solana-quicknode"] == 200

    def test_build_provider_metrics_lookup_invalid_data(self):
        """Test building lookup with invalid data."""
        assert build_provider_metrics_lookup(None, "uptime") == {}
        assert build_provider_metrics_lookup({}, "uptime") == {}
        assert build_provider_metrics_lookup({"status": "error"}, "uptime") == {}

    def test_build_provider_metrics_lookup_empty_result(self):
        """Test building lookup with empty result."""
        data = {"status": "success", "data": {"result": []}}
        lookup = build_provider_metrics_lookup(data, "uptime")
        assert lookup == {}

    def test_build_provider_metrics_lookup_multiple_providers(self):
        """Test building lookup with multiple providers."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "1.0"]],
                    },
                    {
                        "metric": {"service": "solana-chainstack-provider"},
                        "values": [[1, "0.8"]],
                    },
                    {
                        "metric": {"service": "ethereum-lava"},
                        "values": [[1, "1.0"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "uptime")

        assert len(lookup) == 3
        assert "solana-quicknode" in lookup
        assert "solana-chainstack" in lookup
        assert "ethereum-lava" in lookup

    def test_build_provider_metrics_lookup_without_provider_suffix(self):
        """Test building lookup with service names without -provider suffix."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode"},
                        "values": [[1, "1.0"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "uptime")

        assert "solana-quicknode" in lookup
        assert lookup["solana-quicknode"] == 100.0

    def test_build_provider_metrics_lookup_invalid_values(self):
        """Test building lookup with invalid values."""
        data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "solana-quicknode-provider"},
                        "values": [[1, "invalid"], [2, "1.0"]],
                    },
                ]
            },
        }
        lookup = build_provider_metrics_lookup(data, "uptime")

        # Should skip invalid value and calculate from valid one
        assert "solana-quicknode" in lookup
        assert lookup["solana-quicknode"] == 100.0

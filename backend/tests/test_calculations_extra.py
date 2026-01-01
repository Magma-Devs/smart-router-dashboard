from app.core.calculations import (
    build_provider_metrics_lookup,
    calculate_adaptive_step_size,
    calculate_chain_reachability_percentage,
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
    """Test provider requests using build_provider_metrics_lookup."""
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
    lookup = build_provider_metrics_lookup(data, "requests")
    assert lookup.get("p1", 0) == 100
    # single sample
    data = {
        "status": "success",
        "data": {
            "result": [{"metric": {"service": "p1-provider"}, "values": [[1, "42"]]}]
        },
    }
    lookup = build_provider_metrics_lookup(data, "requests")
    assert lookup.get("p1", 0) == 42


def test_provider_uptime_mixed():
    """Test provider uptime using build_provider_metrics_lookup."""
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
    lookup = build_provider_metrics_lookup(data, "uptime")
    # Uptime: (0.5*100 + 1.0*100) / 2 = 75.0
    assert abs(lookup.get("prov", 0.0) - 75.0) < 0.1


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
    """Test provider latency using build_provider_metrics_lookup."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    # Returns latest value: 100
    assert lookup.get("eth1-lava", 0) == 100


def test_provider_latency_with_provider_suffix():
    """Test provider latency with service that has -provider suffix."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("mychain-myprovider", 0) == 60


def test_provider_latency_without_suffix():
    """Test provider latency matching service without suffix."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("eth1-lava", 0) == 180


def test_provider_latency_no_matching_provider():
    """Test provider latency when no matching provider found."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("eth1-lava", 0) == 0


def test_provider_latency_empty_result():
    """Test provider latency with empty result."""
    data = {"status": "success", "data": {"result": []}}
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("eth1-lava", 0) == 0


def test_provider_latency_invalid_data():
    """Test provider latency with invalid data."""
    assert build_provider_metrics_lookup(None, "latency") == {}
    assert build_provider_metrics_lookup({}, "latency") == {}
    assert build_provider_metrics_lookup({"status": "error"}, "latency") == {}


def test_provider_latency_invalid_values():
    """Test provider latency with invalid values."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    # Should skip invalid value and use valid one
    assert lookup.get("eth1-lava", 0) == 200


def test_provider_latency_case_insensitive():
    """Test provider latency is case insensitive."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("eth1-lava", 0) == 200


def test_provider_latency_multiple_providers():
    """Test provider latency with multiple providers in result."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    # Returns latest value from matching provider: 250 (from second result)
    assert lookup.get("eth1-lava", 0) == 250


def test_provider_latency_no_service_field():
    """Test provider latency when service field is missing."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("eth1-lava", 0) == 0


def test_provider_latency_single_value():
    """Test provider latency with a single value."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("provider1", 0) == 75


def test_provider_latency_zero_values():
    """Test provider latency with zero latency values."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    assert lookup.get("fast-provider", 0) == 0


def test_provider_latency_floating_point():
    """Test provider latency with floating point values."""
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
    lookup = build_provider_metrics_lookup(data, "latency")
    # Returns latest value rounded: 150
    assert lookup.get("provider1", 0) == 150


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

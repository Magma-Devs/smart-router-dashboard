from app.core.calculations import (
    calculate_adaptive_step_size,
    calculate_chain_reachability_percentage,
    calculate_requests_in_time_window,
    calculate_provider_requests_in_time_window,
    calculate_provider_uptime_percentage,
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
    # flat counter
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
    assert calculate_provider_requests_in_time_window(data, "p1") == 0
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

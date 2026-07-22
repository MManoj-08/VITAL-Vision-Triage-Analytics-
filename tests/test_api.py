"""
Unit tests for VITAL Flask API routes and clinical database interface endpoints.
"""

import json
import pytest
import web


@pytest.fixture
def client():
    """Create Flask test client for API endpoint testing."""
    web.app.config['TESTING'] = True
    with web.app.test_client() as test_client:
        yield test_client


def test_status_endpoint(client):
    """Verify /status endpoint returns valid session metrics structure."""
    response = client.get('/status')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, dict)
    assert 'status' in data
    assert 'bpm' in data
    assert 'hrv' in data
    assert 'stress_index' in data


def test_session_summary_endpoint(client):
    """Verify /session_summary endpoint handles empty/initial state gracefully."""
    response = client.get('/session_summary')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, dict)
    assert 'avg_bpm' in data
    assert 'rr' in data


def test_api_cameras_endpoint(client):
    """Verify /api/cameras returns list of available video sources."""
    response = client.get('/api/cameras')
    assert response.status_code == 200
    data = response.get_json()
    assert 'cameras' in data
    assert isinstance(data['cameras'], list)


def test_triage_queue_get_endpoint(client):
    """Verify /api/triage_queue GET returns valid array of records."""
    response = client.get('/api/triage_queue')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, list)

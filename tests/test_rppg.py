"""
Unit tests for VITAL rPPG signal processing engine and Signal Quality Index (SQI) sub-scores.
"""

import numpy as np
import pytest
from core.rppg import (
    Algorithm,
    _guard_width,
    _safe_butter_sos,
    _sqi_kurtosis,
    _sqi_entropy,
    _sqi_zcr,
    _sqi_autocorr,
    _BP_LOW_FLOOR,
    _BP_HIGH_CEIL,
    _BP_MIN_WIDTH,
)


def test_algorithm_enum():
    """Verify supported rPPG algorithm identifiers."""
    assert Algorithm.CHROM.value == "CHROM"
    assert Algorithm.POS.value == "POS"


def test_guard_width_adaptive_snr():
    """Verify guard band width scales with signal-to-noise ratio."""
    high_snr_guard = _guard_width(18.0)
    mid_snr_guard  = _guard_width(10.0)
    low_snr_guard  = _guard_width(5.0)

    assert high_snr_guard < mid_snr_guard < low_snr_guard
    assert high_snr_guard == 0.20
    assert mid_snr_guard == 0.35
    assert low_snr_guard == 0.55


def test_safe_butter_sos_valid():
    """Test Butterworth bandpass SOS filter construction under valid parameters."""
    sos = _safe_butter_sos(low=0.8, high=2.5, fs=30.0, order=4)
    assert sos is not None
    assert sos.shape == (2, 6)  # 4th order = 2 second-order sections


def test_safe_butter_sos_narrow_band_expansion():
    """Test filter bounds safety when low and high are too close."""
    sos = _safe_butter_sos(low=1.0, high=1.05, fs=30.0, order=4)
    assert sos is not None


def test_sqi_kurtosis_flat_vs_peaked():
    """Verify kurtosis SQI distinguishes noise/flat signals from sharp systolic peaks."""
    flat_signal = np.zeros(100)
    score_flat = _sqi_kurtosis(flat_signal)
    assert score_flat == 0.0

    # Sine wave representing clean physiological pulse
    t = np.linspace(0, 4 * np.pi, 200)
    sine_ppg = np.sin(t) + 0.5 * np.sin(2 * t)
    score_sine = _sqi_kurtosis(sine_ppg)
    assert score_sine > 0.0


def test_sqi_entropy():
    """Test inverted Shannon entropy SQI for periodic signals."""
    t = np.linspace(0, 10, 300)
    periodic_signal = np.sin(2 * np.pi * 1.2 * t)
    entropy_score = _sqi_entropy(periodic_signal)
    assert 0.0 <= entropy_score <= 100.0


def test_sqi_zcr():
    """Test Zero-Crossing Rate score against expected BPM."""
    fps = 30.0
    bpm = 72.0  # 1.2 Hz -> ~2.4 crossings/sec
    t = np.linspace(0, 5, int(5 * fps))
    ppg = np.sin(2 * np.pi * 1.2 * t)
    
    score = _sqi_zcr(ppg, bpm=bpm, fps=fps)
    assert score > 70.0  # Matching ZCR should yield high score


def test_sqi_autocorr():
    """Test autocorrelation SQI for periodic heart rate signal."""
    fps = 30.0
    bpm = 60.0  # 1 Hz -> 30 frames per lag
    t = np.linspace(0, 5, int(5 * fps))
    ppg = np.sin(2 * np.pi * 1.0 * t)

    score = _sqi_autocorr(ppg, bpm=bpm, fps=fps)
    assert score > 50.0

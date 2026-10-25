"""Cross-check dsp.js against SciPy/NumPy on the same input signal.
Run:  python3 tests/validate_scipy.py        (needs numpy and scipy; optional)
Compares:  4th-order Butterworth band-pass (zero-phase), 60 Hz notch, envelope low-pass, Welch power spectrum.
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from scipy import signal

root = Path(__file__).resolve().parent.parent
d = json.loads(subprocess.check_output(["node", str(root / "tests" / "validate_scipy.js")]))
fs = d["fs"]; x = np.array(d["x"])

def rel_err(mine, ref, trim=300):
    """Relative RMS error, ignoring the first/last `trim` samples where edge handling legitimately differs."""
    a, b = np.array(mine)[trim:-trim], np.array(ref)[trim:-trim]
    return float(np.sqrt(np.mean((a - b) ** 2)) / np.sqrt(np.mean(b ** 2)))

results = {}
# Band-pass: SciPy's butter(4) per edge, applied zero-phase, as two cascaded sections to mirror the app
sos_hp = signal.butter(4, 20, "highpass", fs=fs, output="sos")
sos_lp = signal.butter(4, 450, "lowpass", fs=fs, output="sos")
ref_bp = signal.sosfiltfilt(sos_lp, signal.sosfiltfilt(sos_hp, x))
results["band-pass 20-450 Hz (zero-phase)"] = rel_err(d["bandpass"], ref_bp)

b, a = signal.iirnotch(60, 30, fs=fs)
results["60 Hz notch (zero-phase)"] = rel_err(d["notch"], signal.filtfilt(b, a, x))

rect = np.abs(np.array(d["bandpass"]))
sos_env = signal.butter(4, 5, "lowpass", fs=fs, output="sos")
results["envelope low-pass 5 Hz"] = rel_err(d["env"], signal.sosfiltfilt(sos_env, rect))

# Power spectrum: same Welch recipe (Hann, 512 window, 50 % overlap); compare shape in dB
f, p = signal.welch(x, fs=fs, window="hann", nperseg=512, noverlap=256, detrend=False, scaling="spectrum", return_onesided=True)
mine = np.array(d["psd"]); ref = np.array(p)
scale = np.median(mine[5:-5] / ref[5:-5])           # my PSD is unnormalised; compare up to one constant
db_diff = 10 * np.log10(mine[5:-5] / (ref[5:-5] * scale))
results["power spectrum (max dB difference)"] = float(np.max(np.abs(db_diff)))
assert np.allclose(d["freqs"], f), "frequency axes differ"

print("dsp.js vs SciPy/NumPy on the same 6-second test signal:\n")
bad = False
for k, v in results.items():
    unit = "dB" if "dB" in k else "relative RMS error"
    ok = v < 0.01 if "dB" not in k else v < 0.5
    bad |= not ok
    print(f"  {'ok ' if ok else 'BAD'} {k:42s} {v:.5f} {unit}")
print("\nvalidation", "FAILED" if bad else "passed")
sys.exit(1 if bad else 0)

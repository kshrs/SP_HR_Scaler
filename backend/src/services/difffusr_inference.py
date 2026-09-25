"""
DiffFuSR (Diffusion-based Super-Resolution) Engine
===================================================
Runs 4x super-resolution on Sentinel-2 satellite tiles using the DiffFuSR
WorldStrat diffusion model (logs/blindsrsnf_aniso_worldstrat_degraded_harmfac_10000_large/version_7).

Hardware Acceleration:
  - Dynamically detects available GPU hardware (dedicated and integrated graphics).
  - Automatically utilizes GPU (CUDA, Apple MPS, ROCm) for accelerated diffusion sampling.
  - Automatically reverts to CPU rendering only when no GPU hardware/driver is functional,
    applying multi-threaded tensor optimizations.
  - Features real-time GPU failover to CPU if device memory or CUDA errors occur during inference.

Modes:
  1. CLI file:     python difffusr_inference.py input.png output.png
  2. stdin/stdout: python difffusr_inference.py - -
  3. Daemon:       python difffusr_inference.py --daemon
"""

import sys
import os
import io
import time
import json
import glob
import types
import argparse
import subprocess
import importlib.util
import numpy as np
from PIL import Image

# ============================================================
# 0. PyTorch patches & Python 3.12+ compatibility shims
# ============================================================
import torch

while hasattr(torch.load, "__wrapped__"):
    torch.load = torch.load.__wrapped__

_orig_torch_load = torch.load

def _safe_torch_load(*args, **kwargs):
    kwargs["map_location"] = "cpu"
    if "weights_only" in kwargs:
        kwargs["weights_only"] = False
    return _orig_torch_load(*args, **kwargs)

_safe_torch_load.__wrapped__ = _orig_torch_load
torch.load = _safe_torch_load

if not torch.cuda.is_available():
    torch.cuda.synchronize = lambda *args, **kwargs: None

def _load_source(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

if "imp" not in sys.modules:
    imp_shim = types.ModuleType("imp")
    imp_shim.load_source = _load_source
    sys.modules["imp"] = imp_shim

# ============================================================
# 1. Paths & Imports
# ============================================================
REPO_DIR = os.path.expanduser("~/DiffFuSR")
CKPT_PATH = os.path.join(
    REPO_DIR,
    "logs/blindsrsnf_aniso_worldstrat_degraded_harmfac_10000_large/"
    "version_7/checkpoints/last.ckpt",
)

for p in [REPO_DIR, os.path.join(REPO_DIR, "litsr")]:
    if p not in sys.path:
        sys.path.insert(0, p)

import litsr.models
import litsr.archs
from litsr.utils import read_yaml
from litsr.utils.registry import ModelRegistry, ArchRegistry

_model = None
_device = None
_mode = "cpu"
_device_name = "CPU"
_detected_hardware = None


def detect_hardware():
    """
    Detects dedicated and internal/integrated graphics hardware and available PyTorch devices.
    Returns a structured dictionary summarizing detected hardware.
    """
    global _detected_hardware
    if _detected_hardware is not None:
        return _detected_hardware

    devices = []
    has_dedicated = False
    has_integrated = False
    lspci_names = []

    # 1. Inspect Linux DRM / DRI devices
    try:
        for card in sorted(glob.glob('/sys/class/drm/card[0-9]*')):
            dev_path = os.path.join(card, 'device')
            vendor_file = os.path.join(dev_path, 'vendor')
            device_file = os.path.join(dev_path, 'device')
            if os.path.exists(vendor_file):
                with open(vendor_file, 'r', encoding='utf-8') as f:
                    vendor_id = f.read().strip().lower()
                with open(device_file, 'r', encoding='utf-8') as f:
                    device_id = f.read().strip().lower()

                vendor_map = {
                    '0x10de': ('NVIDIA', 'dedicated'),
                    '0x1002': ('AMD', 'integrated/discrete'),
                    '0x8086': ('Intel', 'integrated'),
                }
                vendor_name, gpu_class = vendor_map.get(vendor_id, ('Unknown', 'gpu'))
                if vendor_id == '0x10de':
                    has_dedicated = True
                    gpu_class = 'dedicated'
                elif vendor_id == '0x8086':
                    has_integrated = True
                    gpu_class = 'integrated'

                devices.append({
                    'source': 'drm',
                    'card': os.path.basename(card),
                    'vendor': vendor_name,
                    'vendor_id': vendor_id,
                    'device_id': device_id,
                    'class': gpu_class
                })
    except Exception as e:
        sys.stderr.write(f"[DiffFuSR HW] Warning during DRM scan: {e}\n")

    # 2. Inspect lspci output
    try:
        lspci_out = subprocess.check_output(['lspci'], text=True, stderr=subprocess.DEVNULL)
        for line in lspci_out.splitlines():
            line_lower = line.lower()
            if any(k in line_lower for k in ['vga compatible controller', '3d controller', 'display controller']):
                desc = line.split(': ', 1)[-1].strip() if ': ' in line else line
                lspci_names.append(desc)
                if 'nvidia' in desc.lower():
                    has_dedicated = True
                elif 'intel' in desc.lower():
                    if 'arc' in desc.lower():
                        has_dedicated = True
                    else:
                        has_integrated = True
                elif 'amd' in desc.lower() or 'radeon' in desc.lower():
                    if 'graphics' in desc.lower() and ('ryzen' in desc.lower() or 'apu' in desc.lower()):
                        has_integrated = True
                    else:
                        has_dedicated = True
    except Exception:
        pass

    # 3. Check PyTorch CUDA / MPS
    cuda_devices = []
    if torch.cuda.is_available():
        has_dedicated = True
        for i in range(torch.cuda.device_count()):
            d_name = torch.cuda.get_device_name(i)
            cuda_devices.append(d_name)
            devices.append({'source': 'torch_cuda', 'name': d_name, 'class': 'dedicated'})
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        has_integrated = True
        devices.append({'source': 'torch_mps', 'name': 'Apple Silicon Metal GPU', 'class': 'integrated'})

    _detected_hardware = {
        'has_gpu': has_dedicated or has_integrated or len(devices) > 0 or len(lspci_names) > 0,
        'has_dedicated_gpu': has_dedicated,
        'has_integrated_gpu': has_integrated,
        'devices': devices,
        'lspci_descriptions': lspci_names,
        'cuda_available': torch.cuda.is_available(),
        'cuda_devices': cuda_devices,
        'mps_available': hasattr(torch.backends, 'mps') and torch.backends.mps.is_available(),
    }
    return _detected_hardware


def register_all_modules():
    """Auto-registers all custom architectures and models in DiffFuSR."""
    for d in ["archs", "models", "litsr/archs", "litsr/models"]:
        search_dir = os.path.join(REPO_DIR, d)
        if not os.path.exists(search_dir):
            continue
        for root, _, files in os.walk(search_dir):
            for f in files:
                if f.endswith(".py") and not f.startswith("__"):
                    fpath = os.path.join(root, f)
                    rel = os.path.relpath(fpath, REPO_DIR)
                    mod_name = os.path.splitext(rel)[0].replace(os.sep, ".")
                    try:
                        importlib.import_module(mod_name)
                    except Exception:
                        try:
                            spec = importlib.util.spec_from_file_location(
                                os.path.splitext(f)[0], fpath
                            )
                            mod = importlib.util.module_from_spec(spec)
                            sys.modules[os.path.splitext(f)[0]] = mod
                            spec.loader.exec_module(mod)
                        except Exception:
                            pass


def get_model(force_cpu=False):
    """
    Lazy loader for the DiffFuSR diffusion model.
    Utilizes GPU (CUDA/MPS) if available; automatically reverts to CPU rendering
    only when no GPU is present or when GPU initialization fails.
    """
    global _model, _device, _mode, _device_name
    if _model is not None and not force_cpu:
        return _model, _device

    register_all_modules()
    hw = detect_hardware()

    hardware_desc = ", ".join(hw['lspci_descriptions']) if hw['lspci_descriptions'] else "Unknown Device"

    sys.stderr.write(
        f"[DiffFuSR HW] Hardware Scan: dedicated_gpu={hw['has_dedicated_gpu']}, "
        f"integrated_gpu={hw['has_integrated_gpu']}, device=\"{hardware_desc}\"\n"
        f"[DiffFuSR HW] PyTorch CUDA available: {hw['cuda_available']}, MPS available: {hw['mps_available']}\n"
    )
    sys.stderr.flush()

    # Step 1: Attempt GPU execution (CUDA or Apple MPS)
    selected_device = None
    if not force_cpu:
        if hw['cuda_available']:
            try:
                selected_device = torch.device("cuda:0")
                torch.backends.cudnn.benchmark = True
                _mode = "gpu"
                _device_name = torch.cuda.get_device_name(0)
                sys.stderr.write(f"[DiffFuSR HW] ✓ GPU Acceleration ACTIVE: Using CUDA on {_device_name}\n")
                sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"[DiffFuSR HW] Failed to initialize CUDA: {e}\n")
                selected_device = None

        elif hw['mps_available']:
            try:
                selected_device = torch.device("mps")
                _mode = "gpu"
                _device_name = "Apple Silicon Metal GPU"
                sys.stderr.write(f"[DiffFuSR HW] ✓ GPU Acceleration ACTIVE: Using Apple Metal GPU\n")
                sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"[DiffFuSR HW] Failed to initialize MPS: {e}\n")
                selected_device = None

    # Step 2: Revert to CPU rendering if no GPU device was initialized
    if selected_device is None:
        selected_device = torch.device("cpu")
        _mode = "cpu"
        num_threads = min(8, os.cpu_count() or 4)
        torch.set_num_threads(num_threads)
        _device_name = f"CPU ({os.cpu_count()} cores)"

        if hw['has_gpu']:
            reason = f"GPU hardware detected ({hardware_desc}), but PyTorch GPU driver/runtime is not enabled in environment"
            sys.stderr.write(f"[DiffFuSR HW] Notice: {reason}.\n")
            sys.stderr.write(f"[DiffFuSR HW] Reverting to CPU rendering with multi-threaded optimizations ({num_threads} threads).\n")
        else:
            reason = "No dedicated or integrated GPU detected on host"
            sys.stderr.write(f"[DiffFuSR HW] {reason}. Reverting to CPU rendering ({num_threads} threads).\n")
        sys.stderr.flush()

    _device = selected_device

    if not os.path.exists(CKPT_PATH):
        raise FileNotFoundError(f"[DiffFuSR] Checkpoint not found at: {CKPT_PATH}")

    exp_path = os.path.dirname(os.path.dirname(CKPT_PATH))
    config_path = os.path.join(exp_path, "hparams.yaml")
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"[DiffFuSR] Config not found at: {config_path}")

    sys.stderr.write(f"[DiffFuSR] Loading model from checkpoint on {_device_name}...\n")
    sys.stderr.flush()

    config = read_yaml(config_path)
    model = litsr.models.load_model(config, CKPT_PATH, strict=False)
    model = model.to(_device).eval()

    _model = model
    sys.stderr.write(
        f"[DiffFuSR] Model loaded successfully: {_device_name} [{_mode.upper()}]. Ready for tile inference.\n"
    )
    sys.stderr.flush()
    return _model, _device


def super_resolve_tile(img_bytes, output_tile_size=(256, 256)):
    """
    Super-resolves an input tile (RGB 256x256) to 1024x1024 using DiffFuSR,
    and returns Lanczos-downscaled 256x256 PNG bytes for map view.
    Includes real-time GPU-to-CPU failover if device memory or CUDA errors occur.
    """
    global _model, _device, _mode, _device_name
    t0 = time.time()
    model, device = get_model()

    # Step 1: Read input image
    lr_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    if lr_pil.size != (256, 256):
        lr_pil = lr_pil.resize((256, 256), Image.Resampling.BICUBIC)

    arr = np.array(lr_pil, dtype=np.float32) / 255.0
    lr_t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)

    # Step 2: DiffFuSR inference forward pass with GPU failover
    try:
        with torch.no_grad():
            rslt = model.test_step_lr_only((lr_t, ["Tile"]))
    except Exception as run_err:
        if _mode == "gpu":
            sys.stderr.write(
                f"[DiffFuSR Warning] GPU inference error ({run_err}). "
                f"Reverting to CPU rendering fallback...\n"
            )
            sys.stderr.flush()
            model, device = get_model(force_cpu=True)
            lr_t = lr_t.to(device)
            with torch.no_grad():
                rslt = model.test_step_lr_only((lr_t, ["Tile"]))
        else:
            raise run_err

    sr_np = rslt["log_img_sr"]
    if isinstance(sr_np, torch.Tensor):
        sr_np = sr_np.cpu().numpy().transpose(1, 2, 0)

    # Step 3: Convert to uint8 RGB
    sr_1024 = (
        (sr_np * 255.0).clip(0, 255).astype(np.uint8)
        if sr_np.max() <= 1.0
        else sr_np.clip(0, 255).astype(np.uint8)
    )

    sr_pil = Image.fromarray(sr_1024)

    # Step 4: Downsample to map tile size (256x256)
    if output_tile_size is not None and sr_pil.size != output_tile_size:
        sr_pil = sr_pil.resize(output_tile_size, Image.Resampling.LANCZOS)

    # Step 5: Encode to PNG
    buf = io.BytesIO()
    sr_pil.save(buf, format="PNG", optimize=True)
    out_bytes = buf.getvalue()

    elapsed_ms = (time.time() - t0) * 1000
    sys.stderr.write(
        f"[DiffFuSR] ✓ Tile processed in {elapsed_ms:.1f}ms [{_device_name} / {_mode.upper()}] | "
        f"output {sr_pil.size[0]}x{sr_pil.size[1]}px | {len(out_bytes) // 1024}KB\n"
    )
    sys.stderr.flush()
    return out_bytes


def super_resolve_file(in_path, out_path):
    with open(in_path, "rb") as f:
        in_bytes = f.read()
    out_bytes = super_resolve_tile(in_bytes)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(out_bytes)


def run_daemon():
    """
    Persistent daemon: reads JSON from stdin, writes JSON to stdout.
    Request:  {"in": "/path/to/input.png", "out": "/path/to/output.png"}
    Response: {"status": "ok", "out": "/path/to/output.png", "mode": "gpu"|"cpu", "device": "..."}
    """
    get_model()
    ready_payload = {
        "status": "ready",
        "model": "DiffFuSR",
        "mode": _mode,
        "device": _device_name,
        "hardware": _detected_hardware or {}
    }
    sys.stdout.write(json.dumps(ready_payload) + "\n")
    sys.stdout.flush()
    sys.stderr.write(f"[DiffFuSR Daemon] Ready. Acceleration: {_mode.upper()} | Device: {_device_name}\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            in_path = req["in"]
            out_path = req["out"]
            super_resolve_file(in_path, out_path)
            res_payload = {
                "status": "ok",
                "out": out_path,
                "mode": _mode,
                "device": _device_name
            }
            sys.stdout.write(json.dumps(res_payload) + "\n")
        except Exception as e:
            sys.stderr.write(f"[DiffFuSR Error] {str(e)}\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({"status": "error", "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DiffFuSR 4x Tile Super-Resolution Engine")
    parser.add_argument("input", nargs="?", help="Input PNG path or '-' for stdin")
    parser.add_argument("output", nargs="?", help="Output PNG path or '-' for stdout")
    parser.add_argument("--daemon", action="store_true", help="Run as persistent daemon service")
    args = parser.parse_args()

    if args.daemon:
        run_daemon()
        sys.exit(0)

    if not args.input or args.input == "-":
        in_bytes = sys.stdin.buffer.read()
    else:
        with open(args.input, "rb") as f:
            in_bytes = f.read()

    out_bytes = super_resolve_tile(in_bytes)

    if not args.output or args.output == "-":
        sys.stdout.buffer.write(out_bytes)
        sys.stdout.buffer.flush()
    else:
        with open(args.output, "wb") as f:
            f.write(out_bytes)

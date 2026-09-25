"""
DiffFuSR (Diffusion-based Super-Resolution) Engine
===================================================
Runs 4x super-resolution on Sentinel-2 satellite tiles using the DiffFuSR
WorldStrat diffusion model (logs/blindsrsnf_aniso_worldstrat_degraded_harmfac_10000_large/version_7).

Takes 256x256 input tiles, performs diffusion super-resolution to 1024x1024,
and downsamples to 256x256 for map tile rendering with high-frequency structural detail.

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
import types
import argparse
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


def get_model():
    """Lazy loader for the DiffFuSR diffusion model."""
    global _model, _device
    if _model is not None:
        return _model, _device

    register_all_modules()

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    sys.stderr.write(f"[DiffFuSR] Using Device: {_device}\n")
    sys.stderr.flush()

    if not os.path.exists(CKPT_PATH):
        raise FileNotFoundError(f"[DiffFuSR] Checkpoint not found at: {CKPT_PATH}")

    exp_path = os.path.dirname(os.path.dirname(CKPT_PATH))
    config_path = os.path.join(exp_path, "hparams.yaml")
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"[DiffFuSR] Config not found at: {config_path}")

    sys.stderr.write(f"[DiffFuSR] Loading model from checkpoint: {CKPT_PATH}\n")
    sys.stderr.flush()

    config = read_yaml(config_path)
    _model = litsr.models.load_model(config, CKPT_PATH, strict=False)
    _model = _model.to(_device).eval()

    sys.stderr.write("[DiffFuSR] Model loaded successfully and ready for inference.\n")
    sys.stderr.flush()
    return _model, _device


def super_resolve_tile(img_bytes, output_tile_size=(256, 256)):
    """
    Super-resolves an input tile (RGB 256x256) to 1024x1024 using DiffFuSR,
    and returns Lanczos-downscaled 256x256 PNG bytes for map view.
    """
    t0 = time.time()
    model, device = get_model()

    # Step 1: Read input image
    lr_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    if lr_pil.size != (256, 256):
        lr_pil = lr_pil.resize((256, 256), Image.Resampling.BICUBIC)

    arr = np.array(lr_pil, dtype=np.float32) / 255.0
    lr_t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)

    # Step 2: DiffFuSR inference forward pass
    with torch.no_grad():
        rslt = model.test_step_lr_only((lr_t, ["Tile"]))

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
        f"[DiffFuSR] ✓ Tile processed in {elapsed_ms:.1f}ms [{device.type.upper()}] | "
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
    Response: {"status": "ok", "out": "/path/to/output.png"}
    """
    get_model()
    sys.stdout.write(
        json.dumps({
            "status": "ready",
            "model": "DiffFuSR",
            "device": str(_device),
        }) + "\n"
    )
    sys.stdout.flush()
    sys.stderr.write(f"[DiffFuSR Daemon] Ready. Listening on stdin (device: {_device}).\n")
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
            sys.stdout.write(json.dumps({"status": "ok", "out": out_path}) + "\n")
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

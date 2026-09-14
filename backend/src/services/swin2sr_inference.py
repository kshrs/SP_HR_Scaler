"""
Swin2SR Super-Resolution Engine using ONNX Runtime
===================================================
Runs real 4x super-resolution on Sentinel-2 satellite map tiles using the
pre-trained Swin2SR realworld model (onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr).

Architecture notes:
  - Input: (1, 3, H, W) float32 in [0, 1] — the model accepts any size
    via sliding 64x64 window inference. We feed the full 256×256 tile.
  - Output: (1, 3, H*4, W*4) float32 — 1024×1024 for a 256×256 input.
  - The output is then downscaled to 256×256 for serving as a map tile.
    This effectively applies full-resolution SR enhancement before tiling.

Critical fix from previous implementation:
  The old code pre-downscaled tiles to 96×96 BEFORE feeding to the model.
  This defeats the purpose: you are super-resolving a degraded copy.
  The correct flow is: feed the ORIGINAL 256×256 tile → get 1024×1024
  high-res output → downsample to 256×256 for the browser tile grid.
  This gives full SR enhancement visible as sharper edges, textures, etc.

Modes:
  1. CLI file:    python swin2sr_inference.py input.png output.png
  2. stdin/stdout: python swin2sr_inference.py - -
  3. Daemon:      python swin2sr_inference.py --daemon
"""

import sys
import os
import io
import json
import argparse
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

try:
    import onnxruntime as ort
except ImportError:
    ort = None

DEFAULT_MODEL_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__),
    '../../../research/model/onnx/swin2sr_realworld_x4_quantized.onnx'
))

_ort_session = None


def get_session(model_path=None):
    global _ort_session
    if _ort_session is not None:
        return _ort_session

    if ort is None:
        raise ImportError("onnxruntime not installed. Run: pip install onnxruntime")

    path = model_path or DEFAULT_MODEL_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(f"ONNX model not found at: {path}")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    _ort_session = ort.InferenceSession(
        path,
        sess_options=opts,
        providers=['CPUExecutionProvider']
    )

    # Get input metadata for logging
    meta = _ort_session.get_inputs()[0]
    sys.stderr.write(
        f"[Swin2SR] Model loaded: {os.path.basename(path)}\n"
        f"[Swin2SR] Input: {meta.name} shape={meta.shape} dtype={meta.type}\n"
    )
    sys.stderr.flush()
    return _ort_session


def pad_to_multiple(arr, window_size=8):
    """
    Pad a (H, W, C) array so that H and W are multiples of window_size.
    The Swin2SR model's sliding window attention requires input dimensions
    to be divisible by the window size (8 for this model).
    Returns (padded_arr, original_h, original_w).
    """
    h, w = arr.shape[:2]
    pad_h = (window_size - h % window_size) % window_size
    pad_w = (window_size - w % window_size) % window_size
    if pad_h > 0 or pad_w > 0:
        arr = np.pad(arr, ((0, pad_h), (0, pad_w), (0, 0)), mode='reflect')
    return arr, h, w


def super_resolve_tile(img_bytes, output_tile_size=(256, 256)):
    """
    Super-resolve a satellite map tile using Swin2SR 4x ONNX model.

    Pipeline:
      1. Load input tile as RGB (from the 256×256 backend-fetched tile)
      2. Pad to window_size=8 multiple (256 already satisfies this)
      3. Normalize to [0, 1] float32, reshape to (1, 3, H, W)
      4. Run ONNX inference → output (1, 3, H*4, W*4) = (1, 3, 1024, 1024)
      5. Clip to [0, 1], convert to uint8
      6. Crop back to original H*4 × W*4 (remove any reflect-pad)
      7. Downscale to 256×256 output tile (browser-compatible size)
      8. Apply subtle sharpness enhancement for perceptual quality
      9. Return PNG bytes
    """
    import time
    t0 = time.time()

    session = get_session()

    # Step 1: Load input
    lr_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    orig_w, orig_h = lr_pil.size
    arr = np.array(lr_pil, dtype=np.float32) / 255.0  # (H, W, 3) in [0,1]

    # Step 2: Pad to window_size=8 multiple
    arr_padded, h_orig, w_orig = pad_to_multiple(arr, window_size=8)
    ph, pw = arr_padded.shape[:2]

    # Step 3: Build model input tensor (1, 3, H, W)
    tensor = np.transpose(arr_padded, (2, 0, 1))[np.newaxis, ...]  # (1, 3, ph, pw)
    tensor = tensor.astype(np.float32)

    sys.stderr.write(
        f"[Swin2SR] Running inference: input {orig_w}x{orig_h} → padded {pw}x{ph} → "
        f"expected output {pw*4}x{ph*4}\n"
    )
    sys.stderr.flush()

    # Step 4: ONNX inference
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: tensor})
    out_tensor = outputs[0]  # (1, 3, ph*4, pw*4)

    sys.stderr.write(
        f"[Swin2SR] Raw output shape: {out_tensor.shape}, "
        f"range=[{float(out_tensor.min()):.3f}, {float(out_tensor.max()):.3f}], "
        f"mean={float(out_tensor.mean()):.3f}, std={float(out_tensor.std()):.3f}\n"
    )
    sys.stderr.flush()

    # Step 5: Postprocess: clip and convert
    out_clipped = np.clip(out_tensor[0], 0.0, 1.0)  # (3, ph*4, pw*4)
    out_arr = (np.transpose(out_clipped, (1, 2, 0)) * 255.0).round().astype(np.uint8)

    # Step 6: Crop back to actual output size (remove reflect padding)
    out_arr = out_arr[:h_orig * 4, :w_orig * 4, :]
    sr_pil = Image.fromarray(out_arr)

    # Step 7: Downscale to target tile size using high-quality Lanczos filter
    # (1024x1024 SR → 256x256 tile — preserves all SR enhancement at tile scale)
    if sr_pil.size != output_tile_size:
        sr_pil = sr_pil.resize(output_tile_size, Image.Resampling.LANCZOS)

    # Step 8: Subtle unsharp mask to recover any softening from the downscale
    sr_pil = sr_pil.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=2))

    # Step 9: Encode to PNG
    buf = io.BytesIO()
    sr_pil.save(buf, format="PNG", optimize=True)
    out_bytes = buf.getvalue()

    elapsed_ms = (time.time() - t0) * 1000
    sys.stderr.write(
        f"[Swin2SR] ✓ Done in {elapsed_ms:.1f}ms | "
        f"output {output_tile_size[0]}x{output_tile_size[1]}px | "
        f"{len(out_bytes) // 1024}KB\n"
    )
    sys.stderr.flush()

    return out_bytes


def super_resolve_file(in_path, out_path):
    """Super-resolve a file from disk and write result to disk."""
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
              {"status": "error", "error": "...message..."}
    """
    # Pre-load model at daemon startup to avoid cold-start latency on first tile
    get_session()
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()
    sys.stderr.write("[Swin2SR Daemon] Ready. Listening for tile requests on stdin.\n")
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
            sys.stderr.write(f"[Swin2SR Error] {str(e)}\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({"status": "error", "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Swin2SR 4x Tile Super-Resolution Engine")
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

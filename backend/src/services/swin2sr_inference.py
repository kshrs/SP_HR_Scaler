"""
Swin2SR Super-Resolution Engine using ONNX Runtime
===================================================
Provides high-performance 4x image super-resolution inference on Sentinel-2 satellite tiles
using pre-trained quantized Swin2SR transformer model via ONNX Runtime.

Modes:
  1. CLI file:
       python swin2sr_inference.py input.png output.png
  2. Single stdin/stdout pipe:
       python swin2sr_inference.py - -
  3. Persistent Daemon Service (line-delimited JSON RPC or file paths):
       python swin2sr_inference.py --daemon
"""

import sys
import os
import io
import json
import argparse
import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except ImportError:
    ort = None

DEFAULT_MODEL_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__),
    '../../../research/model/onnx/swin2sr_realworld_x4_quantized.onnx'
))

# Global session cache to avoid repeated model loading
_ort_session = None

def get_session(model_path=None):
    global _ort_session
    if _ort_session is not None:
        return _ort_session
    
    path = model_path or DEFAULT_MODEL_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(f"ONNX model not found at: {path}")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    _ort_session = ort.InferenceSession(path, sess_options=opts, providers=['CPUExecutionProvider'])
    return _ort_session


def super_resolve_tile(img_bytes, target_size=(256, 256)):
    """
    Takes PNG/JPEG bytes of a tile, runs Swin2SR 4x super-resolution,
    and returns high-resolution PNG bytes (256x256).
    """
    session = get_session()
    
    # 1. Load input image
    lr_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    
    # To keep inference snappy (< 1 second per tile on CPU) while achieving 4x transformer enhancement,
    # resize input tile to 64x64 if larger, then run Swin2SR 4x upsampler to generate 256x256.
    input_patch = lr_pil.resize((64, 64), Image.Resampling.BICUBIC)
    
    arr = np.array(input_patch).astype(np.float32) / 255.0
    tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]  # (1, 3, 64, 64)
    
    # 2. Run ONNX Inference
    outputs = session.run(None, {'pixel_values': tensor})
    out_tensor = outputs[0]  # (1, 3, 256, 256)
    
    # 3. Postprocess
    out_clipped = np.clip(out_tensor[0], 0.0, 1.0)
    out_img = (np.transpose(out_clipped, (1, 2, 0)) * 255.0).round().astype(np.uint8)
    sr_pil = Image.fromarray(out_img)
    
    if sr_pil.size != target_size:
        sr_pil = sr_pil.resize(target_size, Image.Resampling.LANCZOS)
    
    # 4. Return PNG bytes
    out_buf = io.BytesIO()
    sr_pil.save(out_buf, format="PNG", optimize=True)
    return out_buf.getvalue()


def super_resolve_file(in_path, out_path):
    with open(in_path, "rb") as f:
        in_bytes = f.read()
    out_bytes = super_resolve_tile(in_bytes)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(out_bytes)


def run_daemon():
    """
    Persistent daemon reading JSON commands from stdin:
    {"in": "/path/to/in.png", "out": "/path/to/out.png"}
    and outputting:
    {"status": "ok", "out": "/path/to/out.png"}
    """
    get_session()
    # Signal daemon readiness
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

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
            sys.stdout.write(json.dumps({"status": "error", "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Swin2SR Tile Super-Resolution")
    parser.add_argument("input", nargs="?", help="Input image file path or '-' for stdin")
    parser.add_argument("output", nargs="?", help="Output image file path or '-' for stdout")
    parser.add_argument("--daemon", action="store_true", help="Run in persistent daemon mode")
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

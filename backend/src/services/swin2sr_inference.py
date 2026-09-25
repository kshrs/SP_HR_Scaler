"""
Swin2SR Super-Resolution Engine using ONNX Runtime
===================================================
Runs real 4x super-resolution on Sentinel-2 satellite map tiles using the
pre-trained Swin2SR realworld model (onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr).

Hardware Acceleration:
  - Dynamically detects available GPU hardware (dedicated and integrated/internal graphics).
  - Automatically selects the optimal execution provider (TensorRT, CUDA, ROCm, OpenVINO, CoreML, DirectML).
  - Automatically diverts to CPUExecutionProvider only when no dedicated or internal graphics hardware/driver
    is functional, applying multi-threaded graph optimizations.

Modes:
  1. CLI file:     python swin2sr_inference.py input.png output.png
  2. stdin/stdout: python swin2sr_inference.py - -
  3. Daemon:       python swin2sr_inference.py --daemon
"""

import sys
import os
import io
import json
import glob
import time
import argparse
import subprocess
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
_detected_hardware = None
_active_provider_info = None


def detect_hardware():
    """
    Detects dedicated and internal/integrated graphics hardware and available execution providers.
    Returns a structured dictionary summarizing detected hardware.
    """
    global _detected_hardware
    if _detected_hardware is not None:
        return _detected_hardware

    devices = []
    has_dedicated = False
    has_integrated = False
    lspci_names = []

    # 1. Inspect Linux DRM / DRI render devices (/sys/class/drm/card* or renderD*)
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
        sys.stderr.write(f"[Swin2SR HW] Warning during DRM device scan: {e}\n")

    # 2. Inspect lspci output for controller details
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
                    # Intel Iris / UHD / HD graphics are integrated, Intel Arc may be discrete
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

    # 3. Check PyTorch CUDA / MPS if available
    try:
        import torch
        if torch.cuda.is_available():
            has_dedicated = True
            for i in range(torch.cuda.device_count()):
                devices.append({
                    'source': 'torch_cuda',
                    'name': torch.cuda.get_device_name(i),
                    'class': 'dedicated'
                })
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            has_integrated = True
            devices.append({
                'source': 'torch_mps',
                'name': 'Apple Silicon Metal GPU',
                'class': 'integrated'
            })
    except Exception:
        pass

    available_ort_providers = ort.get_available_providers() if ort else []

    _detected_hardware = {
        'has_gpu': has_dedicated or has_integrated or len(devices) > 0 or len(lspci_names) > 0,
        'has_dedicated_gpu': has_dedicated,
        'has_integrated_gpu': has_integrated,
        'devices': devices,
        'lspci_descriptions': lspci_names,
        'ort_providers': available_ort_providers,
    }
    return _detected_hardware


def get_session(model_path=None, force_cpu=False):
    """
    Initializes and returns the ONNX Runtime InferenceSession.
    Attempts GPU execution providers (dedicated or integrated) first.
    Gracefully diverts to CPUExecutionProvider only when no dedicated/internal GPU
    or working GPU acceleration provider is available.
    """
    global _ort_session, _active_provider_info
    if _ort_session is not None and not force_cpu:
        return _ort_session

    if ort is None:
        raise ImportError("onnxruntime not installed. Run: pip install onnxruntime")

    path = model_path or DEFAULT_MODEL_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(f"ONNX model not found at: {path}")

    hw = detect_hardware()
    available = ort.get_available_providers()

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    session = None
    active_provider = None
    hardware_desc = ", ".join(hw['lspci_descriptions']) if hw['lspci_descriptions'] else "Unknown Graphics"

    sys.stderr.write(
        f"[Swin2SR HW] Hardware Scan: dedicated_gpu={hw['has_dedicated_gpu']}, "
        f"integrated_gpu={hw['has_integrated_gpu']}, device=\"{hardware_desc}\"\n"
        f"[Swin2SR HW] Available ORT Providers: {available}\n"
    )
    sys.stderr.flush()

    # Prioritized list of GPU execution providers
    if not force_cpu and hw['has_gpu']:
        candidate_gpu_providers = [
            'TensorrtExecutionProvider',   # NVIDIA TensorRT
            'CUDAExecutionProvider',       # NVIDIA CUDA
            'ROCMExecutionProvider',       # AMD ROCm
            'MIGraphXExecutionProvider',   # AMD MIGraphX
            'OpenVINOExecutionProvider',   # Intel Iris Xe / Arc / UHD integrated or discrete GPU
            'CoreMLExecutionProvider',     # Apple Silicon Metal GPU / Neural Engine
            'DmlExecutionProvider',        # DirectML (Windows / WSL)
        ]

        supported_gpus = [p for p in candidate_gpu_providers if p in available]

        for provider in supported_gpus:
            try:
                sys.stderr.write(f"[Swin2SR HW] Probing GPU acceleration with {provider}...\n")
                sys.stderr.flush()

                provider_args = {}
                if provider == 'CUDAExecutionProvider':
                    provider_args = {
                        'device_id': 0,
                        'arena_extend_strategy': 'kNextPowerOfTwo',
                        'gpu_mem_limit': 4 * 1024 * 1024 * 1024,
                        'cudnn_conv_algo_search': 'DEFAULT',
                        'do_copy_in_default_stream': True,
                    }
                elif provider == 'OpenVINOExecutionProvider':
                    provider_args = {
                        'device_type': 'GPU',
                        'precision': 'FP16',
                    }
                elif provider == 'DmlExecutionProvider':
                    provider_args = {'device_id': 0}

                providers_to_try = [
                    (provider, provider_args) if provider_args else provider,
                    'CPUExecutionProvider'
                ]

                test_session = ort.InferenceSession(path, sess_options=opts, providers=providers_to_try)
                assigned = test_session.get_providers()

                if assigned and assigned[0] == provider:
                    session = test_session
                    active_provider = provider
                    _active_provider_info = {
                        'mode': 'gpu',
                        'provider': provider,
                        'device': hardware_desc,
                        'details': f"Accelerated via {provider}"
                    }
                    sys.stderr.write(f"[Swin2SR HW] ✓ GPU Acceleration ACTIVE: Using {provider} on {hardware_desc}\n")
                    sys.stderr.flush()
                    break
                else:
                    sys.stderr.write(f"[Swin2SR HW] Provider {provider} downgraded to {assigned}.\n")
                    sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"[Swin2SR HW] Provider {provider} failed: {e}\n")
                sys.stderr.flush()

    # Divert to CPUExecutionProvider only when no dedicated/internal graphics is operational
    if session is None:
        opts.intra_op_num_threads = min(8, os.cpu_count() or 4)
        opts.inter_op_num_threads = 2
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

        if hw['has_gpu']:
            reason = f"GPU hardware detected ({hardware_desc}), but native GPU compute driver/provider not available in environment"
            sys.stderr.write(f"[Swin2SR HW] Notice: {reason}.\n")
            sys.stderr.write(
                f"[Swin2SR HW] Diverting to CPUExecutionProvider with multi-threaded "
                f"optimizations ({opts.intra_op_num_threads} worker threads).\n"
            )
        else:
            reason = "No dedicated or integrated GPU detected on host"
            sys.stderr.write(f"[Swin2SR HW] {reason}. Utilizing CPUExecutionProvider.\n")
        sys.stderr.flush()

        session = ort.InferenceSession(path, sess_options=opts, providers=['CPUExecutionProvider'])
        active_provider = 'CPUExecutionProvider'
        _active_provider_info = {
            'mode': 'cpu',
            'provider': 'CPUExecutionProvider',
            'device': f"CPU ({os.cpu_count()} logical cores)",
            'details': reason
        }

    _ort_session = session

    meta = _ort_session.get_inputs()[0]
    sys.stderr.write(
        f"[Swin2SR] Model: {os.path.basename(path)} | "
        f"Active Execution Provider: {active_provider} [{_active_provider_info['mode'].upper()}]\n"
        f"[Swin2SR] Input Tensor: {meta.name} shape={meta.shape} dtype={meta.type}\n"
    )
    sys.stderr.flush()
    return _ort_session


def pad_to_multiple(arr, window_size=8):
    """
    Pad a (H, W, C) array so that H and W are multiples of window_size.
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
      1. Load input tile as RGB (256x256)
      2. Pad to window_size=8 multiple (256 already satisfies this)
      3. Normalize to [0, 1] float32, reshape to (1, 3, H, W)
      4. Run ONNX inference (GPU accelerated with CPU failover) → output (1, 3, 1024, 1024)
      5. Clip to [0, 1], convert to uint8
      6. Crop back to original H*4 x W*4
      7. Downscale to target tile size using high-quality Lanczos filter
      8. Apply subtle sharpness and contrast perceptual enhancement
      9. Return PNG bytes
    """
    t0 = time.time()
    session = get_session()

    # Step 1: Load input
    lr_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    orig_w, orig_h = lr_pil.size
    arr = np.array(lr_pil, dtype=np.float32) / 255.0

    # Step 2: Pad to window_size=8 multiple
    arr_padded, h_orig, w_orig = pad_to_multiple(arr, window_size=8)
    ph, pw = arr_padded.shape[:2]

    # Step 3: Build model input tensor (1, 3, H, W)
    tensor = np.transpose(arr_padded, (2, 0, 1))[np.newaxis, ...]
    tensor = tensor.astype(np.float32)

    # Step 4: ONNX inference with runtime GPU failover to CPU
    input_name = session.get_inputs()[0].name
    try:
        outputs = session.run(None, {input_name: tensor})
    except Exception as run_err:
        global _active_provider_info
        if _active_provider_info and _active_provider_info.get('mode') == 'gpu':
            sys.stderr.write(
                f"[Swin2SR Warning] GPU inference encountered an error ({run_err}). "
                f"Failing over to CPU execution...\n"
            )
            sys.stderr.flush()
            session = get_session(force_cpu=True)
            input_name = session.get_inputs()[0].name
            outputs = session.run(None, {input_name: tensor})
        else:
            raise run_err

    out_tensor = outputs[0]  # (1, 3, ph*4, pw*4)

    # Step 5: Postprocess: clip and convert
    out_clipped = np.clip(out_tensor[0], 0.0, 1.0)
    out_arr = (np.transpose(out_clipped, (1, 2, 0)) * 255.0).round().astype(np.uint8)

    # Step 6: Crop back to actual output size
    out_arr = out_arr[:h_orig * 4, :w_orig * 4, :]
    sr_pil = Image.fromarray(out_arr)

    # Step 7: Downscale to target tile size using high-quality Lanczos filter
    if sr_pil.size != output_tile_size:
        sr_pil = sr_pil.resize(output_tile_size, Image.Resampling.LANCZOS)

    # Step 8: Perceptual enhancement
    enhancer_contrast = ImageEnhance.Contrast(sr_pil)
    sr_pil = enhancer_contrast.enhance(1.12)

    enhancer_sharpness = ImageEnhance.Sharpness(sr_pil)
    sr_pil = enhancer_sharpness.enhance(1.35)

    sr_pil = sr_pil.filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=1))

    # Step 9: Encode to PNG
    buf = io.BytesIO()
    sr_pil.save(buf, format="PNG", optimize=True)
    out_bytes = buf.getvalue()

    elapsed_ms = (time.time() - t0) * 1000
    prov_name = _active_provider_info.get('provider', 'CPU') if _active_provider_info else 'CPUExecutionProvider'
    prov_mode = _active_provider_info.get('mode', 'cpu').upper() if _active_provider_info else 'CPU'

    sys.stderr.write(
        f"[Swin2SR] ✓ Tile processed in {elapsed_ms:.1f}ms [{prov_name} / {prov_mode}] | "
        f"output {output_tile_size[0]}x{output_tile_size[1]}px | {len(out_bytes) // 1024}KB\n"
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
    Response: {"status": "ok", "out": "/path/to/output.png", "provider": "...", "mode": "gpu"|"cpu"}
    """
    get_session()
    ready_payload = {
        "status": "ready",
        "provider": _active_provider_info.get("provider", "CPUExecutionProvider") if _active_provider_info else "CPUExecutionProvider",
        "mode": _active_provider_info.get("mode", "cpu") if _active_provider_info else "cpu",
        "device": _active_provider_info.get("device", "CPU") if _active_provider_info else "CPU",
        "hardware": _detected_hardware or {}
    }
    sys.stdout.write(json.dumps(ready_payload) + "\n")
    sys.stdout.flush()

    sys.stderr.write(
        f"[Swin2SR Daemon] Ready. Acceleration: {ready_payload['mode'].upper()} "
        f"({ready_payload['provider']}) | Device: {ready_payload['device']}\n"
    )
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
                "provider": _active_provider_info.get("provider", "CPUExecutionProvider") if _active_provider_info else "CPUExecutionProvider",
                "mode": _active_provider_info.get("mode", "cpu") if _active_provider_info else "cpu"
            }
            sys.stdout.write(json.dumps(res_payload) + "\n")
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

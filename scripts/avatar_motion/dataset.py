"""Read VRM Animation GLBs into normalized humanoid rotation samples.

Only glTF LINEAR float32 rotation tracks are accepted. Training is offline;
the packaged Avatar never reads source VRMA files or runs Python.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError(f"{path.name}: not a binary glTF")
    if struct.unpack_from("<I", data, 8)[0] != len(data):
        raise ValueError(f"{path.name}: invalid GLB length")
    offset = 12
    chunks: dict[int, bytes] = {}
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        chunks[kind] = data[offset:offset + length]
        offset += length
    if offset != len(data) or 0x4E4F534A not in chunks or 0x004E4942 not in chunks:
        raise ValueError(f"{path.name}: missing or malformed GLB chunks")
    return json.loads(chunks[0x4E4F534A]), chunks[0x004E4942]


def accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    item = gltf["accessors"][index]
    if item["componentType"] != 5126 or item.get("sparse"):
        raise ValueError("only dense float32 animation accessors are supported")
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[item["type"]]
    view = gltf["bufferViews"][item["bufferView"]]
    offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
    stride = view.get("byteStride", width * 4)
    array = np.ndarray((item["count"], width), dtype="<f4", buffer=binary,
                       offset=offset, strides=(stride, 4))
    return array.copy()


def sample_quaternions(times: np.ndarray, values: np.ndarray, query: np.ndarray) -> np.ndarray:
    times = times[:, 0]
    if len(times) < 2 or not np.all(np.diff(times) > 0):
        raise ValueError("animation track has invalid keyframe times")
    values = values / np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-8)
    # q and -q encode the same pose. Unwrap before interpolation and regression.
    values = values.copy()
    for i in range(1, len(values)):
        if np.dot(values[i - 1], values[i]) < 0:
            values[i] *= -1
    indices = np.clip(np.searchsorted(times, query, side="right") - 1, 0, len(times) - 2)
    left, right = times[indices], times[indices + 1]
    alpha = np.clip((query - left) / (right - left), 0, 1)[:, None]
    out = values[indices] * (1 - alpha) + values[indices + 1] * alpha
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-8)


def load_motion(path: Path, bones: list[str], fps: int = 24,
                max_seconds: float = 9.0) -> tuple[float, np.ndarray]:
    gltf, binary = read_glb(path)
    mapping = gltf.get("extensions", {}).get("VRMC_vrm_animation", {}).get("humanoid", {}).get("humanBones", {})
    node_to_bone = {entry["node"]: name for name, entry in mapping.items()}
    animations = gltf.get("animations", [])
    if not animations:
        raise ValueError(f"{path.name}: no animation")
    animation = animations[0]
    tracks: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    duration = 0.0
    for channel in animation["channels"]:
        target = channel["target"]
        bone = node_to_bone.get(target["node"])
        if target["path"] != "rotation" or bone not in bones:
            continue
        sampler = animation["samplers"][channel["sampler"]]
        if sampler.get("interpolation", "LINEAR") != "LINEAR":
            raise ValueError(f"{path.name}: unsupported interpolation")
        times = accessor(gltf, binary, sampler["input"])
        values = accessor(gltf, binary, sampler["output"])
        if len(times) != len(values) or values.shape[1] != 4:
            raise ValueError(f"{path.name}: invalid rotation track")
        tracks[bone] = (times, values)
        duration = max(duration, float(times[-1, 0]))
    if not tracks or duration <= 0:
        raise ValueError(f"{path.name}: no animated humanoid rotations")
    duration = min(duration, max_seconds)
    query = np.linspace(0, duration, max(2, round(duration * fps) + 1), dtype=np.float32)
    poses = np.zeros((len(query), len(bones), 4), dtype=np.float32)
    poses[:, :, 3] = 1
    for index, bone in enumerate(bones):
        if bone in tracks:
            poses[:, index] = sample_quaternions(*tracks[bone], query)
    return duration, poses

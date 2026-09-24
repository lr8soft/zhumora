"""Train Zhumora's small text-routed VRM pose model on a CUDA GPU.

Run with the project's ignored VRMA sample directory. The export contains
network weights and labels, never the source animation files.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import random
import unicodedata
from pathlib import Path

import numpy as np
import torch
from torch import nn

from dataset import load_motion, read_glb


# Deliberately curated. File names such as "unknown" cannot provide a text label.
# Each class currently has one example, so this model interpolates a bounded
# motion vocabulary; it cannot synthesize an unseen action from arbitrary prose.
MOTIONS = [
    ("idle", "CC0animationidle04.vrma", "待机 静止 放松 idle rest stand still"),
    ("speak", "CC0animation5talk.vrma", "说话 讲话 交谈 发言 talk speak talking"),
    ("wave", "CC0animationrightwave1.vrma", "挥手 招手 再见 wave waving goodbye"),
    ("greet", "004_hello_1.vrma", "打招呼 问候 你好 hello greet greeting"),
    ("point", "CC0animationpoint1.vrma", "指向 指路 指一指 point pointing indicate"),
    ("celebrate", "CC0animationhappy01.vrma", "开心 高兴 庆祝 欢呼 happy celebrate cheer"),
    ("surprised", "008_gatan.vrma", "惊讶 吓一跳 吃惊 震惊 surprised startled"),
    ("phone", "005_smartphone.vrma", "看手机 玩手机 使用手机 phone smartphone"),
    ("drink", "006_drinkwater.vrma", "喝水 喝饮料 饮水 drink water beverage"),
    ("encourage", "007_gekirei.vrma", "加油 鼓励 打气 encourage motivate support"),
    ("bow", "002_dogeza.vrma", "鞠躬 道歉 致歉 bow apologize sorry"),
    ("spin", "CC0animationrotate01.vrma", "旋转 转圈 转身 spin rotate turn around"),
]


def hash_features(text: str, size: int = 512) -> np.ndarray:
    cleaned = "".join(ch for ch in unicodedata.normalize("NFKC", text).lower() if ch.isalnum())
    result = np.zeros(size, dtype=np.float32)
    if not cleaned:
        return result
    for width in (1, 2, 3):
        for start in range(max(0, len(cleaned) - width + 1)):
            value = 2166136261
            for byte in cleaned[start:start + width].encode("utf-8"):
                value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
            result[value % size] += 1
    result /= max(np.linalg.norm(result), 1e-8)
    return result


def text_examples() -> tuple[np.ndarray, np.ndarray, list[str]]:
    phrases: list[str] = []
    labels: list[int] = []
    for index, (name, _, aliases) in enumerate(MOTIONS):
        words = aliases.split()
        for word in [name, *words]:
            for phrase in (word, f"请{word}", f"让角色{word}", f"向用户{word}", f"请向用户{word}",
                           f"做一个{word}动作", f"avatar {word}"):
                phrases.append(phrase)
                labels.append(index)
    return np.stack([hash_features(value) for value in phrases]), np.asarray(labels), phrases


def phase_features(phase: torch.Tensor) -> torch.Tensor:
    frequencies = torch.arange(1, 13, device=phase.device, dtype=phase.dtype)
    angle = phase[:, None] * frequencies[None, :] * (2 * math.pi)
    return torch.cat((phase[:, None], torch.sin(angle), torch.cos(angle)), dim=1)


class PoseModel(nn.Module):
    def __init__(self, classes: int, bones: int):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(classes + 25, 256), nn.SiLU(),
            nn.Linear(256, 256), nn.SiLU(),
            nn.Linear(256, bones * 4),
        )
        self.bones = bones
        self.classes = classes

    def forward(self, cls: torch.Tensor, phase: torch.Tensor) -> torch.Tensor:
        conditioned = torch.cat((nn.functional.one_hot(cls, self.classes).float(), phase_features(phase)), dim=1)
        output = self.layers(conditioned).reshape(-1, self.bones, 4)
        return nn.functional.normalize(output, dim=-1)


def export_linear(layer: nn.Linear) -> dict:
    weight = layer.weight.detach().cpu().numpy().astype(np.float32)
    bias = layer.bias.detach().cpu().numpy().astype(np.float32)
    def pack(values: np.ndarray) -> dict:
        scale = max(float(np.max(np.abs(values))) / 32767, 1e-12)
        quantized = np.round(values.ravel() / scale).astype("<i2")
        return {"scale": scale, "data": base64.b64encode(quantized.tobytes()).decode("ascii")}
    return {"input": weight.shape[1], "output": weight.shape[0],
            "weights": pack(weight), "bias": pack(bias)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("vrma_animations"))
    parser.add_argument("--output", type=Path, default=Path("src/renderer/src/avatar/neural/motion-model.json"))
    parser.add_argument("--steps", type=int, default=150000)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA PyTorch is required for offline training; runtime inference remains CPU-only.")
    random.seed(7)
    np.random.seed(7)
    torch.manual_seed(7)
    device = torch.device("cuda")
    print(f"torch {torch.__version__} device={torch.cuda.get_device_name(device)} "
          f"capability={torch.cuda.get_device_capability(device)}")

    # The spec defines the humanoid names. A source clip supplies the actual
    # set, while sorted order makes the exported model deterministic.
    gltf, _ = read_glb(args.input / MOTIONS[2][1])
    bones = sorted(gltf["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"])
    bones = [bone for bone in bones if bone not in {"leftEye", "rightEye"}]
    durations: list[float] = []
    poses: list[np.ndarray] = []
    phases: list[np.ndarray] = []
    classes: list[np.ndarray] = []
    for index, (name, filename, _) in enumerate(MOTIONS):
        duration, samples = load_motion(args.input / filename, bones)
        durations.append(duration)
        poses.append(samples)
        phases.append(np.linspace(0, 1, len(samples), dtype=np.float32))
        classes.append(np.full(len(samples), index, dtype=np.int64))
        print(f"{name:12} {filename:36} {duration:5.2f}s {len(samples):3} frames")
    target = torch.from_numpy(np.concatenate(poses)).to(device)
    phase = torch.from_numpy(np.concatenate(phases)).to(device)
    cls = torch.from_numpy(np.concatenate(classes)).to(device)
    # Moving bones matter more than unchanged identity tracks.
    movement = target.std(dim=0).mean(dim=-1)
    bone_weight = (0.4 + movement / (movement.mean() + 1e-5)).clamp(max=4)
    model = PoseModel(len(MOTIONS), len(bones)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=1e-5)
    for step in range(args.steps):
        indices = torch.randint(len(target), (512,), device=device)
        predicted = model(cls[indices], phase[indices])
        loss = ((predicted - target[indices]).square().mean(dim=-1) * bone_weight).mean()
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if step % 300 == 0 or step == args.steps - 1:
            print(f"pose step {step:4}: mse={loss.item():.5f}")

    text_x, text_y, phrases = text_examples()
    x = torch.from_numpy(text_x).to(device)
    y = torch.from_numpy(text_y).long().to(device)
    router = nn.Linear(512, len(MOTIONS)).to(device)
    route_optimizer = torch.optim.AdamW(router.parameters(), lr=0.04, weight_decay=0.0001)
    for _ in range(500):
        loss = nn.functional.cross_entropy(router(x), y)
        route_optimizer.zero_grad(set_to_none=True)
        loss.backward()
        route_optimizer.step()
    accuracy = (router(x).argmax(dim=1) == y).float().mean().item()
    print(f"text training accuracy={accuracy:.3f}")

    model.eval()
    with torch.no_grad():
        predicted = model(cls, phase)
        dots = (predicted * target).sum(dim=-1).abs().clamp(max=1)
        angles = 2 * torch.acos(dots) * (180 / math.pi)
        print(f"pose angular error mean={angles.mean().item():.2f}° p95={torch.quantile(angles, 0.95).item():.2f}° "
              f"max={angles.max().item():.2f}°")
        # Training-set error per class: this is a memorization check, not a
        # generalization estimate, and it must be near zero for every clip.
        for index, (name, _, _) in enumerate(MOTIONS):
            per_class = angles[cls == index]
            print(f"  {name:12} mean={per_class.mean().item():5.2f}° max={per_class.max().item():5.2f}°")
    exported = {
        "version": 1,
        "bones": bones,
        "classes": [{"name": name, "duration": round(duration, 4), "aliases": aliases.split()}
                    for (name, _, aliases), duration in zip(MOTIONS, durations)],
        "text": export_linear(router),
        "pose": [export_linear(model.layers[index]) for index in (0, 2, 4)],
        "prototypes": [hash_features(phrase).nonzero()[0].tolist() for phrase in phrases],
    }

    def unpack(packed: dict) -> torch.Tensor:
        raw = np.frombuffer(base64.b64decode(packed["data"]), dtype="<i2").astype(np.float32)
        return torch.from_numpy(raw * packed["scale"]).to(device)

    with torch.no_grad():
        # The renderer only ever sees the int16 weights, so report the error of
        # that exact round-trip instead of the float32 training graph.
        vector = torch.cat((nn.functional.one_hot(cls, len(MOTIONS)).float(), phase_features(phase)), dim=1)
        for index, entry in enumerate(exported["pose"]):
            weight = unpack(entry["weights"]).reshape(entry["output"], entry["input"])
            vector = vector @ weight.T + unpack(entry["bias"])
            if index < len(exported["pose"]) - 1:
                vector = nn.functional.silu(vector)
        shipped = nn.functional.normalize(vector.reshape(-1, len(bones), 4), dim=-1)
        dots = (shipped * target).sum(dim=-1).abs().clamp(max=1)
        quantized_angles = 2 * torch.acos(dots) * (180 / math.pi)
        print(f"exported int16 angular error mean={quantized_angles.mean().item():.2f}° "
              f"p95={torch.quantile(quantized_angles, 0.95).item():.2f}° max={quantized_angles.max().item():.2f}°")
    # Both gates guard the artifact that is about to overwrite the shipped model.
    if accuracy < 0.97:
        raise SystemExit("Text router did not fit the curated descriptions.")
    if angles.mean().item() > 0.5 or torch.quantile(angles, 0.95).item() > 2:
        raise SystemExit("Pose decoder did not memorize the curated clips; raise --steps.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(exported, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"exported {args.output} ({args.output.stat().st_size / 1024:.0f} KiB)")
    print(f"peak CUDA memory allocated={torch.cuda.max_memory_allocated() / 2**20:.1f} MiB")


if __name__ == "__main__":
    main()

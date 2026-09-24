# Local Avatar text motion model

The shipped model is a bounded text-to-motion prototype. It routes a short
Chinese or English action phrase to one of 12 curated actions, then a small
two-hidden-layer PyTorch network generates normalized VRM humanoid bone
quaternions as a continuous function of action phase. It cannot invent an
action absent from the training set. Unknown text returns an error in the
explicit `generate_motion` tool path; `perform` falls back to the existing
procedural clip when no trained action matches.

## Training

Source `.vrma` files stay in the ignored `vrma_animations/` directory. The
training scripts require Python, NumPy and CUDA-enabled PyTorch. The local
`LearnLLM` conda environment has PyTorch 2.8.0+cu129 and was used with an
RTX 4060 Laptop GPU:

```powershell
& 'C:\Users\lrsof\.conda\envs\LearnLLM\python.exe' scripts/avatar_motion/train.py --input vrma_animations
```

Use another CUDA Python environment by substituting its executable. `--input`
accepts any directory containing the files named in `MOTIONS`. Retraining
overwrites `src/renderer/src/avatar/neural/motion-model.json`. The export
contains weights, bone names, class labels and text prototypes; source VRMA
files are not included in the installer.

The current curated files come from the creators' CC0 VRMA releases:

- `001_*` through `008_*`: fumi2kick, BOOTH item 5527394.
- `CC0animation*`: sashii, BOOTH item 6412084.

The training set was sampled at 24 fps, clips capped at nine seconds and hip
translation omitted so the desktop Avatar remains anchored. The pose decoder is
trained until it memorizes the twelve curated clips; the default 150000 steps
reach 0.10 degrees mean, 0.30 degrees p95 and 3.06 degrees worst-case per-bone
angular reconstruction error on the training samples. The residual is the
12-harmonic phase basis smoothing the fastest frames, not quantization: the
int16 round-trip reports the same error as the float32 graph. Int16 weight
packing makes the shipped model JSON about 396 KiB. Every class has a single
example, so this is memorization of a bounded vocabulary, not a measure of
general text understanding or visual quality on all VRM models.

## Runtime

`avatar_control` retains its `normal` permission. `perform` uses the model only
for intents that appear in the trained vocabulary (`idle`, `greet`, `wave`,
`celebrate`, `bow` for the current export) and uses its built-in procedural
motion for every other intent, unless a user-configured override exists.
`generate_motion` accepts a short action description and rejects unsupported
actions. The
sandboxed Avatar window runs the exported model in a dedicated browser worker
using plain TypeScript `Float32Array` math on the CPU. The worker reports the
class names from the exported model in a startup handshake, so retraining
updates the intents the controller and the system prompt use without touching
application code. It builds an ordinary
Three.js `AnimationClip` over normalized bones; the existing motion controller
owns blending, cancellation and return to idle. No Python, CUDA, source VRMA
or model inference runs in main, preload or the Agent executor.

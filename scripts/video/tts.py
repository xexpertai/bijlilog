"""Kokoro voiceover. Usage: ~/workspace/.video-venv/bin/python scripts/video/tts.py <build_dir>"""
import json, pathlib, subprocess, sys
import numpy as np, soundfile as sf
from kokoro import KPipeline
B = pathlib.Path(sys.argv[1]); story = json.load(open(pathlib.Path(__file__).with_name("story.json")))
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
SIL = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse"
(B / "audio").mkdir(parents=True, exist_ok=True)
durs = {}
for ln in story["lines"]:
    a = np.concatenate([np.asarray(x) for _, _, x in pipe(ln["text"], voice=story["_meta"]["voice"], speed=1.0)])
    raw = B / "audio" / f"{ln['id']}.raw.wav"; out = B / "audio" / f"{ln['id']}.wav"
    sf.write(raw, a, 24000, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw), "-af", SIL, str(out)], check=True)
    durs[ln["id"]] = sf.info(out).duration; print(ln["id"], f"{durs[ln['id']]:.2f}s")
json.dump(durs, open(B / "durations.json", "w")); print("total", f"{sum(durs.values()):.1f}s")

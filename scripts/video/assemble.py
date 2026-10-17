"""Assemble clips + narration into build/bijlilog-demo.mp4 (1920x1080, -14 LUFS) and run QA.
Usage: python3 scripts/video/assemble.py <build_dir> [out.mp4]
QA: loudness -14 +-1 LUFS, true peak <= -1 dBTP, no silence > 0.6 s, no frozen hold > 3 s, <= 90 s,
frames every 2 s at 1280 px + contact sheets in <build>/qa/."""
import json, pathlib, re, shutil, subprocess, sys
B = pathlib.Path(sys.argv[1]); OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else B / "bijlilog-demo.mp4"
story = json.load(open(pathlib.Path(__file__).with_name("story.json"))); dur = json.load(open(B / "durations.json"))
PAD, LEAD = 0.30, 0.10
def run(*a, **k): return subprocess.run(a, check=True, capture_output=True, text=True, **k)
seg = B / "seg"; shutil.rmtree(seg, ignore_errors=True); seg.mkdir()
vids, auds = [], []
for ln in story["lines"]:
    i = ln["id"]; total = dur[i] + PAD
    ss = json.load(open(B / "clips" / f"{i}.json"))["ss"]
    v = seg / f"{i}.mp4"
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{ss:.2f}", "-i", str(B / "clips" / f"{i}.webm"),
        "-t", f"{total:.3f}", "-vf", f"scale=3840:2160:flags=lanczos,fps=30,tpad=stop_mode=clone:stop_duration=2,zoompan=z='1+0.04*on/{int(total*30)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30", "-t", f"{total:.3f}",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", str(v))
    a = seg / f"{i}.wav"
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(B / "audio" / f"{i}.wav"), "-af",
        f"adelay={int(LEAD*1000)}:all=1,apad=whole_dur={total:.3f}", "-ar", "48000", "-ac", "1", str(a))
    vids.append(v); auds.append(a)
def concat(files, out, *extra):
    lst = seg / (out.stem + ".txt"); lst.write_text("".join(f"file '{f.resolve()}'\n" for f in files))
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), *extra, str(out))
concat(vids, seg / "video.mp4", "-c", "copy"); concat(auds, seg / "audio.wav", "-c", "copy")
# two-pass loudnorm to -14 LUFS, TP -1.5
m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(seg / "audio.wav"), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr).group(0))
af = f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(seg / "video.mp4"), "-i", str(seg / "audio.wav"), "-af", af, "-ar", "48000",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(OUT))

# ---------------- QA ----------------
def ff(flag, f): return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(OUT), flag, f, "-f", "null", "-"], capture_output=True, text=True).stderr
d = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(OUT)).stdout)
wh = run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(OUT)).stdout.strip()
r = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", ff("-af", "loudnorm=I=-14:TP=-1.5:print_format=json")).group(0))
issues = []
lufs, tp = float(r["input_i"]), float(r["input_tp"])
if wh != "1920,1080": issues.append(f"resolution {wh}")
if abs(lufs + 14) > 1: issues.append(f"loudness {lufs} LUFS")
if tp > -1.0: issues.append(f"true peak {tp} dBTP")
if d > 90: issues.append(f"length {d:.1f}s > 90")
if d < 60: issues.append(f"length {d:.1f}s < 60")
sil = [(float(s), float(e)) for s, e in re.findall(r"silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)", ff("-af", "silencedetect=noise=-45dB:d=0.6"))]
sil = [(s, round(e - s, 2)) for s, e in sil]
if sil: issues.append(f"silence > 0.6 s at {sil}")
fr = re.findall(r"freeze_start: ([\d.]+)[\s\S]*?freeze_duration: ([\d.]+)", ff("-vf", "freezedetect=n=0.002:d=3"))
if fr: issues.append(f"frozen hold > 3 s at {fr}")
qa = B / "qa"; shutil.rmtree(qa, ignore_errors=True); (qa / "frames").mkdir(parents=True)
run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(OUT), "-vf", "fps=1/2,scale=1280:-1", str(qa / "frames" / "f%03d.png"))
n = len(list((qa / "frames").glob("*.png")))
for k in range(0, n, 9):
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-start_number", str(k + 1), "-i", str(qa / "frames" / "f%03d.png"), "-frames:v", "1", "-update", "1",
        "-vf", "scale=640:-1,tile=3x3", str(qa / f"sheet{k // 9 + 1}.png"))
res = {"duration_s": round(d, 1), "size": wh, "lufs": lufs, "true_peak_dbtp": tp, "silences_over_0.6s": sil, "freezes": fr, "frames_2s": n, "issues": issues}
json.dump(res, open(qa / "qa.json", "w"), indent=1); print(json.dumps(res, indent=1)); sys.exit(1 if issues else 0)

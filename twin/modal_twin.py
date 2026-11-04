"""Quarry digital twin reconstruction on Modal.

Stages, each saving to the `carraizo-twin` volume (credentials come from .env):
    modal run --detach twin/modal_twin.py::sparse_full   # cameras + sparse points
    modal run --detach twin/modal_twin.py::dense         # dense point cloud
    modal run --detach twin/modal_twin.py::terrain       # local-metre DSM, DTM, mesh

Add --smoke to `dense` to test it on the 60-frame smoke model first.
"""

import json
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import modal

HERE = Path(__file__).parent
SEGMENTS = json.loads((HERE / "segments.json").read_text())

app = modal.App("carraizo-twin")
volume = modal.Volume.from_name("carraizo-twin")
VOL = Path("/vol")

# Local east-north origin for every output, near the middle of the site.
ORIGIN_LAT, ORIGIN_LON = 18.332, -66.019

# Solved from the smoke run and confirmed by the pilot (1416 px).
CAMERA_PARAMS = "1420,960,540,0.08,-0.09"

# Terrain holes are interpolated only this close to measured ground.
MAX_FILL_M = 15.0

# Single-GPU stereo containers running at once: the account's GPUs are shared.
DENSE_WORKERS = 10

image = (
    modal.Image.from_registry("colmap/colmap:latest", add_python="3.11")
    .apt_install("ffmpeg")
    .pip_install("numpy", "pillow", "scipy")
    .add_local_file(HERE / "segments.json", "/root/segments.json")
)


def sh(*args, cwd=None):
    """Run a command, streaming its output, and fail loudly on error."""
    args = [str(a) for a in args]
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True, cwd=cwd)


def extract_frames(stage, images, masks=None, limit=None):
    """Extract 1 fps frames, optionally with top-connected sky masks for COLMAP."""
    import numpy as np
    from PIL import Image

    images.mkdir(parents=True, exist_ok=True)
    if masks:
        masks.mkdir(parents=True, exist_ok=True)
    for name, spec in SEGMENTS["videos"].items():
        for start, end in spec[stage]:
            tmp = images.parent / "tmp"
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir()
            sh(
                "ffmpeg", "-v", "error", "-y",
                "-ss", start, "-to", end + 1,
                "-i", VOL / "raw" / f"{name}.MP4",
                "-vf", "fps=1", "-q:v", "2", tmp / "%05d.jpg",
            )
            for i, frame in enumerate(sorted(tmp.glob("*.jpg"))):
                target = images / f"{name}_t{start + i:05d}.jpg"
                frame.rename(target)
                if not masks:
                    continue
                small = np.asarray(
                    Image.open(target).convert("RGB").resize((480, 270)),
                    dtype=np.float32,
                )
                r, b = small[..., 0], small[..., 2]
                grey = small.mean(2)
                sky = ((b > r + 8) & (b > 120)) | (grey > 200)
                # Only sky touching the top edge: pale rock lower down survives.
                sky = np.minimum.accumulate(sky, axis=0)
                keep = Image.fromarray(np.uint8(~sky) * 255).resize(
                    (1920, 1080), Image.NEAREST
                )
                keep.save(masks / f"{target.name}.png")
            shutil.rmtree(tmp)
    if limit:
        for frame in sorted(images.glob("*.jpg"))[limit:]:
            frame.unlink()
            if masks:
                (masks / f"{frame.name}.png").unlink()


def parse_telemetry(name):
    """Per-second (lon, lat, height above takeoff) from the video's subtitle track."""
    text = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", VOL / "raw" / f"{name}.MP4",
         "-map", "0:s:0", "-f", "srt", "-"],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = {}
    second = 0
    for line in text.splitlines():
        if "GPS (" not in line:
            continue
        gps = re.search(r"GPS \(([-\d.]+), ([-\d.]+),", line)
        height = re.search(r" H ([-\d.]+)m", line)
        if gps and height:
            rows[second] = (float(gps[1]), float(gps[2]), float(height[1]))
        second += 1
    return rows


def read_model(model_dir, txt_dir):
    """Return camera centres by image name, plus points, colours, errors, track lengths."""
    import numpy as np

    txt_dir.mkdir(parents=True, exist_ok=True)
    sh("colmap", "model_converter", "--input_path", model_dir,
       "--output_path", txt_dir, "--output_type", "TXT")
    centres = {}
    lines = [
        l for l in (txt_dir / "images.txt").read_text().splitlines()
        if not l.startswith("#")
    ]
    for line in lines[::2]:
        p = line.split()
        qw, qx, qy, qz = map(float, p[1:5])
        t = np.array(list(map(float, p[5:8])))
        R = np.array([
            [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw), 2*(qx*qz + qy*qw)],
            [2*(qx*qy + qz*qw), 1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
            [2*(qx*qz - qy*qw), 2*(qy*qz + qx*qw), 1 - 2*(qx*qx + qy*qy)],
        ])
        centres[p[9]] = -R.T @ t
    xyz, rgb, errors, tracks = [], [], [], []
    for line in (txt_dir / "points3D.txt").read_text().splitlines():
        if line.startswith("#"):
            continue
        p = line.split()
        xyz.append(list(map(float, p[1:4])))
        rgb.append(list(map(int, p[4:7])))
        errors.append(float(p[7]))
        tracks.append((len(p) - 8) // 2)
    return centres, np.array(xyz), np.array(rgb), np.array(errors), np.array(tracks)


def _umeyama(a, b):
    """Similarity transform (s, R, t) taking points a onto points b."""
    import numpy as np

    ma, mb = a.mean(0), b.mean(0)
    A, B = a - ma, b - mb
    U, D, Vt = np.linalg.svd(B.T @ A / len(a))
    S = np.diag([1, 1, np.sign(np.linalg.det(U) * np.linalg.det(Vt))])
    R = U @ S @ Vt
    s = np.trace(np.diag(D) @ S) / ((A**2).sum() / len(a))
    return s, R, mb - s * R @ ma


def fit_telemetry(centres):
    """Fit model -> local east/north/up metres from drone telemetry.

    GPS is rounded to about 10 m and heights are relative to each takeoff, so
    every flight gets its own height offset. Up = 0 at the first flight's takeoff.
    This is a telemetry scale, not a survey: control points come later.
    """
    import numpy as np

    telemetry = {}
    k = (111320 * np.cos(np.radians(ORIGIN_LAT)), 110574.0)
    src, dst, flights = [], [], []
    for image_name, c in sorted(centres.items()):
        m = re.match(r"(DJI_\d+)_t(\d+)\.jpg", image_name)
        telemetry.setdefault(m[1], parse_telemetry(m[1]))
        row = telemetry[m[1]].get(int(m[2]))
        if row:
            src.append(c)
            dst.append([(row[0] - ORIGIN_LON) * k[0], (row[1] - ORIGIN_LAT) * k[1], row[2]])
            flights.append(m[1])
    src, dst, flights = np.array(src), np.array(dst), np.array(flights)

    offsets = {f: 0.0 for f in set(flights.tolist())}
    for _ in range(30):
        target = dst.copy()
        for f, z in offsets.items():
            target[flights == f, 2] += z
        s, R, t = _umeyama(src, target)
        pred = s * (R @ src.T).T + t
        for f in offsets:
            mask = flights == f
            offsets[f] = float(np.median(pred[mask, 2] - dst[mask, 2]))

    first = sorted(offsets)[0]
    t = t - np.array([0, 0, offsets[first]])
    offsets = {f: z - offsets[first] for f, z in offsets.items()}
    target = dst.copy()
    for f, z in offsets.items():
        target[flights == f, 2] += z
    pred = s * (R @ src.T).T + t
    res = pred - target
    horizontal = np.linalg.norm(res[:, :2], axis=1)
    per_flight = {}
    for f in sorted(offsets):
        mask = flights == f
        own_s = _umeyama(src[mask], target[mask])[0]
        per_flight[f] = {
            "frames": int(mask.sum()),
            "takeoff_height_m": round(offsets[f], 2),
            "horizontal_median_m": round(float(np.median(horizontal[mask])), 2),
            "vertical_median_m": round(float(np.median(np.abs(res[mask, 2]))), 2),
            "own_scale": round(float(own_s), 3),
        }
    return {
        "origin_lat": ORIGIN_LAT,
        "origin_lon": ORIGIN_LON,
        "scale": float(s),
        "R": R.tolist(),
        "t": t.tolist(),
        "frames_with_gps": len(src),
        "horizontal_median_m": round(float(np.median(horizontal)), 2),
        "horizontal_p95_m": round(float(np.percentile(horizontal, 95)), 2),
        "vertical_median_m": round(float(np.median(np.abs(res[:, 2]))), 2),
        "vertical_p95_m": round(float(np.percentile(np.abs(res[:, 2]), 95)), 2),
        "flights": per_flight,
    }


def apply_fit(fit, xyz):
    import numpy as np

    return fit["scale"] * (np.array(fit["R"]) @ xyz.T).T + np.array(fit["t"])


def write_report(work, sparse, out):
    """Report every model found, and save the largest with its telemetry fit."""
    report = {"models": []}
    best_fit = None
    for model in sorted(p for p in sparse.iterdir() if p.is_dir()):
        centres, xyz, _, errors, tracks = read_model(model, work / "txt" / model.name)
        per_video = {}
        for name in centres:
            video = name.split("_t")[0]
            per_video[video] = per_video.get(video, 0) + 1
        entry = {
            "model": model.name,
            "registered": len(centres),
            "per_video": per_video,
            "points": len(xyz),
            "reprojection_mean_px": round(float(errors.mean()), 3),
            "track_length_median": int(sorted(tracks)[len(tracks) // 2]),
        }
        if len(centres) > 50:
            entry["telemetry"] = fit_telemetry(centres)
            if best_fit is None or len(centres) > best_fit[0]:
                best_fit = (len(centres), entry["telemetry"], model.name)
        report["models"].append(entry)
    report["models"].sort(key=lambda m: -m["registered"])
    summary = json.loads(json.dumps(report))
    for model in summary["models"]:
        for key in ("R", "t"):
            model.get("telemetry", {}).pop(key, None)
    print(json.dumps(summary, indent=2), flush=True)
    shutil.copytree(sparse, out / "sparse", dirs_exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    (out / "alignment.json").write_text(json.dumps({**best_fit[1], "model": best_fit[2]}, indent=2))
    sh("colmap", "model_converter", "--input_path", sparse / best_fit[2],
       "--output_path", out / "sparse.ply", "--output_type", "PLY")
    volume.commit()
    return summary


def run_sparse(stage, out, seed_database=None, limit=None):
    work = Path(f"/tmp/{out.name}")
    images, masks = work / "images", work / "masks"
    database, sparse = work / "database.db", work / "sparse"
    out.mkdir(exist_ok=True)

    extract_frames(stage, images, masks, limit)
    print("frames", len(list(images.glob("*.jpg"))), flush=True)

    camera = ["--ImageReader.single_camera", 1]
    if seed_database:
        # Matches are reused: only new images and new pairs get computed.
        shutil.copy(seed_database, database)
        camera = ["--ImageReader.existing_camera_id", 1]
    sh("colmap", "feature_extractor",
       "--database_path", database, "--image_path", images,
       "--ImageReader.mask_path", masks,
       *camera,
       "--ImageReader.camera_model", "RADIAL",
       "--ImageReader.camera_params", CAMERA_PARAMS,
       "--FeatureExtraction.use_gpu", 1,
       "--SiftExtraction.max_num_features", 8192)
    sh("colmap", "exhaustive_matcher", "--database_path", database,
       "--FeatureMatching.use_gpu", 1)
    shutil.copy(database, out / "database.db")
    volume.commit()

    sparse.mkdir()
    # Global mapping: incremental `mapper` was already taking 45 s per
    # adjustment at 53 images. Ceres has no GPU support in this image, so this runs on CPU.
    sh("colmap", "global_mapper",
       "--database_path", database, "--image_path", images,
       "--output_path", sparse,
       "--GlobalMapper.num_threads", 16)
    return write_report(work, sparse, out)


@app.function(image=image, gpu="A10G", cpu=16, memory=65536,
              volumes={VOL: volume}, timeout=6 * 3600)
def pilot(smoke: bool = False):
    """Do DJI_0002 and DJI_0004 align into one model? Sparse only, at 1 fps."""
    return run_sparse("pilot", VOL / ("pilot_smoke" if smoke else "pilot"),
                      limit=60 if smoke else None)


@app.function(image=image, gpu="A10G", cpu=16, memory=131072,
              volumes={VOL: volume}, timeout=20 * 3600)
def sparse_full():
    """All usable footage, reusing the pilot's features and matches."""
    return run_sparse("full", VOL / "full", seed_database=VOL / "pilot" / "database.db")


def stereo_names(workspace):
    """Reference image names, in the order COLMAP's patch-match.cfg lists them."""
    lines = (workspace / "stereo" / "patch-match.cfg").read_text().splitlines()
    return [line.strip() for line in lines[::2] if line.strip()]


def stereo_done(workspace, name, kind):
    stereo = workspace / "stereo"
    return all(
        (stereo / folder / f"{name}.{kind}.bin").exists()
        for folder in ("depth_maps", "normal_maps")
    )


def copy_once(source, target, marker, pattern="*"):
    """Fill a container's local cache once, so warm containers skip the copy."""
    flag = target.parent / f".{marker}"
    if flag.exists():
        return
    target.mkdir(parents=True, exist_ok=True)
    paths = [path for path in source.glob(pattern) if path.is_file()]
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda path: shutil.copy(path, target / path.name), paths))
    flag.touch()


@app.function(image=image, cpu=8, memory=32768, volumes={VOL: volume},
              timeout=2 * 3600)
def dense_prepare(smoke: bool = False, ws: str = "dense_ws"):
    """Undistort the frames once and save the workspace the stereo workers share."""
    src = VOL / ("pilot_smoke" if smoke else "full")
    shared = src / ws
    if (shared / "ready").exists():
        return
    work = Path("/tmp/dense")
    alignment = json.loads((src / "alignment.json").read_text()) if (src / "alignment.json").exists() else None
    model = src / "sparse" / (alignment["model"] if alignment else "0")
    extract_frames("pilot" if smoke else "full", work / "images",
                   limit=60 if smoke else None)
    workspace = work / "workspace"
    sh("colmap", "image_undistorter",
       "--image_path", work / "images", "--input_path", model,
       "--output_path", workspace, "--output_type", "COLMAP")
    shutil.rmtree(shared, ignore_errors=True)
    shutil.copytree(workspace, shared)
    (shared / "ready").touch()
    volume.commit()


@app.function(image=image, gpu="A10G", cpu=8, memory=65536, volumes={VOL: volume},
              timeout=2 * 3600, max_containers=DENSE_WORKERS,
              retries=modal.Retries(max_retries=2, initial_delay=30.0))
def stereo_chunk(names, src_dir, geometric, ws="dense_ws", sources=20):
    """Run one stereo pass on a batch of views and save them to the volume.

    The geometric pass needs every view's photometric depth and normal maps, so
    all photometric batches must finish first.
    """
    volume.reload()
    kind = "geometric" if geometric else "photometric"
    shared = Path(src_dir) / ws
    local = Path("/tmp/ws")
    todo = [n for n in names if not stereo_done(shared, n, kind)]
    if not todo:
        return 0

    copy_once(shared / "images", local / "images", "images")
    copy_once(shared / "sparse", local / "sparse", "sparse")
    stereo = local / "stereo"
    for folder in ("depth_maps", "normal_maps", "consistency_graphs"):
        (stereo / folder).mkdir(parents=True, exist_ok=True)
    if geometric:
        # Each view reads its neighbours' maps, so link all of them from the
        # volume: COLMAP then loads only what it needs instead of ~40 GB up front.
        for folder in ("depth_maps", "normal_maps"):
            for path in (shared / "stereo" / folder).glob("*.photometric.bin"):
                link = stereo / folder / path.name
                if not link.exists():
                    link.symlink_to(path)
    (stereo / "patch-match.cfg").write_text(
        "".join(f"{name}\n__auto__, {sources}\n" for name in todo)
    )
    sh("colmap", "patch_match_stereo",
       "--workspace_path", local, "--workspace_format", "COLMAP",
       "--PatchMatchStereo.geom_consistency", "true" if geometric else "false",
       "--PatchMatchStereo.filter", "true" if geometric else "false",
       "--PatchMatchStereo.gpu_index", "0")
    for name in todo:
        for folder in ("depth_maps", "normal_maps"):
            shutil.copy(stereo / folder / f"{name}.{kind}.bin",
                        shared / "stereo" / folder)
    volume.commit()
    return len(todo)


@app.function(image=image, cpu=32, memory=262144, volumes={VOL: volume},
              timeout=6 * 3600)
def dense_fuse(smoke: bool = False, ws: str = "dense_ws", kind: str = "geometric"):
    """Merge every view's depth maps into one point cloud.

    kind="photometric" gives a rougher early cloud, saved apart from fused.ply so
    the terrain stage never reads it.
    """
    volume.reload()
    src = VOL / ("pilot_smoke" if smoke else "full")
    shared = src / ws
    local = Path("/tmp/ws")
    copy_once(shared / "images", local / "images", "images")
    copy_once(shared / "sparse", local / "sparse", "sparse")
    stereo = local / "stereo"
    (stereo / "consistency_graphs").mkdir(parents=True, exist_ok=True)
    for folder in ("depth_maps", "normal_maps"):
        copy_once(shared / "stereo" / folder, stereo / folder,
                  f"{kind}_{folder}", f"*.{kind}.bin")
    shutil.copy(shared / "stereo" / "fusion.cfg", stereo)
    fused = Path("/tmp/fused.ply")
    sh("colmap", "stereo_fusion",
       "--workspace_path", local, "--workspace_format", "COLMAP",
       "--input_type", kind, "--output_path", fused,
       "--StereoFusion.num_threads", 32,
       "--StereoFusion.cache_size", 128)
    # The serial smoke result stays in fused.ply as the baseline to compare with.
    if kind != "geometric":
        output = src / f"fused_{kind}.ply"
    else:
        output = src / (f"fused_{ws}.ply" if smoke else "fused.ply")
    shutil.copy(fused, output)
    volume.commit()
    size = output.stat().st_size
    print("fused bytes", size, flush=True)
    return size


@app.function(image=image, cpu=2, memory=8192, volumes={VOL: volume},
              timeout=24 * 3600)
def dense(smoke: bool = False, sources: int = 20, ws: str = "dense_ws"):
    """Dense point cloud: GPU stereo in batches across workers, then CPU fusion.

    Each COLMAP process spends minutes on one CPU core reloading the model and
    choosing neighbouring views before its GPU starts, so each pass is split into
    one batch per worker. A rerun skips views already saved.
    Moving machinery and people are not masked here: they fail the multi-view
    consistency checks in stereo and fusion, and the terrain stage drops leftovers.
    """
    src = VOL / ("pilot_smoke" if smoke else "full")
    shared = src / ws
    if not (shared / "ready").exists():
        dense_prepare.remote(smoke, ws)
    volume.reload()
    names = stereo_names(shared)
    for geometric in (False, True):
        kind = "geometric" if geometric else "photometric"
        volume.reload()
        todo = [n for n in names if not stereo_done(shared, n, kind)]
        chunk = max(1, -(-len(todo) // DENSE_WORKERS))
        batches = [todo[i:i + chunk] for i in range(0, len(todo), chunk)]
        print(f"{kind}: {len(todo)} of {len(names)} views in {len(batches)} batches",
              flush=True)
        finished = 0
        results = stereo_chunk.map(
            batches,
            kwargs={"src_dir": str(src), "geometric": geometric, "ws": ws, "sources": sources},
            order_outputs=False, return_exceptions=True,
        ) if batches else []
        for result in results:
            if isinstance(result, Exception):
                print("batch failed:", repr(result), flush=True)
            else:
                finished += result
                print(f"{kind}: {finished} of {len(todo)} views done", flush=True)
        volume.reload()
        missing = [n for n in names if not stereo_done(shared, n, kind)]
        if missing:
            raise RuntimeError(f"{kind}: {len(missing)} views missing, rerun to resume")
    return dense_fuse.remote(smoke, ws)


def read_fused(path):
    """COLMAP's fused PLY: binary little-endian xyz, normal, rgb."""
    import numpy as np

    with open(path, "rb") as f:
        count = None
        while True:
            line = f.readline().decode().strip()
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            if line == "end_header":
                break
        dtype = np.dtype([
            ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
            ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
            ("r", "u1"), ("g", "u1"), ("b", "u1"),
        ])
        data = np.fromfile(f, dtype=dtype, count=count)
    xyz = np.c_[data["x"], data["y"], data["z"]].astype(np.float64)
    rgb = np.c_[data["r"], data["g"], data["b"]]
    return xyz, rgb


def write_grid_mesh(path, grid, x0, y0, cell, valid):
    """Binary PLY mesh of a regular height grid; only fully valid quads."""
    import numpy as np

    rows, cols = grid.shape
    index = -np.ones(grid.shape, dtype=np.int64)
    index[valid] = np.arange(valid.sum())
    jj, ii = np.nonzero(valid)
    vertices = np.c_[x0 + ii * cell, y0 + jj * cell, grid[valid]].astype("<f4")
    a, b = index[:-1, :-1], index[:-1, 1:]
    c, d = index[1:, :-1], index[1:, 1:]
    quad = (a >= 0) & (b >= 0) & (c >= 0) & (d >= 0)
    faces = np.r_[
        np.c_[a[quad], b[quad], d[quad]],
        np.c_[a[quad], d[quad], c[quad]],
    ].astype("<i4")
    records = np.empty(len(faces), dtype=[("n", "u1"), ("v", "<i4", (3,))])
    records["n"] = 3
    records["v"] = faces
    with open(path, "wb") as f:
        f.write((
            "ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(vertices)}\n"
            "property float x\nproperty float y\nproperty float z\n"
            f"element face {len(faces)}\n"
            "property list uchar int vertex_indices\nend_header\n"
        ).encode())
        vertices.tofile(f)
        records.tofile(f)
    return len(vertices), len(faces)


@app.function(image=image, cpu=16, memory=131072,
              volumes={VOL: volume}, timeout=4 * 3600)
def terrain(smoke: bool = False, cell: float = 0.5):
    """Local-metre DSM, bare-ground DTM, mesh, orthomosaic and previews.

    Vegetation is classified by colour and interpolated across for short
    distances. Filled cells are recorded in `filled`, so they can never pass for
    measured rock.
    """
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    from scipy.interpolate import LinearNDInterpolator as interpolate_linear

    src = VOL / ("pilot_smoke" if smoke else "full")
    out = src / "terrain"
    out.mkdir(exist_ok=True)
    fit = json.loads((src / "alignment.json").read_text()) if (src / "alignment.json").exists() else None
    if fit is None:
        work = Path("/tmp/fit")
        centres, *_ = read_model(src / "sparse" / "0", work)
        fit = fit_telemetry(centres)
    xyz, rgb = read_fused(src / "fused.ply")
    enu = apply_fit(fit, xyz)
    print("dense points", len(enu), flush=True)

    # Crop far-away noise using the camera-covered bulk of the cloud.
    lo, hi = np.percentile(enu, [0.5, 99.5], axis=0)
    keep = np.all((enu >= lo - 20) & (enu <= hi + 20), axis=1)
    enu, rgb = enu[keep], rgb[keep]
    x0, y0 = np.floor(enu[:, :2].min(0))
    ii = ((enu[:, 0] - x0) / cell).astype(np.int64)
    jj = ((enu[:, 1] - y0) / cell).astype(np.int64)
    rows, cols = jj.max() + 1, ii.max() + 1
    cells = jj * cols + ii

    # Stray sky on the horizon: clearly saturated blue, unlike blue-grey rock.
    rgbf = rgb.astype(np.float32)
    total = rgbf.sum(1) + 1e-3
    sky = ((rgbf[:, 2] - rgbf[:, 0]) / total > 0.15) & (rgbf[:, 2] > 120)
    enu, rgb, rgbf, total, ii, jj, cells = (
        enu[~sky], rgb[~sky], rgbf[~sky], total[~sky], ii[~sky], jj[~sky], cells[~sky])
    excess_green = (2 * rgbf[:, 1] - rgbf[:, 0] - rgbf[:, 2]) / total
    vegetation = excess_green > 0.05

    def cell_stat(mask, q):
        """Height percentile per cell, ignoring cells with under 2 points."""
        order = np.lexsort((enu[mask, 2], cells[mask]))
        sorted_cells = cells[mask][order]
        sorted_z = enu[mask, 2][order]
        unique, first, counts = np.unique(sorted_cells, return_index=True, return_counts=True)
        grid = np.full(rows * cols, np.nan, dtype=np.float32)
        ok = counts >= 2
        picks = first[ok] + (counts[ok] * q).astype(np.int64)
        grid[unique[ok]] = sorted_z[picks]
        return grid.reshape(rows, cols)

    everything = np.ones(len(enu), bool)
    dsm = cell_stat(everything, 0.5)
    ground = cell_stat(~vegetation, 0.25)

    # Reject spikes against a local median, never against a global fill value.
    measured = np.isfinite(ground)
    nearest = ndimage.distance_transform_edt(
        ~measured, return_distances=False, return_indices=True)
    local = ndimage.median_filter(ground[nearest[0], nearest[1]], size=9)
    ground[measured & (np.abs(ground - local) > 5)] = np.nan
    measured = np.isfinite(ground)

    # Fill only near measured ground. Wider gaps stay empty rather than invented.
    distance = ndimage.distance_transform_edt(~measured) * cell
    site = distance <= MAX_FILL_M
    filled = site & ~measured
    dtm_site = ground.copy()
    interpolate = interpolate_linear(np.argwhere(measured), ground[measured])
    dtm_site[filled] = interpolate(np.argwhere(filled))
    filled &= np.isfinite(dtm_site)
    site = measured | filled

    ortho = np.zeros((rows, cols, 3), np.uint8)
    top = np.argsort(enu[:, 2])
    ortho[jj[top], ii[top]] = rgb[top]

    np.savez_compressed(
        out / "grids.npz", dsm=dsm, dtm=dtm_site, filled=filled, ortho=ortho,
        cell=cell, x0=x0, y0=y0,
    )
    for name, grid in (("dsm", dsm), ("dtm", dtm_site), ("filled", filled.astype(float))):
        with open(out / f"{name}.asc", "w") as f:
            f.write(f"ncols {cols}\nnrows {rows}\nxllcorner {x0}\nyllcorner {y0}\n"
                    f"cellsize {cell}\nNODATA_value -9999\n")
            np.savetxt(f, np.nan_to_num(grid[::-1], nan=-9999), fmt="%.2f")
    vertices, faces = write_grid_mesh(out / "dtm_mesh.ply", np.nan_to_num(dtm_site), x0, y0, cell, site)

    Image.fromarray(ortho[::-1]).save(out / "ortho.png")
    grad_y, grad_x = np.gradient(np.nan_to_num(dtm_site, nan=np.nanmedian(dtm_site)), cell)
    shade = np.clip(0.55 + 0.45 * (grad_x * 0.7 - grad_y * 0.7) / np.hypot(1, np.hypot(grad_x, grad_y)), 0, 1)
    shade[~site] = 1
    Image.fromarray(np.uint8(shade[::-1] * 255)).save(out / "dtm_hillshade.png")

    stats = {
        "dense_points": int(len(enu)),
        "vegetation_points_fraction": round(float(vegetation.mean()), 3),
        "cell_m": cell,
        "grid": [int(rows), int(cols)],
        "extent_m": [round(float(cols * cell), 1), round(float(rows * cell), 1)],
        "height_range_m": [round(float(np.nanmin(dtm_site)), 1), round(float(np.nanmax(dtm_site)), 1)],
        "site_cells_filled_fraction": round(float(filled.sum() / site.sum()), 3),
        "mesh_vertices": int(vertices),
        "mesh_faces": int(faces),
    }
    print(json.dumps(stats, indent=2), flush=True)
    (out / "stats.json").write_text(json.dumps(stats, indent=2))
    volume.commit()
    return stats


@app.function(image=image, cpu=8, memory=65536, volumes={VOL: volume}, timeout=1800)
def preview_points(source: str = "pilot", budget: int = 200000,
                   cloud: str = "fused.ply", name: str = ""):
    """Small coloured point file for the browser preview: 3x int16 (2 cm) + RGB."""
    import numpy as np

    src = VOL / source
    fit = json.loads((src / "alignment.json").read_text()) if (src / "alignment.json").exists() else None
    if (src / cloud).exists():
        xyz, rgb = read_fused(src / cloud)
        model = fit["model"] if fit else "0"
        centres, *_ = read_model(src / "sparse" / model, Path("/tmp/preview"))
    else:
        centres, xyz, rgb, errors, tracks = read_model(src / "sparse" / "0", Path("/tmp/preview"))
        good = (errors < 2) & (tracks >= 3)
        xyz, rgb = xyz[good], rgb[good]
    if fit is None:
        fit = fit_telemetry(centres)
    enu = apply_fit(fit, xyz)
    lo, hi = np.percentile(enu, [1, 99], axis=0)
    keep = np.all((enu >= lo - 15) & (enu <= hi + 15), axis=1)
    enu, rgb = enu[keep], rgb[keep]
    rng = np.random.default_rng(0)
    if len(enu) > budget:
        pick = rng.choice(len(enu), budget, replace=False)
        enu, rgb = enu[pick], rgb[pick]
    centre = enu.mean(0)
    points = np.empty(len(enu), dtype=[("p", "<i2", (3,)), ("c", "u1", (3,))])
    points["p"] = np.round((enu - centre) / 0.02).clip(-32767, 32767)
    points["c"] = rgb
    target = VOL / "preview"
    target.mkdir(exist_ok=True)
    stem = name or source
    (target / f"{stem}.bin").write_bytes(points.tobytes())
    paths = {}
    names = sorted(centres)
    positions = apply_fit(fit, np.array([centres[n] for n in names])) - centre
    for name, position in zip(names, positions):
        paths.setdefault(name.split("_t")[0], []).append(np.round(position, 1).tolist())
    (target / f"{stem}.json").write_text(json.dumps({
        "points": len(enu),
        "extent_m": np.round(enu.max(0) - enu.min(0), 0).tolist(),
        "scale": fit["scale"],
        "paths": paths,
    }))
    volume.commit()
    print(len(enu), "points", flush=True)

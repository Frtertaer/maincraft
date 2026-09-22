from __future__ import annotations

import argparse
import base64
import io
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


BASE_URL = "https://api.cheat-ai.shop"
MODEL = "claude-opus-4-8"
KEY_FILE = Path(r"C:\Users\user\Desktop\Текстовый документ (2).txt")
VERSION = "2023-06-01"
ROOT = Path(__file__).resolve().parent
ASSET_DIR = ROOT / "vision_assets"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = ["arialbd.ttf", "segoeuib.ttf"] if bold else ["arial.ttf", "segoeui.ttf"]
    for name in names:
        path = Path(r"C:\Windows\Fonts") / name
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def centered(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str, fnt: Any, fill: str) -> None:
    left, top, right, bottom = box
    bounds = draw.textbbox((0, 0), text, font=fnt)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    draw.text(
        (left + (right - left - width) / 2, top + (bottom - top - height) / 2 - bounds[1]),
        text,
        font=fnt,
        fill=fill,
    )


def star_points(cx: float, cy: float, outer: float, inner: float) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for i in range(10):
        angle = -math.pi / 2 + i * math.pi / 5
        radius = outer if i % 2 == 0 else inner
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return points


def draw_shape(
    draw: ImageDraw.ImageDraw,
    kind: str,
    color: str,
    center: tuple[int, int],
    size: int,
) -> None:
    x, y = center
    half = size // 2
    if kind == "square":
        draw.rectangle((x - half, y - half, x + half, y + half), fill=color, outline="black", width=3)
    elif kind == "circle":
        draw.ellipse((x - half, y - half, x + half, y + half), fill=color, outline="black", width=3)
    elif kind == "triangle":
        draw.polygon([(x, y - half), (x - half, y + half), (x + half, y + half)], fill=color, outline="black")
    elif kind == "diamond":
        draw.polygon([(x, y - half), (x - half, y), (x, y + half), (x + half, y)], fill=color, outline="black")


def save_clean(image: Image.Image, path: Path, fmt: str, **kwargs: Any) -> None:
    image.save(path, format=fmt, **kwargs)


def generate_dashboard() -> tuple[Path, dict[str, Any]]:
    image = Image.new("RGB", (1800, 1200), "white")
    draw = ImageDraw.Draw(image)
    draw.text((50, 25), "VISION BENCH 8472", font=font(64, True), fill="#111827")
    draw.text((50, 105), "SHAPE GRID", font=font(32, True), fill="#374151")
    grid_x, grid_y, cell = 50, 155, 175
    for i in range(4):
        draw.line((grid_x + i * cell, grid_y, grid_x + i * cell, grid_y + 3 * cell), fill="#9ca3af", width=2)
        draw.line((grid_x, grid_y + i * cell, grid_x + 3 * cell, grid_y + i * cell), fill="#9ca3af", width=2)
    shapes = [
        ("square", "#ef4444"), ("circle", "#3b82f6"), ("diamond", "#eab308"),
        ("circle", "#f97316"), ("triangle", "#22c55e"), ("square", "#a855f7"),
        ("diamond", "#06b6d4"), ("circle", "#111827"), ("triangle", "#ec4899"),
    ]
    for idx, (kind, color) in enumerate(shapes):
        row, col = divmod(idx, 3)
        draw_shape(
            draw,
            kind,
            color,
            (grid_x + col * cell + cell // 2, grid_y + row * cell + cell // 2),
            90,
        )

    chart_x, chart_y = 700, 155
    draw.text((chart_x, 105), "BAR CHART", font=font(32, True), fill="#374151")
    draw.line((chart_x, chart_y, chart_x, chart_y + 430), fill="black", width=3)
    draw.line((chart_x, chart_y + 430, chart_x + 520, chart_y + 430), fill="black", width=3)
    for tick in range(0, 11, 2):
        y = chart_y + 430 - tick * 38
        draw.line((chart_x - 8, y, chart_x + 520, y), fill="#e5e7eb", width=1)
        draw.text((chart_x - 42, y - 13), str(tick), font=font(22), fill="#374151")
    bar_values = {"A": 3, "B": 7, "C": 5, "D": 9}
    colors = ["#60a5fa", "#34d399", "#fbbf24", "#f87171"]
    for index, (label, value) in enumerate(bar_values.items()):
        x0 = chart_x + 55 + index * 115
        y0 = chart_y + 430 - value * 38
        draw.rectangle((x0, y0, x0 + 70, chart_y + 430), fill=colors[index], outline="black", width=2)
        draw.text((x0 + 24, chart_y + 440), label, font=font(28, True), fill="black")

    table_x, table_y = 1280, 160
    draw.text((table_x, 105), "TABLE", font=font(32, True), fill="#374151")
    rows = [("Animal", "Value"), ("Finch", "12"), ("Otter", "27"), ("Lynx", "41")]
    row_h, col_w = 78, 210
    for row, values in enumerate(rows):
        for col, value in enumerate(values):
            box = (table_x + col * col_w, table_y + row * row_h, table_x + (col + 1) * col_w, table_y + (row + 1) * row_h)
            draw.rectangle(box, fill="#dbeafe" if row == 0 else "white", outline="#374151", width=2)
            centered(draw, box, value, font(28, row == 0), "#111827")

    draw.text((690, 680), "COUNT THE STARS", font=font(32, True), fill="#374151")
    for index in range(13):
        row, col = divmod(index, 7)
        draw.polygon(star_points(750 + col * 105, 780 + row * 125, 37, 17), fill="#f59e0b", outline="#92400e")

    draw.text((1335, 1060), "MICRO-Q7Z19", font=font(20), fill="#4b5563")
    path = ASSET_DIR / "dashboard.png"
    save_clean(image, path, "PNG", optimize=True)
    gold = {
        "title": "VISION BENCH 8472",
        "micro": "MICRO-Q7Z19",
        "upper_left": "red square",
        "center": "green triangle",
        "lower_right": "pink triangle",
        "below_blue": "green triangle",
        "tallest_bar": "D",
        "bar_b": 7,
        "otter_value": 27,
        "star_count": 13,
    }
    return path, gold


def generate_tiny() -> tuple[Path, dict[str, str]]:
    image = Image.new("RGB", (2520, 1400), "#f8fafc")
    draw = ImageDraw.Draw(image)
    draw.text((80, 50), "TINY TEXT TEST — read each code by row", font=font(52, True), fill="#0f172a")
    codes = ["A7K-92Q", "B4M-81R", "C9P-37X", "D2V-64N", "E8T-15Z"]
    sizes = [12, 16, 20, 24, 32]
    for index, (code, size) in enumerate(zip(codes, sizes, strict=True)):
        y = 250 + index * 210
        draw.rectangle((100, y - 45, 2400, y + 95), fill="white", outline="#cbd5e1", width=2)
        draw.text((130, y), f"ROW {index + 1}", font=font(30, True), fill="#64748b")
        draw.text((780, y + 12), code, font=font(size), fill="#334155")
    path = ASSET_DIR / "tiny_text.png"
    save_clean(image, path, "PNG", optimize=True)
    return path, {f"row{index + 1}": code for index, code in enumerate(codes)}


def generate_hard_ocr() -> tuple[Path, dict[str, Any]]:
    base = Image.new("RGB", (1600, 950), "#e7e5e4")
    draw = ImageDraw.Draw(base)
    codes = ["K8M-27A", "R4Q-91Z", "T7L-63P", "V2N-48C", "H9X-15B", "D3F-76W", "S6J-20Y", "P5G-84R"]
    draw.text((90, 40), "DEGRADED OCR", font=font(48, True), fill="#57534e")
    for index, code in enumerate(codes):
        x = 130 + (index % 2) * 750
        y = 170 + (index // 2) * 180
        draw.text((x, y), f"{index + 1}. {code}", font=font(38, True), fill="#5b5652")
    base = base.rotate(2.2, resample=Image.Resampling.BICUBIC, expand=False, fillcolor="#e7e5e4")
    base = base.filter(ImageFilter.GaussianBlur(0.65))
    base = ImageEnhance.Contrast(base).enhance(0.72)
    path = ASSET_DIR / "hard_ocr.jpg"
    save_clean(base, path, "JPEG", quality=70, optimize=True)
    return path, {"codes": codes}


def draw_panel(path: Path, label: str, red: int, blue: int, arrow: str) -> None:
    image = Image.new("RGB", (1200, 800), "white")
    draw = ImageDraw.Draw(image)
    draw.text((45, 30), f"PANEL {label}", font=font(56, True), fill="#111827")
    for index in range(red):
        row, col = divmod(index, 5)
        x, y = 100 + col * 130, 170 + row * 140
        draw.ellipse((x - 38, y - 38, x + 38, y + 38), fill="#ef4444", outline="black", width=2)
    for index in range(blue):
        row, col = divmod(index, 5)
        x, y = 760 + col * 80, 170 + row * 110
        draw.rectangle((x - 32, y - 32, x + 32, y + 32), fill="#3b82f6", outline="black", width=2)
    cx, cy = 600, 670
    if arrow == "east":
        draw.line((cx - 120, cy, cx + 100, cy), fill="#111827", width=16)
        draw.polygon([(cx + 100, cy), (cx + 45, cy - 45), (cx + 45, cy + 45)], fill="#111827")
    else:
        draw.line((cx, cy + 70, cx, cy - 110), fill="#111827", width=16)
        draw.polygon([(cx, cy - 110), (cx - 45, cy - 50), (cx + 45, cy - 50)], fill="#111827")
    save_clean(image, path, "PNG", optimize=True)


def generate_multi() -> tuple[list[Path], dict[str, Any]]:
    a = ASSET_DIR / "panel_a.png"
    b = ASSET_DIR / "panel_b.png"
    draw_panel(a, "A", 7, 3, "east")
    draw_panel(b, "B", 5, 6, "north")
    return [a, b], {
        "red_a": 7,
        "blue_a": 3,
        "red_b": 5,
        "blue_b": 6,
        "more_total": "B",
        "arrow_a": "east",
        "arrow_b": "north",
    }


def generate_parity() -> tuple[list[Path], str]:
    image = Image.new("RGB", (1000, 500), "#fef3c7")
    draw = ImageDraw.Draw(image)
    centered(draw, (0, 0, 1000, 500), "FORMAT-6R2K9", font(84, True), "#111827")
    paths = [
        ASSET_DIR / "parity.png",
        ASSET_DIR / "parity.jpg",
        ASSET_DIR / "parity.webp",
    ]
    save_clean(image, paths[0], "PNG", optimize=True)
    save_clean(image, paths[1], "JPEG", quality=85, optimize=True)
    save_clean(image, paths[2], "WEBP", quality=80, method=6)
    return paths, "FORMAT-6R2K9"


def image_block(path: Path) -> dict[str, Any]:
    media = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}[path.suffix.lower()]
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media,
            "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        },
    }


def object_schema(gold: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for key, value in gold.items():
        required.append(key)
        if isinstance(value, int):
            properties[key] = {"type": "integer"}
        elif isinstance(value, list):
            properties[key] = {"type": "array", "items": {"type": "string"}}
        else:
            properties[key] = {"type": "string"}
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def balanced_object(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(text[start : index + 1])
                    except ValueError:
                        return None
                    return value if isinstance(value, dict) else None
    return None


def normalize(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.lower().strip().replace("_", " ").split())
    return value


def fact_count(gold: dict[str, Any]) -> int:
    return sum(len(value) if isinstance(value, list) else 1 for value in gold.values())


def json_contract(gold: dict[str, Any]) -> str:
    fields: list[str] = []
    for key, value in gold.items():
        if isinstance(value, list):
            kind = f"array of exactly {len(value)} strings"
        elif isinstance(value, int):
            kind = "integer"
        else:
            kind = "string"
        fields.append(f'"{key}": {kind}')
    return (
        "\n\nReturn ONLY one valid JSON object, without Markdown or code fences. "
        "Use exactly these fields and value types: " + "; ".join(fields) + "."
    )


def score_object(gold: dict[str, Any], predicted: dict[str, Any] | None) -> tuple[int, int, dict[str, bool]]:
    checks: dict[str, bool] = {}
    for key, expected in gold.items():
        actual = predicted.get(key) if isinstance(predicted, dict) else None
        if isinstance(expected, list):
            for index, expected_item in enumerate(expected):
                actual_item = actual[index] if isinstance(actual, list) and index < len(actual) else None
                checks[f"{key}[{index}]"] = normalize(actual_item) == normalize(expected_item)
        else:
            checks[key] = normalize(actual) == normalize(expected)
    return sum(checks.values()), len(checks), checks


def load_key() -> str:
    for line in KEY_FILE.read_text(encoding="utf-8-sig").splitlines():
        candidate = line.strip()
        if candidate.startswith("sk-ant-") and len(candidate) >= 20:
            return candidate
    raise ValueError("No sk-ant key found")


def safe_whoami(session: requests.Session, key: str) -> dict[str, Any]:
    response = session.get(
        BASE_URL + "/v1/whoami",
        headers={"x-api-key": key, "anthropic-version": VERSION},
        allow_redirects=False,
        timeout=(15, 30),
    )
    try:
        data = response.json()
    except ValueError:
        data = {}
    return {
        "status": response.status_code,
        "tokens_remaining": (data.get("balance") or {}).get("tokens_remaining") if isinstance(data, dict) else None,
        "requests": (data.get("usage") or {}).get("requests") if isinstance(data, dict) else None,
        "tokens_used": (data.get("usage") or {}).get("tokens_used") if isinstance(data, dict) else None,
    }


def request_case(
    session: requests.Session,
    key: str,
    name: str,
    paths: list[Path],
    prompt: str,
    gold: dict[str, Any],
    stream: bool,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    for index, path in enumerate(paths):
        if len(paths) > 1:
            content.append({"type": "text", "text": f"Image {index + 1} follows."})
        content.append(image_block(path))
    content.append({"type": "text", "text": prompt + json_contract(gold)})
    payload = {
        "model": MODEL,
        "max_tokens": 512,
        "temperature": 0,
        "stream": stream,
        "messages": [{"role": "user", "content": content}],
        "output_config": {"format": {"type": "json_schema", "schema": object_schema(gold)}},
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": VERSION,
        "content-type": "application/json",
    }
    if stream:
        headers["accept"] = "text/event-stream"
    started = time.perf_counter()
    try:
        response = session.post(
            BASE_URL + "/v1/messages",
            headers=headers,
            json=payload,
            stream=stream,
            allow_redirects=False,
            timeout=(15, 300),
        )
    except requests.RequestException as exc:
        result = {
            "name": name,
            "mode": "stream" if stream else "nonstream",
            "status": None,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "network_error": type(exc).__name__,
            "response_model": None,
            "model_exact": False,
            "stop_reason": None,
            "strict_json": False,
            "extra_text": False,
            "score": 0,
            "total": fact_count(gold),
            "accuracy": 0.0,
            "checks": {key: False for key in gold},
            "usage": {},
            "event_types": [],
            "response_text_bytes": 0,
        }
        print(f"{name} {result['mode']} NETWORK_ERROR", flush=True)
        return result

    text = ""
    response_model = None
    stop_reason = None
    usage: dict[str, Any] = {}
    event_types: list[str] = []
    if stream and response.status_code == 200:
        response.encoding = "utf-8"
        pieces: list[str] = []
        for raw in response.iter_lines(decode_unicode=True):
            line = (raw or "").strip()
            if not line.startswith("data:"):
                continue
            value = line[5:].strip()
            try:
                event = json.loads(value)
            except ValueError:
                continue
            event_types.append(str(event.get("type")))
            if event.get("type") == "message_start" and isinstance(event.get("message"), dict):
                response_model = event["message"].get("model")
                if isinstance(event["message"].get("usage"), dict):
                    usage.update(event["message"]["usage"])
            delta = event.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                pieces.append(str(delta.get("text", "")))
            if event.get("type") == "message_delta":
                stop_reason = (event.get("delta") or {}).get("stop_reason") if isinstance(event.get("delta"), dict) else None
                if isinstance(event.get("usage"), dict):
                    usage.update(event["usage"])
        text = "".join(pieces)
        response.close()
    else:
        try:
            data = response.json()
        except ValueError:
            data = {}
        response_model = data.get("model") if isinstance(data, dict) else None
        stop_reason = data.get("stop_reason") if isinstance(data, dict) else None
        if isinstance(data, dict) and isinstance(data.get("usage"), dict):
            usage = data["usage"]
        blocks = data.get("content") if isinstance(data, dict) and isinstance(data.get("content"), list) else []
        text = "".join(
            str(block.get("text", ""))
            for block in blocks
            if isinstance(block, dict) and block.get("type") == "text"
        )
    try:
        direct_json = json.loads(text.strip())
    except ValueError:
        direct_json = None
    strict_json = isinstance(direct_json, dict)
    parsed = direct_json if strict_json else balanced_object(text)
    score, total, checks = score_object(gold, parsed)
    result = {
        "name": name,
        "mode": "stream" if stream else "nonstream",
        "status": response.status_code,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "response_model": response_model,
        "model_exact": response_model == MODEL,
        "stop_reason": stop_reason,
        "strict_json": strict_json,
        "extra_text": parsed is not None and not strict_json,
        "score": score,
        "total": total,
        "accuracy": round(100 * score / total, 2),
        "checks": checks,
        "usage": usage,
        "event_types": event_types,
        "response_text_bytes": len(text.encode("utf-8")),
    }
    print(
        f"{name} {result['mode']} status={result['status']} score={score}/{total} model={response_model}",
        flush=True,
    )
    return result


def request_case_with_retry(
    session: requests.Session,
    key: str,
    name: str,
    paths: list[Path],
    prompt: str,
    gold: dict[str, Any],
    stream: bool,
) -> dict[str, Any]:
    first = request_case(session, key, name, paths, prompt, gold, stream)
    if not first.get("network_error"):
        first["attempts"] = 1
        return first
    time.sleep(1)
    retry = request_case(session, key, name, paths, prompt, gold, stream)
    retry["attempts"] = 2
    retry["first_attempt_network_error"] = first.get("network_error")
    retry["first_attempt_latency_ms"] = first.get("latency_ms")
    return retry


def parity_case(session: requests.Session, key: str, path: Path, expected: str) -> dict[str, Any]:
    gold = {"code": expected}
    prompt = "Read the prominent format-test code in the image. Return it in the code field."
    return request_case_with_retry(
        session, key, f"format_{path.suffix[1:]}", [path], prompt, gold, False
    )


def write_report(report: dict[str, Any]) -> tuple[Path, Path]:
    json_path = ROOT / "vision_opus48_results.json"
    md_path = ROOT / "vision_opus48_report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# Opus 4.8 vision benchmark",
        "",
        f"- Generated: {report['finished_at']}",
        f"- Model: {MODEL}",
        f"- Overall accuracy: {report['overall_accuracy']}%",
        f"- Grade: {report['grade']}",
        f"- Non-stream accuracy: {report['nonstream_accuracy']}%",
        f"- Stream accuracy: {report['stream_accuracy']}%",
        f"- Format parity accuracy: {report['format_parity_accuracy']}%",
        f"- Stream/non-stream gap: {report['stream_nonstream_gap_pp']} percentage points",
        "",
        "| Case | Mode | Score | Accuracy | HTTP | Model exact |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for item in report["results"]:
        lines.append(
            f"| {item['name']} | {item['mode']} | {item['score']}/{item['total']} | "
            f"{item['accuracy']}% | {item['status']} | {item.get('model_exact')} |"
        )
    lines.extend(["", "## Gate failures", ""])
    if report["gate_failures"]:
        lines.extend(f"- {failure}" for failure in report["gate_failures"])
    else:
        lines.append("- None")
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate-only", action="store_true")
    parser.add_argument(
        "--direct",
        action="store_true",
        help="bypass environment proxies (the default uses the normal system route)",
    )
    args = parser.parse_args()
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    dashboard, dashboard_gold = generate_dashboard()
    tiny, tiny_gold = generate_tiny()
    hard, hard_gold = generate_hard_ocr()
    multi, multi_gold = generate_multi()
    parity_paths, parity_gold = generate_parity()
    manifest = {
        "dashboard": {"files": [dashboard.name], "assertions": len(dashboard_gold)},
        "tiny_text": {"files": [tiny.name], "assertions": len(tiny_gold)},
        "hard_ocr": {"files": [hard.name], "assertions": len(hard_gold)},
        "multi_image": {"files": [path.name for path in multi], "assertions": len(multi_gold)},
        "format_parity": {"files": [path.name for path in parity_paths], "assertions": 3},
    }
    (ASSET_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if args.generate_only:
        print(f"GENERATE_ONLY_OK assets={sum(len(item['files']) for item in manifest.values())}", flush=True)
        return 0

    key = load_key()
    session = requests.Session()
    session.trust_env = not args.direct
    session.headers["user-agent"] = "nexorax-opus48-vision-benchmark/1.0"
    before = safe_whoami(session, key)
    started_at = datetime.now(timezone.utc).isoformat()
    prompts = {
        "dashboard": (
            "Analyze the dashboard. Return the exact large title and tiny MICRO text; describe the "
            "upper-left, center, and lower-right grid shapes as color plus shape; identify the shape "
            "directly below the blue circle; identify the tallest bar and the value of bar B; return "
            "the Otter table value and count all orange stars."
        ),
        "tiny_text": "Read the code in each numbered row from top to bottom. Preserve letters, digits, and hyphens exactly.",
        "hard_ocr": "Read all eight degraded numbered codes from 1 through 8. Return them in order in the codes array.",
        "multi_image": (
            "Image 1 is panel A and image 2 is panel B. Count red circles and blue squares in each, "
            "state which panel has more total shapes, and give each arrow direction as north/east/south/west."
        ),
    }
    cases = [
        ("dashboard", [dashboard], prompts["dashboard"], dashboard_gold),
        ("tiny_text", [tiny], prompts["tiny_text"], tiny_gold),
        ("hard_ocr", [hard], prompts["hard_ocr"], hard_gold),
        ("multi_image", multi, prompts["multi_image"], multi_gold),
    ]
    results: list[dict[str, Any]] = []
    try:
        for name, paths, prompt, gold in cases:
            results.append(request_case_with_retry(session, key, name, paths, prompt, gold, False))
            results.append(request_case_with_retry(session, key, name, paths, prompt, gold, True))
        for path in parity_paths:
            results.append(parity_case(session, key, path, parity_gold))
    finally:
        after = safe_whoami(session, key)

    main_results = [item for item in results if not item["name"].startswith("format_")]
    nonstream = [item for item in main_results if item["mode"] == "nonstream"]
    stream = [item for item in main_results if item["mode"] == "stream"]
    parity = [item for item in results if item["name"].startswith("format_")]

    def aggregate(items: list[dict[str, Any]]) -> float:
        got = sum(item["score"] for item in items)
        total = sum(item["total"] for item in items)
        return round(100 * got / total, 2) if total else 0.0

    nonstream_accuracy = aggregate(nonstream)
    stream_accuracy = aggregate(stream)
    parity_accuracy = aggregate(parity)
    overall = round((nonstream_accuracy + stream_accuracy) * 0.45 + parity_accuracy * 0.10, 2)
    grade = "excellent" if overall >= 90 else "good" if overall >= 80 else "limited" if overall >= 65 else "poor"
    gates: list[str] = []
    for mode in ("nonstream", "stream"):
        dashboard_result = next(item for item in results if item["name"] == "dashboard" and item["mode"] == mode)
        if not dashboard_result["checks"].get("title"):
            gates.append(f"delivery title failed in {mode}")
        multi_result = next(item for item in results if item["name"] == "multi_image" and item["mode"] == mode)
        if not all(multi_result["checks"].values()):
            gates.append(f"multi-image exactness failed in {mode}")
    gap = round(abs(nonstream_accuracy - stream_accuracy), 2)
    if gap > 5:
        gates.append("stream/non-stream accuracy gap exceeds 5 percentage points")
    if parity_accuracy < 100:
        gates.append("format parity is not exact across PNG/JPEG/WebP")
    if any(item.get("response_model") != MODEL for item in results):
        gates.append("one or more responses reported a different model")

    report = {
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "benchmark_assertions_per_main_mode": sum(fact_count(gold) for _, _, _, gold in cases),
        "format_assertions": 3,
        "overall_accuracy": overall,
        "grade": grade,
        "nonstream_accuracy": nonstream_accuracy,
        "stream_accuracy": stream_accuracy,
        "format_parity_accuracy": parity_accuracy,
        "stream_nonstream_gap_pp": gap,
        "gate_failures": gates,
        "balance_before": before,
        "balance_after": after,
        "results": results,
        "secret_handling": "key read in memory; no request headers or raw key stored",
    }
    json_path, md_path = write_report(report)
    print(f"JSON report: {json_path}", flush=True)
    print(f"Markdown report: {md_path}", flush=True)
    print(f"FINAL score={overall} grade={grade} gates={len(gates)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

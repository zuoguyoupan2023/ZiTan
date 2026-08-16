#!/usr/bin/env python3
"""
pack-data.py — 把模型文件打包成 sherpa-onnx 浏览器用的 .data，并补丁引擎胶水 JS。

原理（与官方 pack.py 一致）：
  - .data 文件 = 各模型文件字节的裸拼接（无头部）。
  - 文件清单（filename/start/end）写在引擎胶水 JS 的 loadPackage({...}) 里。
用法：
  python3 pack-data.py <引擎胶水.js> <输出目录>
  模型来源固定从本脚本的 MODEL_SRC 读取。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # ZiTan/
# 虚拟路径 -> 真实文件（打进 .data 后浏览器 FS 里的路径）
FILES = [
    ("/sense-voice.onnx", ROOT / "sensevoice/model.int8.onnx"),
    ("/tokens.txt",        ROOT / "sensevoice/tokens.txt"),
    ("/silero_vad.onnx",   ROOT / "sensevoice/silero_vad.onnx"),
]
DATA_NAME = "sherpa-onnx-wasm-main-vad-asr.data"
DATA_URL = "/sensevoice/" + DATA_NAME   # 浏览器 fetch 该 .data 的绝对路径


def build_data(out_dir: Path):
    metadata = []
    offset = 0
    with open(out_dir / DATA_NAME, "wb") as out:
        for virtual, real in FILES:
            if not real.exists():
                raise SystemExit(f"缺少模型文件: {real}")
            data = real.read_bytes()
            out.write(data)
            metadata.append({"filename": virtual, "start": offset, "end": offset + len(data)})
            offset += len(data)
            print(f"  {virtual:20s} {len(data)/1048576:7.1f}MB")
    print(f"  .data 总大小: {offset/1048576:.1f}MB")
    return metadata, offset


def patch_glue(glue: Path, out: Path, metadata, total_size):
    content = glue.read_text()

    # 1) 修正 PACKAGE_NAME 路径（用绝对 URL，使 .data 在任意页面路径下都能加载）
    content = re.sub(r'var PACKAGE_NAME="[^"]*"', 'var PACKAGE_NAME="%s"' % DATA_URL, content)

    # 2) 修正 datafile_ 引用
    content = re.sub(r'datafile_[A-Za-z0-9_./-]*%s' % DATA_NAME, 'datafile_' + DATA_NAME, content)

    # 3) 移除旧模型目录的 FS_createPath 调用（新模型文件全在根目录）
    content = re.sub(r'Module\["FS_createPath"\]\([^)]*\);', '', content)

    # 4) 替换 loadPackage({...}) 的元数据
    new_meta = json.dumps({"files": metadata, "remote_package_size": total_size}, separators=(",", ":"))
    m = re.search(r'loadPackage\(\{', content)
    if not m:
        raise SystemExit("胶水中找不到 loadPackage({")
    start = m.start() + len("loadPackage(")
    # 找匹配的闭合 }
    depth = 0
    i = start
    while i < len(content):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    close_paren = content.index(")", i)
    content = content[:start] + new_meta + content[close_paren:]

    out.write_text(content)
    print(f"  补丁后胶水: {out.name}  (loadPackage 元数据 {len(new_meta)} bytes)")


def main():
    if len(sys.argv) < 3:
        print("用法: python3 pack-data.py <引擎胶水.js> <输出目录>")
        sys.exit(1)
    glue = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"① 打包 .data …")
    metadata, total = build_data(out_dir)
    print(f"② 补丁胶水 JS …")
    patch_glue(glue, out_dir / glue.name, metadata, total)
    print(f"③ 完成。请把 .wasm、sherpa-onnx-asr.js、sherpa-onnx-vad.js 一并复制到 {out_dir}")


if __name__ == "__main__":
    main()

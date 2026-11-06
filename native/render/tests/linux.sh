#!/bin/sh
# The tests on Linux (FreeType glyphs, like CanvasKit and the VPS), in Docker, from native/render:
#   docker run --rm -v "$(pwd)":/work -w /work rust:1 sh tests/linux.sh
set -e
apt-get update -qq && apt-get install -y -qq libfontconfig1-dev clang >/dev/null
CARGO_TARGET_DIR=/work/target/linux cargo test --release -- --nocapture 2>&1 | grep -v Compiling

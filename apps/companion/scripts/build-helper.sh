#!/bin/sh
# Builds the universal (arm64 + x86_64) lifeos-frontmost helper. macOS only.
set -eu
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "build-helper: skipping, the native helper only builds on macOS" >&2
  exit 0
fi

out=build/bin
mkdir -p "$out"
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 \
    -target "$arch-apple-macos12" \
    -o "$out/lifeos-frontmost-$arch" \
    native/FrontmostApp.swift
done
lipo -create -output "$out/lifeos-frontmost" "$out/lifeos-frontmost-arm64" "$out/lifeos-frontmost-x86_64"
rm "$out/lifeos-frontmost-arm64" "$out/lifeos-frontmost-x86_64"
echo "build-helper: wrote $out/lifeos-frontmost"

#!/bin/bash
# Regenerates data/press-photos.json and creates web-optimized thumbnails.
# Thumbnails are resized to 1200px wide and saved as low-quality JPEGs.
cd "$(dirname "$0")/.."

THUMB_DIR="assets/press-thumbs"
THUMB_WIDTH=1200
mkdir -p "$THUMB_DIR"

# Clean old thumbs that no longer have a source
for thumb in "$THUMB_DIR"/press-*.jpg; do
  [ -f "$thumb" ] || continue
  base=$(basename "$thumb")
  match=$(ls assets/press-"${base#press-}"* 2>/dev/null | head -1)
  # Check if any source file maps to this thumb
  found=false
  for src in assets/press-*.{jpg,jpeg,png} ; do
    [ -f "$src" ] || continue
    src_thumb="${THUMB_DIR}/$(basename "${src%.*}").jpg"
    if [ "$src_thumb" = "$thumb" ]; then
      found=true
      break
    fi
  done
  if [ "$found" = false ]; then
    rm "$thumb"
    echo "Removed orphaned thumb: $thumb"
  fi
done

# Build manifest and generate thumbnails
echo "[" > data/press-photos.json
first=true
count=0
for f in $(ls assets/press-*.{jpg,jpeg,png} 2>/dev/null | sort); do
  name=$(basename "$f")
  thumb_name="${name%.*}.jpg"
  thumb_path="${THUMB_DIR}/${thumb_name}"

  # Generate thumbnail if missing or source is newer
  if [ ! -f "$thumb_path" ] || [ "$f" -nt "$thumb_path" ]; then
    cp "$f" "$thumb_path"
    sips --resampleWidth $THUMB_WIDTH --setProperty formatOptions 60 "$thumb_path" > /dev/null 2>&1
    echo "Generated thumb: $thumb_name"
  fi

  if [ "$first" = true ]; then
    first=false
  else
    echo "," >> data/press-photos.json
  fi
  printf '  "%s"' "$name" >> data/press-photos.json
  count=$((count + 1))
done
echo "" >> data/press-photos.json
echo "]" >> data/press-photos.json
echo "Updated data/press-photos.json with $count photos."

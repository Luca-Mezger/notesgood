#!/usr/bin/env bash
# Updates the installed Opplinotes desktop app (~/.local/share/notesgood) to the version in this repo.
# A copy of the currently installed version is kept in ~/.local/share/notesgood/ui-backups/.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
target="${XDG_DATA_HOME:-$HOME/.local/share}/notesgood"

if [ ! -d "$target/dist" ]; then
  echo "No installed app found at $target/dist; nothing to update." >&2
  exit 1
fi

cd "$repo"
echo "Building..."
if command -v npm >/dev/null 2>&1; then
  npm run build
else
  nix shell nixpkgs#nodejs -c npm run build
fi
[ -f dist/index.html ] && [ -f dist/main.js ] || { echo "Build output is incomplete; installed app left unchanged." >&2; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$target/ui-backups"
cp -a "$target/dist" "$target/ui-backups/dist-$stamp"
echo "Backed up the installed version to $target/ui-backups/dist-$stamp"

# Replace dist atomically-ish: copy to a temp folder, then swap.
rm -rf "$target/dist.new"
cp -a dist "$target/dist.new"
rm -rf "$target/dist"
mv "$target/dist.new" "$target/dist"

# Keep the pen-button helper in step with the repo (it is only restarted if it is running).
mkdir -p "$target/scripts"
cp -a scripts/notesgood-pen.py scripts/ensure-pen.mjs "$target/scripts/"
if systemctl --user is-active --quiet notesgood-pen.service 2>/dev/null; then
  systemctl --user restart notesgood-pen.service || true
fi

echo "Done. Close and reopen Opplinotes (or press Ctrl+Shift+R in its window) to load the new version."
echo "To go back: rm -rf '$target/dist' && cp -a '$target/ui-backups/dist-$stamp' '$target/dist'"

#!/bin/sh
# Install the Gitware overlay into a Gitea custom directory.
#
#   GITEA_CUSTOM=/var/lib/gitea/custom ./install.sh
#
# Only `templates/custom/*.tmpl` and `public/assets/gitware/**` are written, so
# other customisations in the same directory are left alone. Restart Gitea
# afterwards: templates and static mounts are read at start-up.
set -eu

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${GITEA_CUSTOM:-${1:-}}

if [ -z "$target" ]; then
  echo "usage: GITEA_CUSTOM=/path/to/gitea/custom $0" >&2
  exit 2
fi
if [ ! -d "$target" ]; then
  echo "error: $target is not a directory" >&2
  exit 2
fi
if [ ! -f "$target/conf/app.ini" ] && [ ! -d "$target/templates" ] && [ -n "${GITEA_CUSTOM:-}" ]; then
  echo "warning: $target does not look like a Gitea custom directory" >&2
fi

mkdir -p "$target/templates/custom" "$target/public/assets/gitware"

for tmpl in "$src/custom/templates/custom"/*.tmpl; do
  cp "$tmpl" "$target/templates/custom/"
  echo "template  $(basename "$tmpl")"
done

for file in "$src/custom/public/assets/gitware"/*; do
  cp "$file" "$target/public/assets/gitware/"
  echo "asset     $(basename "$file")"
done

echo
echo "Installed into $target"
echo "Restart Gitea, then open any repository and use the Hardware tab."

#!/bin/sh
# Start the demo instance with storage kept in this directory.
#
#   GITEA_BIN=/usr/local/bin/gitea ./run.sh
#
# Everything the instance knows lives in ./data, so repositories, users and
# mirror settings survive a restart of the sandbox. The overlay is reinstalled
# from the parent directory on every start, so the copy here never drifts.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin=${GITEA_BIN:-gitea}

GITEA_CUSTOM="$here/custom" sh "$here/../install.sh" >/dev/null

exec env \
  HOME="$here" \
  GITEA_WORK_DIR="$here" \
  GITEA_CUSTOM="$here/custom" \
  GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=1 \
  "$bin" web --config "$here/app.ini"

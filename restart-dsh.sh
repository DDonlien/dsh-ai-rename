#!/bin/sh
# Restart DSH Desktop so it picks up the plugin.
#
# Why a restart is needed: the profile's plugin tree is composed once at harness
# startup. `patchReload: live` re-applies patches to rows that are ALREADY
# composed, so it cannot introduce a brand-new plugin row; that was verified
# against the running app by both touching and rewriting cordis.patch.yml.
#
# Install layout this script assumes (and verifies):
#   - the package is a dependency of the profile, so it is linked into
#     profiles/<name>/node_modules and the loader can resolve its name;
#   - it is NOT listed in dsh.profile.bundles, because Desktop market-checks
#     every bundle against the npm registry and treats a 404 as
#     "plugin failed to start", ejecting local-only packages;
#   - its loader row is inserted by the profile's cordis.patch.yml.
#
# The app is a bundled Electron app with no CLI on PATH, so restarting means
# quitting the process and reopening the bundle.

set -e

APP="/Applications/DSH Desktop - dataelement.app"
PROFILE="/Users/taobe/Library/Application Support/dsh-desktop/harness/profiles/web"

echo "Checking install layout..."
if ! grep -q "title-suggest" "$PROFILE/cordis.patch.yml" 2>/dev/null; then
  echo "  ERROR: the plugin row is missing from $PROFILE/cordis.patch.yml"
  exit 1
fi
if [ ! -e "$PROFILE/node_modules/dsh-plugin-title-suggest" ]; then
  echo "  ERROR: the plugin is not linked into $PROFILE/node_modules"
  exit 1
fi
echo "  layout OK"

echo "Stopping DSH Desktop..."
osascript -e 'quit app "DSH Desktop"' 2>/dev/null || true

i=0
while [ "$i" -lt 20 ]; do
  pgrep -f "MacOS/DSH Desktop$" >/dev/null 2>&1 || break
  sleep 0.5
  i=$((i + 1))
done

if pgrep -f "MacOS/DSH Desktop$" >/dev/null 2>&1; then
  echo "Graceful quit timed out; terminating."
  pkill -f "MacOS/DSH Desktop$" || true
  sleep 2
fi

echo "Starting DSH Desktop..."
open "$APP"

echo "Waiting for the harness to serve..."
i=0
code=000
while [ "$i" -lt 90 ]; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:53612/plugin/title-suggest 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "Plugin loaded: /plugin/title-suggest -> 200"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

echo "Harness answered with $code instead of 200."
echo "Open a session, choose Rename, and look for the suggestion row under the input."
exit 1

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

# Two DSH Desktop bundles can be installed side by side, and BOTH report the
# display name "DSH Desktop" — only the bundle id differs. Address this bundle by
# id and by its own path, or a quit/kill aimed at one app hits the other.
BUNDLE_ID=$(defaults read "$APP/Contents/Info" CFBundleIdentifier 2>/dev/null || echo "")
if [ -z "$BUNDLE_ID" ]; then
  echo "  ERROR: cannot read CFBundleIdentifier from $APP"
  exit 1
fi
MAIN_MATCH="$APP/Contents/MacOS/"
BUNDLE_MATCH="$APP/Contents/"

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

# Process discovery goes through `ps`, not `pgrep`: on this machine pgrep does not
# report the main app process or the Node helper that serves the harness, so a
# pgrep-based check reports "already stopped" while both are still alive.
pids_matching() {
  ps -eo pid=,command= | awk -v needle="$1" 'index($0, needle) { print $1 }'
}

echo "Stopping DSH Desktop ($BUNDLE_ID)..."
osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true

i=0
while [ "$i" -lt 20 ]; do
  if [ -z "$(pids_matching "$MAIN_MATCH")" ]; then break; fi
  sleep 0.5
  i=$((i + 1))
done

remaining=$(pids_matching "$MAIN_MATCH")
if [ -n "$remaining" ]; then
  echo "Graceful quit timed out; terminating this bundle's main process only."
  # shellcheck disable=SC2086
  kill $remaining 2>/dev/null || true
  sleep 2
fi

echo "Starting DSH Desktop..."
open "$APP"

echo "Waiting for the harness to serve..."
# The harness HTTP port is ephemeral (it was 53612 in one run, 43129 in another)
# and is held by a Helper process, not by the main app process. So enumerate this
# bundle's listening sockets each attempt instead of probing a remembered port.
found_port=""
i=0
while [ "$i" -lt 90 ]; do
  for pid in $(pids_matching "$BUNDLE_MATCH"); do
    for port in $(lsof -nP -iTCP -sTCP:LISTEN -a -p "$pid" 2>/dev/null | awk 'NR>1 { n = split($9, a, ":"); print a[n] }' | sort -u); do
      code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/plugin/title-suggest" 2>/dev/null || echo 000)
      if [ "$code" = "200" ]; then
        found_port=$port
        break 3
      fi
    done
  done
  sleep 1
  i=$((i + 1))
done

if [ -n "$found_port" ]; then
  echo "Plugin loaded: http://127.0.0.1:$found_port/plugin/title-suggest -> 200"
  echo "Open a session, choose Rename, and look for the suggestion row under the input."
  exit 0
fi

echo "No process of $BUNDLE_ID answered 200 on /plugin/title-suggest."
echo "If the harness is up, the plugin did not start: check the profile's cordis.patch.yml."
exit 1

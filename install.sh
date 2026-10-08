#!/bin/sh
# ORCH-os installer for a checkout or a git source (POSIX sh, no sudo).
# The usual install is npm:  npm i -g orch-os   or   npx orch-os init
# This script is for installing straight from a repository you have already inspected:
#
#   From a checkout:            sh install.sh
#
# It replaces, on every run: ~/.orch/lib/orch-os, the launcher ~/.local/bin/orch (or
# $ORCH_PREFIX/bin/orch), and ~/.orch/src when it fetches the source. Do not use it for an
# isolated trial next to an existing install: install a packed tarball into its own prefix
# (npm install --prefix DIR orch-os-<version>.tgz) and set ORCH_HOME for that trial.
#
# Source, in order: the checkout install.sh lives in; else ORCH_OS_REPO (any git URL or local
# path); else the current directory if it is a checkout; else ORCH_OS_GH_REPO (owner/name),
# fetched with `gh repo clone` when gh is logged in (works for a private repo) or a plain https
# clone otherwise (public repo only). ORCH_OS_REF picks a branch or tag; without it the clone
# is the default branch as it is at that moment, so name a tag when you need a fixed version.
# A source without a built dist/ is built with `npm install && npm run build` (this fetches the
# build tools from the npm registry once). Installs the package to ~/.orch/lib/orch-os and a
# launcher to ~/.local/bin/orch (override with ORCH_PREFIX). Re-running upgrades in place.
# Never touches ~/.orch/config.toml. ORCH_INIT=1 also runs `orch init && orch doctor`.
# SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
set -eu

PREFIX="${ORCH_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"
LIB="$HOME/.orch/lib"

say() { printf 'orch-install: %s\n' "$*"; }
die() { printf 'orch-install: ERROR: %s\n' "$*" >&2; exit 1; }

# 1. a Node.js >= 22 (package.json engines)
NODE=""
for c in "${ORCH_NODE:-node}" node; do
  p=$(command -v "$c" 2>/dev/null || true)
  [ -n "$p" ] || continue
  if "$p" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then NODE="$p"; break; fi
done
[ -n "$NODE" ] || die "need Node.js >= 22 on PATH (or set ORCH_NODE)"
say "node: $NODE ($("$NODE" -p 'process.versions.node'))"

# 2. the source: this checkout, else a clone
is_src() { [ -f "$1/package.json" ] && [ -f "$1/src/cli.ts" ]; }
SRC=""
case "$0" in
  */*) d=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd); is_src "$d" && SRC="$d" ;;
esac
[ -z "$SRC" ] && [ -z "${ORCH_OS_REPO:-}" ] && is_src "." && SRC=$(pwd)
if [ -z "$SRC" ]; then
  GH_REPO="${ORCH_OS_GH_REPO:-}"
  REF="${ORCH_OS_REF:-}"
  command -v git >/dev/null 2>&1 || die "git is required to fetch the source"
  SRC="$HOME/.orch/src"
  rm -rf "$SRC"
  mkdir -p "$HOME/.orch"
  if [ -z "${ORCH_OS_REPO:-}" ] && [ -z "$GH_REPO" ]; then
    die "no source: run from a checkout, or set ORCH_OS_REPO=<git url or path> or ORCH_OS_GH_REPO=<owner/name>"
  fi
  if [ -n "${ORCH_OS_REPO:-}" ]; then
    say "fetching: git clone $ORCH_OS_REPO"
    git clone --depth 1 ${REF:+--branch "$REF"} "$ORCH_OS_REPO" "$SRC" >/dev/null 2>&1 \
      || die "git clone failed: $ORCH_OS_REPO"
  elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    say "fetching: gh repo clone $GH_REPO"
    gh repo clone "$GH_REPO" "$SRC" -- --depth 1 ${REF:+--branch "$REF"} >/dev/null 2>&1 \
      || die "gh repo clone failed: $GH_REPO (does this gh account have access?)"
  else
    say "fetching: git clone https://github.com/$GH_REPO (public repos only; for a private repo run \`gh auth login\` first)"
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 ${REF:+--branch "$REF"} "https://github.com/$GH_REPO.git" "$SRC" \
      >/dev/null 2>&1 || die "clone failed: https://github.com/$GH_REPO (private repo? install gh and run \`gh auth login\`)"
  fi
  is_src "$SRC" || die "fetched source is not an ORCH-os checkout: $SRC"
fi
say "source: $SRC"

# 3. build if needed
if [ ! -f "$SRC/dist/cli.js" ]; then
  command -v npm >/dev/null 2>&1 || die "the source has no dist/ and npm is not on PATH to build it"
  say "building: npm install && npm run build (in $SRC)"
  (cd "$SRC" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1) \
    || die "build failed in $SRC (run: cd $SRC && npm install && npm run build)"
fi

# 4. copy the package + write the launcher
mkdir -p "$LIB" "$BIN"
rm -rf "$LIB/orch-os"
mkdir -p "$LIB/orch-os"
for part in dist fixtures templates package.json LICENSE LICENSE-INTERNAL-USE LICENSE-NONCOMMERCIAL NOTICE AUTHORS; do
  [ -e "$SRC/$part" ] && cp -R "$SRC/$part" "$LIB/orch-os/"
done
cat > "$BIN/orch" <<SHIM
#!/bin/sh
exec "$NODE" "$LIB/orch-os/dist/cli.js" "\$@"
SHIM
chmod 755 "$BIN/orch"
VER=$("$BIN/orch" --version) || die "installed $BIN/orch but it does not run"
say "installed: $BIN/orch ($VER)"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "note: $BIN is not on PATH; add:  export PATH=\"$BIN:\$PATH\"" ;;
esac
if [ "${ORCH_INIT:-0}" = 1 ]; then
  "$BIN/orch" init && "$BIN/orch" doctor
else
  say "next: orch init && orch doctor"
fi

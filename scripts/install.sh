#!/usr/bin/env bash
# Mnemo onboarding installer — Linux and macOS.
#
#   ./scripts/install.sh                 # interactive onboarding
#   ./scripts/install.sh --yes           # take every default, ask nothing (CI)
#   ./scripts/install.sh --dry-run       # print every command, run none of them
#   ./scripts/install.sh --no-gum        # use the plain prompts even if gum is here
#   ./scripts/install.sh --bin-dir DIR   # where the binary lands (default ~/.local/bin)
#   ./scripts/install.sh --help
#
# gum (github.com/charmbracelet/gum) draws the prompts when it is on PATH. It is
# never required: gum is not on a fresh machine, so this script offers to get it
# — `go install` first (Go is already a hard requirement of this project, so it
# needs no sudo), then a release tarball, then "no thanks" — and asks every
# question as a plain numbered `read` menu when gum is absent. A missing gum
# costs you polish, never a choice.
#
# Touches:    this checkout's build outputs, <bin dir>, and — only if you answer
#             yes — one marked block in one shell rc file.
# Never:      ~/.mnemo. The directory is created if missing; nothing inside it is
#             read, written, moved or removed by this script. No sudo, ever.
#
# Exit status: 0 only when every selected step succeeded and the installed binary
# rendered a real offline frame. Any failed step is reported and listed at the
# end, and the script exits non-zero — a failed optional component does not stop
# the rest of the install.

set -uo pipefail

# --- constants --------------------------------------------------------------
NODE_FLOOR="22.18"
GO_FLOOR="1.22"
GUM_FALLBACK_VERSION="2.0.1"
GUM_REPO="charmbracelet/gum"
REPO_URL="https://github.com/AtmanMishra/self-evolving-agent"
ISSUES_URL="$REPO_URL/issues"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${MNEMO_BIN_DIR:-$HOME/.local/bin}"
MNEMO_HOME="$HOME/.mnemo"
# The execute phase runs commands through a fresh `bash -c` when gum draws the
# spinner, so anything a planned command refers to must be in the environment.
export ROOT MNEMO_HOME

DRY_RUN=0
ASSUME_YES=0
NO_GUM=0
FORCE_NO_PROMPTS=0
INTERACTIVE=0
STEP_N=0
# The interface builds to tui-go/mnemo.new (relative, so the Go toolchain gets a
# path it understands), gets smoke-tested, and only then replaces tui-go/mnemo.
# It is removed on exit either way — a failed build leaves the repo as it was.
CANDIDATE="$ROOT/tui-go/mnemo.new"
DUMP_OK=0

# --- arguments --------------------------------------------------------------
usage() {
  cat <<'EOF'
Mnemo onboarding installer (Linux and macOS)

Usage: scripts/install.sh [options]

  -y, --yes             non-interactive: accept every default, install every
                        component that is possible on this machine
      --non-interactive never prompt; take the documented defaults. Implied by
                        --yes, and by any run whose stdin or stdout is not a
                        terminal (gum's widgets would otherwise render and then
                        wait for a keypress that never comes — a silent hang in
                        CI, a pipe, or a non-interactive ssh)
      --dry-run         print every command that would run, run none of them
      --no-gum          skip gum entirely and use the plain numbered prompts
      --bin-dir DIR     install the binary here (default: ~/.local/bin,
                        or $MNEMO_BIN_DIR)
  -h, --help            this text

Environment:
  MNEMO_BIN_DIR        same as --bin-dir
  MNEMO_GUM_VERSION    pin the gum release used by the tarball route (e.g. 2.0.1)
  MNEMO_KEEP_LOGS=1    keep the per-step logs even on success
  NO_COLOR             disable colour (gum output honours it too)
EOF
}

while [ $# -gt 0 ]; do
  case "${1}" in
    -y|--yes)         ASSUME_YES=1; FORCE_NO_PROMPTS=1 ;;
    --non-interactive|--no-input) FORCE_NO_PROMPTS=1 ;;
    --dry-run|-n)     DRY_RUN=1 ;;
    --no-gum)         NO_GUM=1 ;;
    --bin-dir)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install.sh: --bin-dir needs a path (try --help)\n' >&2
        exit 2
      fi
      BIN_DIR="${2}"
      shift
      ;;
    --bin-dir=*)   BIN_DIR="${1#--bin-dir=}" ;;
    -h|--help)     usage; exit 0 ;;
    *)
      printf 'install.sh: unknown option %s (try --help)\n' "${1}" >&2
      exit 2
      ;;
  esac
  shift
done

# A trailing slash on --bin-dir would give "//mnemo" everywhere; strip it.
while [ "${BIN_DIR%/}" != "${BIN_DIR}" ] && [ "${BIN_DIR}" != "/" ]; do
  BIN_DIR="${BIN_DIR%/}"
done
export BIN_DIR
# The leading "~" here is a literal a user typed (`--bin-dir "~/bin"`), not a
# pattern we want expanded — matching it is the whole point.
# shellcheck disable=SC2088
case "${BIN_DIR}" in
  '~'|'~/'*) BIN_DIR="${HOME}${BIN_DIR#\~}"; export BIN_DIR ;;
esac
export CANDIDATE

# --- colour / gum capability ------------------------------------------------
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

gum_bin=''
gum_style=0     # gum available for presentation (style/table/format/log) — never prompts
gum_prompt=0    # gum may draw interactive widgets: it has a terminal to read from
gum_spin=0      # gum spin may draw a spinner (again: needs the terminal)

# Interactivity is decided ONCE, here, and never re-decided:
#   - --yes / --non-interactive: no prompts, ever;
#   - stdin AND stdout must both be terminals, or nothing is asked.
# The second rule is not politeness. `gum choose` without a terminal does not
# error — it draws the menu and waits for a keypress that never comes, so a CI
# run, a pipe or a non-interactive ssh session hangs with no explanation. When
# we are not interactive, every question below answers itself with its default
# and says so.
if [ "$FORCE_NO_PROMPTS" = 0 ] && [ -t 0 ] && [ -t 1 ]; then
  INTERACTIVE=1
fi

refresh_gum() {
  gum_bin="$(command -v gum 2>/dev/null || true)"
  gum_style=0; gum_prompt=0; gum_spin=0
  if [ "$NO_GUM" = 1 ] || [ -z "$gum_bin" ]; then
    return
  fi
  # Presentation-only subcommands (style, table, format, log, join) are safe
  # piped, so they may be used even in a non-interactive run.
  gum_style=1
  if [ "$INTERACTIVE" = 1 ]; then
    gum_prompt=1; gum_spin=1
  fi
}
refresh_gum

# gum exits non-zero when the user cancels (esc / ctrl-c) and also when a widget
# cannot run at all; both mean "stop asking questions", never "continue blindly".
GUM_CANCELLED=0

# --- output -----------------------------------------------------------------
say()  { printf '    %s\n' "$*"; }
raw()  { printf '%s\n' "$*"; }

hdr() { # section header; $2 (optional) is a step number
  if [ "$gum_style" = 1 ] && [ -n "${2:-}" ]; then
    printf '\n'
    printf '%s' "$2" | gum style --border rounded --border-foreground 99 --padding '0 1' --foreground 99
  elif [ -n "${2:-}" ]; then
    printf '\n%s%s%s\n' "$C_BOLD$C_CYAN" "$2" "$C_RESET"
  else
    printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"
  fi
}

step_hdr() {
  STEP_N=$((STEP_N + 1))
  hdr x "$STEP_N. $1"
}

ok() {   # 42 = green
  if [ "$gum_style" = 1 ]; then gum style --foreground 42 "    ok   $*"
  else printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; fi
}
warn() { # 214 = amber; warnings on stderr so piped stdout stays clean
  if [ "$gum_style" = 1 ]; then gum style --foreground 214 "    !    $*" >&2
  else printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; fi
}
err() {  # 196 = red
  if [ "$gum_style" = 1 ]; then gum style --foreground 196 "    fail $*" >&2
  else printf '    %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; fi
}
dim() {
  if [ "$gum_style" = 1 ]; then gum style --faint "    $*"
  else printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; fi
}

# --- plain-prompt helpers (used whenever gum cannot draw) -------------------
# Every prompt reads from stdin and treats EOF/empty input as "take the default",
# so `printf '2\n' | ./scripts/install.sh` drives the same menus a human sees.
prompt_read() { # prompt_read <prompt>; echoes the raw line, empty on EOF
  printf '%s' "$1" >&2
  local ans=''
  IFS= read -r ans || ans=''
  printf '%s' "$ans"
}

# Non-interactive runs never reach a prompt: each question answers itself with
# the documented default and says which one it took.
take_default() { # take_default <what> <default>
  printf '    %s→ %s: %s (not interactive — the default stands)%s\n' \
    "$C_DIM" "$1" "$2" "$C_RESET" >&2
  printf '%s' "$2"
}

q_choose() { # q_choose <header> <default 1-based> <option...>; echoes the index
  local header="$1" def="$2"; shift 2
  local n=$# i=1
  if [ "$INTERACTIVE" = 0 ]; then take_default "$header" "$def"; return 0; fi
  if [ "$gum_prompt" = 1 ]; then
    local chosen
    if ! chosen="$(gum choose --height 14 --cursor '> ' --header "$header" "$@" 2>/dev/null)"; then
      GUM_CANCELLED=1; printf '%s' "$def"; return 1
    fi
    for o in "$@"; do
      [ "$o" = "$chosen" ] && { printf '%s' "$i"; return 0; }
      i=$((i + 1))
    done
    printf '%s' "$def"; return 1
  fi
  printf '\n  %s%s%s\n' "$C_BOLD" "$header" "$C_RESET" >&2
  for o in "$@"; do
    if [ "$i" = "$def" ]; then
      printf '    %s%d)%s %s %s(default)%s\n' "$C_DIM" "$i" "$C_RESET" "$o" "$C_DIM" "$C_RESET" >&2
    else
      printf '    %d) %s\n' "$i" "$o" >&2
    fi
    i=$((i + 1))
  done
  local attempt=0 ans
  while [ "$attempt" -lt 3 ]; do
    ans="$(prompt_read "  choice [$def]: ")"
    if [ -z "$ans" ]; then printf '%s' "$def"; return 0; fi
    case "$ans" in
      *[!0-9]*) : ;;
      *) if [ "$ans" -ge 1 ] && [ "$ans" -le "$n" ]; then printf '%s' "$ans"; return 0; fi ;;
    esac
    printf '  %snot a number between 1 and %d%s\n' "$C_YELLOW" "$n" "$C_RESET" >&2
    attempt=$((attempt + 1))
  done
  printf '  %stoo many tries — using the default (%d)%s\n' "$C_YELLOW" "$def" "$C_RESET" >&2
  printf '%s' "$def"
}

q_confirm() { # q_confirm <prompt> <yes|no>  -> 0 yes, 1 no
  local prompt_text="$1" def="${2:-no}"
  if [ "$INTERACTIVE" = 0 ]; then
    if [ "$def" = yes ]; then
      say "$prompt_text → yes (not interactive: the default stands)"
      return 0
    fi
    say "$prompt_text → no (not interactive: the default stands)"
    return 1
  fi
  if [ "$gum_prompt" = 1 ]; then
    if [ "$def" = yes ]; then
      gum confirm --affirmative 'Yes' --negative 'No' --default "$prompt_text" && return 0
    else
      gum confirm --affirmative 'Yes' --negative 'No' "$prompt_text" && return 0
    fi
    return 1
  fi
  local suffix='[y/N]'; [ "$def" = yes ] && suffix='[Y/n]'
  local ans; ans="$(prompt_read "  $prompt_text $suffix ")"
  case "$ans" in
    '') [ "$def" = yes ]; return $? ;;
    [yY]*) return 0 ;;
    *) return 1 ;;
  esac
}

q_input() { # q_input <header> <default>; echoes the answer
  local header="$1" def="$2"
  if [ "$INTERACTIVE" = 0 ]; then take_default "$header" "$def"; return 0; fi
  if [ "$gum_prompt" = 1 ]; then
    local chosen
    if ! chosen="$(gum input --header "$header" --value "$def" --placeholder "$def" --width 60 2>/dev/null)"; then
      GUM_CANCELLED=1; printf '%s' "$def"; return 1
    fi
    [ -z "$chosen" ] && chosen="$def"
    printf '%s' "$chosen"; return 0
  fi
  printf '\n  %s%s%s\n' "$C_BOLD" "$header" "$C_RESET" >&2
  local ans; ans="$(prompt_read "  [$def]: ")"
  [ -z "$ans" ] && ans="$def"
  printf '%s' "$ans"
}

q_multi() { # q_multi <header> <defaults: space-separated indices> <option...>
  # echoes the selected indices, space separated, in list order
  local header="$1" defs="$2"; shift 2
  local n=$# i=1
  if [ "$INTERACTIVE" = 0 ]; then take_default "$header" "$defs"; return 0; fi
  if [ "$gum_prompt" = 1 ]; then
    local selected_label='' o
    for o in "$@"; do
      case " $defs " in
        *" $i "*) [ -z "$selected_label" ] && selected_label="$o" || selected_label="$selected_label,$o" ;;
      esac
      i=$((i + 1))
    done
    local out
    if [ -n "$selected_label" ]; then
      out="$(gum choose --no-limit --height 14 --cursor-prefix '• ' --selected-prefix '✓ ' \
               --unselected-prefix '• ' --selected "$selected_label" --header "$header" "$@" 2>/dev/null)" \
        || { GUM_CANCELLED=1; printf '%s' "$defs"; return 1; }
    else
      out="$(gum choose --no-limit --height 14 --cursor-prefix '• ' --selected-prefix '✓ ' \
               --unselected-prefix '• ' --header "$header" "$@" 2>/dev/null)" \
        || { GUM_CANCELLED=1; printf '%s' "$defs"; return 1; }
    fi
    # gum echoes the labels it returned, verbatim, one per line: map them back.
    local picked='' line
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      i=1
      for o in "$@"; do
        if [ "$o" = "$line" ]; then
          case " $picked " in *" $i "*) ;; *) picked="$picked $i" ;; esac
          break
        fi
        i=$((i + 1))
      done
    done <<< "$out"
    printf '%s' "${picked# }"
    return 0
  fi
  printf '\n  %s%s%s\n' "$C_BOLD" "$header" "$C_RESET" >&2
  for o in "$@"; do
    case " $defs " in
      *" $i "*) printf '    %s[%s]%s %d) %s\n' "$C_GREEN" 'x' "$C_RESET" "$i" "$o" >&2 ;;
      *)        printf '    [ ] %d) %s\n' "$i" "$o" >&2 ;;
    esac
    i=$((i + 1))
  done
  local attempt=0 ans picked tok rest
  while [ "$attempt" -lt 3 ]; do
    ans="$(prompt_read "  select (numbers, comma separated; enter = the [x] ones): ")"
    if [ -z "$ans" ]; then printf '%s' "$defs"; return 0; fi
    picked=''
    rest="$ans"
    while [ -n "$rest" ]; do
      case "$rest" in
        *[,\ ]*) tok="${rest%%[,\ ]*}"; rest="${rest#*[,\ ]}" ;;
        *)       tok="$rest"; rest='' ;;
      esac
      [ -z "$tok" ] && continue
      case "$tok" in
        *[!0-9]*) printf '  %signoring "%s" — not a number%s\n' "$C_YELLOW" "$tok" "$C_RESET" >&2 ;;
        *) if [ "$tok" -ge 1 ] && [ "$tok" -le "$n" ]; then
             case " $picked " in *" $tok "*) ;; *) picked="$picked $tok" ;; esac
           else
             printf '  %signoring %s — only 1..%d exist%s\n' "$C_YELLOW" "$tok" "$n" "$C_RESET" >&2
           fi ;;
      esac
    done
    if [ -z "$picked" ]; then
      printf '  %sno valid numbers — as a fallback, the default set stands: %s%s\n' \
        "$C_YELLOW" "$defs" "$C_RESET" >&2
      printf '%s' "$defs"; return 0
    fi
    printf '%s' "${picked# }"; return 0
  done
  printf '%s' "$defs"
}

# --- command helpers --------------------------------------------------------
plain_table() { # plain_table <row...> where a row is "a|b|c|d"
  local w1=0 w2=0 w3=0 w4=0 row t s v n
  for row in "$@"; do
    IFS='|' read -r t s v n <<< "$row"
    [ "${#t}" -gt "$w1" ] && w1=${#t}
    [ "${#s}" -gt "$w2" ] && w2=${#s}
    [ "${#v}" -gt "$w3" ] && w3=${#v}
    [ "${#n}" -gt "$w4" ] && w4=${#n}
  done
  local line
  line="$(printf -- '─%.0s' $(seq 1 $((w1 + w2 + w3 + w4 + 13))))"
  printf '    %s\n' "$line"
  printf '    %-*s  %-*s  %-*s  %s\n' "$w1" tool "$w2" status "$w3" version "needed for"
  printf '    %s\n' "$line"
  for row in "$@"; do
    IFS='|' read -r t s v n <<< "$row"
    printf '    %-*s  %-*s  %-*s  %s\n' "$w1" "$t" "$w2" "$s" "$w3" "$v" "$n"
  done
  printf '    %s\n' "$line"
}

render_table() { # render_table <row...>; rows are "a|b|c|d", no header row
  if [ "$gum_style" = 1 ]; then
    printf '%s\n' "$@" | gum table --print --separator '|' \
      --columns 'tool,status,version,needed for' --border rounded --border.foreground 99
  else
    plain_table "$@"
  fi
}

ver_ge() { # ver_ge A B  -> A >= B (numeric major.minor)
  local a="${1#v}" b="${2#v}" amaj amin bmaj bmin
  amaj="${a%%.*}"; a="${a#*.}"
  if [ "$a" = "$amaj" ]; then amin=0; else amin="${a%%.*}"; fi
  bmaj="${b%%.*}"; b="${b#*.}"
  if [ "$b" = "$bmaj" ]; then bmin=0; else bmin="${b%%.*}"; fi
  amaj="${amaj//[!0-9]/}"; amin="${amin//[!0-9]/}"
  bmaj="${bmaj//[!0-9]/}"; bmin="${bmin//[!0-9]/}"
  [ -n "$amaj" ] || amaj=0; [ -n "$amin" ] || amin=0
  [ -n "$bmaj" ] || bmaj=0; [ -n "$bmin" ] || bmin=0
  [ "$amaj" -gt "$bmaj" ] && return 0
  [ "$amaj" -lt "$bmaj" ] && return 1
  [ "$amin" -ge "$bmin" ]
}

# --- platform + fix commands ------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

pkgs() { # the install command for package $1 on this platform, or ''
  local want="$1"
  if [ "$OS" = Darwin ]; then
    case "$want" in
      git)    printf 'brew install git' ;;
      node)   printf 'brew install node' ;;
      go)     printf 'brew install go' ;;
      cargo)  printf 'curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
      curl)   printf 'brew install curl' ;;
    esac
    return
  fi
  local pm=''
  for c in apt-get dnf pacman zypper apk; do
    if command -v "$c" >/dev/null 2>&1; then pm="$c"; break; fi
  done
  case "$pm" in
    apt-get)
      case "$want" in
        git)   printf 'sudo apt-get install -y git' ;;
        node)  printf 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs' ;;
        go)    printf 'sudo apt-get install -y golang-go   # if that lands below %s, use https://go.dev/dl/' "$GO_FLOOR" ;;
        cargo) printf 'curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
        curl)  printf 'sudo apt-get install -y curl' ;;
      esac
      ;;
    dnf)
      case "$want" in
        git)   printf 'sudo dnf install -y git' ;;
        node)  printf 'sudo dnf module install -y nodejs:22' ;;
        go)    printf 'sudo dnf install -y golang' ;;
        cargo) printf 'curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
        curl)  printf 'sudo dnf install -y curl' ;;
      esac
      ;;
    pacman)
      case "$want" in
        git)   printf 'sudo pacman -S --needed git' ;;
        node)  printf 'sudo pacman -S --needed nodejs npm' ;;
        go)    printf 'sudo pacman -S --needed go' ;;
        cargo) printf 'sudo pacman -S --needed rust' ;;
        curl)  printf 'sudo pacman -S --needed curl' ;;
      esac
      ;;
    zypper)
      case "$want" in
        git)   printf 'sudo zypper install -y git' ;;
        node)  printf 'sudo zypper install -y nodejs22' ;;
        go)    printf 'sudo zypper install -y go' ;;
        cargo) printf 'curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
        curl)  printf 'sudo zypper install -y curl' ;;
      esac
      ;;
    apk)
      case "$want" in
        git)   printf 'sudo apk add git' ;;
        node)  printf 'sudo apk add nodejs npm' ;;
        go)    printf 'sudo apk add go' ;;
        cargo) printf 'sudo apk add cargo' ;;
        curl)  printf 'sudo apk add curl' ;;
      esac
      ;;
    *)
      case "$want" in
        git)   printf 'install git with your package manager' ;;
        node)  printf 'install Node %s+ from https://nodejs.org/en/download' "$NODE_FLOOR" ;;
        go)    printf 'install Go %s+ from https://go.dev/dl/' "$GO_FLOOR" ;;
        cargo) printf 'curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
        curl)  printf 'install curl with your package manager' ;;
      esac
      ;;
  esac
}

needs_sudo() { # 1 when the fix command above wants root (we never run it ourselves)
  case "$(pkgs "$1")" in *sudo*) return 0 ;; *) return 1 ;; esac
}

on_path() { # 0 when $1 is already one of the PATH entries
  case ":${PATH}:" in *":$1:"*) return 0 ;; *) return 1 ;; esac
}

# Is <pkg-dir>'s node_modules already in step with its lockfile? Compare against
# the lockfile npm itself keeps inside node_modules — a directory mtime is not a
# signal, because npm rewrites files inside it without touching the directory.
npm_fresh() {
  local d="$1" marker
  [ -d "$d/node_modules" ] || return 1
  marker="$d/node_modules/.package-lock.json"
  [ -f "$marker" ] || marker="$d/node_modules"
  if [ -f "$d/package-lock.json" ] && [ "$d/package-lock.json" -nt "$marker" ]; then
    return 1
  fi
  return 0
}

# --- plan -------------------------------------------------------------------
# One entry per command we may run: "id|label|dir|command"
PLAN=()
plan_add() { PLAN+=("$1|$2|$3|$4"); }
plan_has() {
  local e
  for e in ${PLAN[@]+"${PLAN[@]}"}; do
    [ "${e%%|*}" = "$1" ] && return 0
  done
  return 1
}

FAILED=()      # human sentences, printed at the end
FAIL_IDS=()    # step ids, for the fix hints
fail_add() { FAILED+=("$1"); FAIL_IDS+=("$2"); }

fix_hint() { # fix_hint <step-id> -> the command that fixes it
  case "$1" in
    iface)   printf '%s   then re-run: ./scripts/install.sh --yes' "$(pkgs go)" ;;
    agent)   printf 'cd %s/agent && npm install --silent   (that is the whole step)' "$ROOT" ;;
    harness) printf 'cd %s/harness-engine && npm install --silent' "$ROOT" ;;
    memory)  printf 'cd %s/memory-layer && cargo build --bin memsrv' "$ROOT" ;;
    install) printf 'mkdir -p %s && cp %s/tui-go/mnemo %s/mnemo' "$BIN_DIR" "$ROOT" "$BIN_DIR" ;;
    gum_go)  printf '%s' "$(pkgs go)" ;;
    gum_dl)  printf 'download the tarball by hand: https://github.com/%s/releases' "$GUM_REPO" ;;
    verify)  printf '%s/tui-go/mnemo --dump --rows 20 --cols 80   (run it by hand to see the error)' "$ROOT" ;;
    *)       printf 're-run: ./scripts/install.sh' ;;
  esac
}

# Run a step with (where possible) a gum spinner, capturing output and the exit
# status separately, because the status is the part that must not be guessed.
LOG_DIR=''
logs_init() {
  if [ -z "$LOG_DIR" ]; then
    LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemo-install.XXXXXX" 2>/dev/null || echo "${TMPDIR:-/tmp}/mnemo-install.$$")"
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}}"
  fi
}

# Invoked indirectly: it is the EXIT/INT/TERM trap immediately below.
# shellcheck disable=SC2329
cleanup_logs() {
  local rc=$?
  trap - EXIT INT TERM
  [ -n "${CANDIDATE:-}" ] && rm -f "$CANDIDATE" 2>/dev/null
  if [ -n "$LOG_DIR" ] && [ -d "$LOG_DIR" ] && [ "$rc" = 0 ] && [ "${MNEMO_KEEP_LOGS:-0}" != 1 ]; then
    rm -rf "$LOG_DIR" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup_logs EXIT INT TERM

run_step() { # run_step <id> <title> <dir> <command...>
  local id="$1" title="$2" dir="$3"; shift 3
  local log st rc
  if [ "$DRY_RUN" = 1 ]; then
    printf '        would run:  (cd %s && %s)\n' "$dir" "$*"
    return 0
  fi
  logs_init
  log="$LOG_DIR/$id.log"
  st="$LOG_DIR/$id.status"
  : > "$log"
  rm -f "$st"
  if [ "$gum_spin" = 1 ]; then
    # $1..$4 are positional parameters of the child shell on purpose: the command
    # text must reach it unexpanded, so the single quotes are the point here.
    # shellcheck disable=SC2016
    gum spin --spinner dot --title "  $title" -- bash -c \
      'cd "$1" || exit 125; eval "$2" >"$3" 2>&1; printf "%s" "$?" >"$4"' \
      _ "$dir" "$*" "$log" "$st"
  else
    printf '    %s%s%s ...\n' "$C_DIM" "$title" "$C_RESET"
    ( cd "$dir" 2>/dev/null || exit 125; eval "$*" ) >"$log" 2>&1
    printf '%s' "$?" >"$st"
  fi
  if [ ! -s "$st" ]; then
    err "$title — the step never reported an exit status (spinner/wrapper problem)"
    printf '        log: %s\n' "$log" >&2
    return 125
  fi
  rc="$(cat "$st")"
  case "$rc" in *[!0-9]*) rc=1 ;; esac
  if [ "$rc" != 0 ]; then
    err "$title — exit $rc"
    printf '        log: %s\n' "$log" >&2
    printf '        last lines:\n' >&2
    tail -n 12 "$log" 2>/dev/null | while IFS= read -r l; do printf '          %s\n' "$l" >&2; done
    return "$rc"
  fi
  return 0
}

# Run a one-off command for the gum bootstrap, same status discipline.
run_plain() { # run_plain <title> <dir> <command...>
  local title="$1" dir="$2"; shift 2
  if [ "$DRY_RUN" = 1 ]; then
    printf '        would run:  (cd %s && %s)\n' "$dir" "$*"
    return 0
  fi
  logs_init
  local log="$LOG_DIR/bootstrap.log" st="$LOG_DIR/bootstrap.status"
  : > "$log"; rm -f "$st"
  if [ "$gum_spin" = 1 ]; then
    # shellcheck disable=SC2016
    gum spin --spinner dot --title "  $title" -- bash -c \
      'cd "$1" || exit 125; eval "$2" >"$3" 2>&1; printf "%s" "$?" >"$4"' \
      _ "$dir" "$*" "$log" "$st"
  else
    printf '    %s%s%s ...\n' "$C_DIM" "$title" "$C_RESET"
    ( cd "$dir" 2>/dev/null || exit 125; eval "$*" ) >"$log" 2>&1
    printf '%s' "$?" >"$st"
  fi
  [ -s "$st" ] || return 1
  local rc; rc="$(cat "$st")"
  case "$rc" in *[!0-9]*) rc=1 ;; esac
  if [ "$rc" != 0 ]; then
    err "$title — exit $rc"
    tail -n 8 "$log" 2>/dev/null | while IFS= read -r l; do printf '          %s\n' "$l" >&2; done
  fi
  return "$rc"
}

# ============================================================================
# 0. BANNER
# ============================================================================
printf '\n'
if [ "$gum_style" = 1 ]; then
  gum style --border double --border-foreground 99 --padding '0 2' --align center --foreground 99 \
    'Mnemo — onboarding' '' 'sessions · memory · an agent runtime you can read'
else
  printf '%s\n' "+--------------------------------------------------+"
  printf '%s\n' "|                    Mnemo                         |"
  printf '%s\n' "|   onboarding: sessions . memory . an agent        |"
  printf '%s\n' "+--------------------------------------------------+"
fi
printf '\n'
raw "This will touch:  this checkout's build outputs, ${BIN_DIR}, and (only if you"
raw "                  say yes) one marked block in one shell rc file."
raw "It will not touch: ~/.mnemo — your sessions, logs and auth are yours."
raw "                  No sudo, no deletions, nothing else on your disk."
if [ "$DRY_RUN" = 1 ]; then
  printf '\n'
  if [ "$gum_style" = 1 ]; then gum style --foreground 214 '  DRY RUN: every command below is printed, none is executed.'
  else printf '  %sDRY RUN: every command below is printed, none is executed.%s\n' "$C_YELLOW" "$C_RESET"; fi
fi
if [ "$ASSUME_YES" = 1 ]; then
  raw "  --yes: every default is taken, nothing is asked."
elif [ "$INTERACTIVE" = 0 ]; then
  printf '\n'
  if [ "$gum_style" = 1 ]; then
    gum style --foreground 214 '  Not a terminal: taking the defaults — nothing will be asked.'
    gum style --faint '  Run this from a real terminal with no flags to choose interactively.'
  else
    printf '  %sNot a terminal: taking the defaults — nothing will be asked.%s\n' "$C_YELLOW" "$C_RESET"
    printf '  %sRun this from a real terminal with no flags to choose interactively.%s\n' "$C_DIM" "$C_RESET"
  fi
fi

# ============================================================================
# 0½ GUM BOOTSTRAP — the point is that gum is optional, not a prerequisite
# ============================================================================
step_hdr 'gum (optional, but nicer)'

gum_go_route() {
  # Go is already a hard requirement of this project, so this route needs no
  # sudo and no new trust decision — hence first.
  if ! command -v go >/dev/null 2>&1; then
    warn "no go on PATH — this route needs it: $(pkgs go)"
    return 1
  fi
  local gopath_bin
  gopath_bin="$(go env GOPATH 2>/dev/null)/bin"
  run_plain "go install ${GUM_REPO}@latest" "${HOME}" "go install ${GUM_REPO}@latest" || return 1
  case ":${PATH}:" in
    *":${gopath_bin}:"*) ;;
    *) PATH="${gopath_bin}:${PATH}"; export PATH ;;
  esac
  refresh_gum
  [ -n "$gum_bin" ]
}

latest_gum_version() {
  local out=''
  if command -v curl >/dev/null 2>&1; then
    out="$(curl -fsSL --max-time 20 "https://api.github.com/repos/${GUM_REPO}/releases/latest" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    out="$(wget -qO- --timeout=20 "https://api.github.com/repos/${GUM_REPO}/releases/latest" 2>/dev/null || true)"
  fi
  out="$(printf '%s\n' "$out" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$out" ] || out="$GUM_FALLBACK_VERSION"
  printf '%s' "$out"
}

gum_asset() { # gum_asset <os> <arch> -> release asset name, or nothing
  case "$1:$2" in
    Darwin:x86_64) printf 'Darwin_x86_64' ;;
    Darwin:arm64)  printf 'Darwin_arm64' ;;
    Linux:x86_64)  printf 'Linux_x86_64' ;;
    Linux:arm64)   printf 'Linux_arm64' ;;
    Linux:armv7)   printf 'Linux_armv7' ;;
    Linux:armv6)   printf 'Linux_armv6' ;;
    Linux:i386)    printf 'Linux_i386' ;;
  esac
}

gum_release_route() {
  local dos="$OS" darch="$ARCH" asset=''
  case "$dos" in Darwin) ;; Linux) ;; *) warn "no prebuilt gum for $dos — use the go route or skip"; return 1 ;; esac
  case "$darch" in
    x86_64|amd64)   darch=x86_64 ;;
    aarch64|arm64)  darch=arm64 ;;
    armv7l|armv7)   darch=armv7 ;;
    armv6l)         darch=armv6 ;;
    i386|i686)      darch=i386 ;;
    *) warn "no prebuilt gum for $darch — use the go route or skip"; return 1 ;;
  esac
  asset="$(gum_asset "$dos" "$darch")"
  [ -n "$asset" ] || { warn "no prebuilt gum for $dos/$darch"; return 1; }
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    warn "neither curl nor wget is here — this route needs one of them: $(pkgs curl)"
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    warn "tar is not on PATH — no way to unpack the release"
    return 1
  fi
  local ver url tmp
  ver="${MNEMO_GUM_VERSION:-$(latest_gum_version)}"
  url="https://github.com/${GUM_REPO}/releases/download/v${ver}/gum_${ver}_${asset}.tar.gz"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mnemo-gum.XXXXXX" 2>/dev/null || echo "${TMPDIR:-/tmp}/mnemo-gum.$$")"
  mkdir -p "$tmp" 2>/dev/null || true
  if [ "$DRY_RUN" = 1 ]; then
    printf '        would run:  mkdir -p %s && curl -fsSL -o %s/gum.tar.gz %s\n' "$BIN_DIR" "$tmp" "$url"
    printf '        would run:  tar -xzf %s/gum.tar.gz -C %s && cp %s/gum %s/gum && chmod +x %s/gum\n' \
      "$tmp" "$tmp" "$tmp" "$BIN_DIR" "$BIN_DIR"
    warn "dry run: gum stays missing, so the plain prompts are what you would see"
    return 1
  fi
  local dlok=0
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "$tmp/gum.tar.gz" "$url" && dlok=1
  else
    wget -q --timeout=120 -O "$tmp/gum.tar.gz" "$url" && dlok=1
  fi
  if [ "$dlok" != 1 ] || [ ! -s "$tmp/gum.tar.gz" ]; then
    warn "could not download gum $ver for $asset: $url"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! tar -xzf "$tmp/gum.tar.gz" -C "$tmp" 2>/dev/null; then
    warn "the gum tarball did not unpack (tar said no)"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  find "$tmp" -type f -name gum -print > "$tmp/list" 2>/dev/null
  local found; found="$(head -n 1 "$tmp/list" 2>/dev/null || true)"
  if [ -z "$found" ] || [ ! -f "$found" ]; then
    warn "no gum binary inside $tmp (release layout changed?)"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  mkdir -p "$BIN_DIR" 2>/dev/null || true
  if ! cp "$found" "$BIN_DIR/gum" 2>/dev/null; then
    warn "could not write $BIN_DIR/gum — try: ./scripts/install.sh --bin-dir \"\$HOME/bin\""
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  chmod +x "$BIN_DIR/gum" 2>/dev/null || true
  rm -rf "$tmp" 2>/dev/null || true
  case ":${PATH}:" in *":${BIN_DIR}:"*) ;; *) PATH="${BIN_DIR}:${PATH}"; export PATH ;; esac
  refresh_gum
  [ -n "$gum_bin" ]
}

if [ -n "$gum_bin" ]; then
  ok "gum $("$gum_bin" --version 2>/dev/null | awk '{print $NF}') already on PATH ($gum_bin)"
elif [ "$NO_GUM" = 1 ]; then
  say "--no-gum: every question below is a plain numbered prompt."
elif [ "$INTERACTIVE" = 0 ]; then
  say "not installing gum: this run is non-interactive, so nothing is asked and"
  say "every question takes its default. (An installer should not add tools behind"
  say "your back either.) Get it later with either of:"
  say "  go install ${GUM_REPO}@latest"
  say "  or re-run ./scripts/install.sh from a real terminal and pick route 2."
else
  say "gum is not installed. It draws the prompts for the next few questions."
  say "Without it you still get every choice — as numbered menus."
  printf '\n'
  say "  1) go install ${GUM_REPO}@latest        <- recommended"
  say "       Go >= ${GO_FLOOR} is already required by this project, so this needs no sudo."
  say "  2) download the gum release tarball into ${BIN_DIR}"
  say "       curl/wget + tar, no Go needed."
  say "  3) carry on without gum"
  say "       plain prompts; completely supported."
  route="$(q_choose "How should this installer get gum?" 1 \
    "go install ${GUM_REPO}@latest (needs Go >= ${GO_FLOOR}, no sudo)" \
    "download the gum release tarball into ${BIN_DIR}" \
    "carry on without gum (plain numbered prompts)")"
  case "$route" in
    1)
      if gum_go_route; then
        ok "gum is on PATH now (${gum_bin})"
      else
        warn "the go route did not produce a gum binary; trying the release tarball instead"
        if gum_release_route; then ok "gum is on PATH now (${gum_bin})"
        else warn "no gum — carrying on with the plain prompts"; fi
      fi
      ;;
    2)
      if gum_release_route; then ok "gum $("$gum_bin" --version 2>/dev/null | awk '{print $NF}') installed to ${BIN_DIR}"
      else
        warn "the tarball route failed; trying go install instead"
        if gum_go_route; then ok "gum is on PATH now (${gum_bin})"
        else warn "no gum — carrying on with the plain prompts"; fi
      fi
      ;;
    *)
      say "no gum — plain prompts it is. Every question is still asked."
      ;;
  esac
fi
[ "$GUM_CANCELLED" = 1 ] && { printf '\ncancelled.\n'; exit 130; }

# ============================================================================
# 1. PREFLIGHT
# ============================================================================
step_hdr 'preflight — what this machine has'

TOOLS=('git' 'node' 'go' 'npm' 'cargo')
ROWS=()
HARD_MISSING=()   # "tool|version|fix|needsudo"

probe() { command -v "$1" 2>/dev/null || true; }

GIT_V=''; NODE_V=''; GO_V=''; NPM_V=''; CARGO_V=''
NODE_OK=0; GO_OK=0; NPM_OK=0; CARGO_OK=0
PREBUILT=0
[ -x "$ROOT/tui-go/mnemo" ] && PREBUILT=1

for t in "${TOOLS[@]}"; do
  have="$(probe "$t")"
  case "$t" in
    git)
      if [ -n "$have" ]; then
        GIT_V="$("$have" --version 2>/dev/null | awk '{print $3}')"; GIT_V="${GIT_V:-unknown}"
        ROWS+=("git|ok|${GIT_V}|checkout, updates")
      else
        ROWS+=("git|MISSING|-|checkout, updates")
        HARD_MISSING+=("git|not installed|$(pkgs git)|$(needs_sudo git && echo yes || echo no)")
      fi
      ;;
    node)
      if [ -n "$have" ]; then
        NODE_V="$("$have" -p 'process.versions.node' 2>/dev/null || "$have" -v 2>/dev/null)"
        NODE_V="${NODE_V#v}"
        if ver_ge "$NODE_V" "$NODE_FLOOR"; then
          NODE_OK=1; ROWS+=("node|ok|${NODE_V}|the agent runtime runs .ts directly")
        else
          ROWS+=("node|TOO OLD|${NODE_V} (needs ${NODE_FLOOR}+)|the agent runtime runs .ts directly")
          HARD_MISSING+=("node|${NODE_V} is below the ${NODE_FLOOR} floor — below it every .ts file dies on a type annotation, which reads as a Mnemo bug|$(pkgs node)|$(needs_sudo node && echo yes || echo no)")
        fi
      else
        ROWS+=("node|MISSING|needs ${NODE_FLOOR}+|the agent runtime runs .ts directly")
        HARD_MISSING+=("node|not installed|$(pkgs node)|$(needs_sudo node && echo yes || echo no)")
      fi
      ;;
    go)
      if [ -n "$have" ]; then
        GO_V="$("$have" version 2>/dev/null | awk '{print $3}')"; GO_V="${GO_V#go}"
        if ver_ge "$GO_V" "$GO_FLOOR"; then
          GO_OK=1; ROWS+=("go|ok|${GO_V}|builds the interface (tui-go)")
        else
          ROWS+=("go|TOO OLD|${GO_V} (needs ${GO_FLOOR}+)|builds the interface (tui-go)")
          HARD_MISSING+=("go|${GO_V} is below ${GO_FLOOR}|$(pkgs go)|$(needs_sudo go && echo yes || echo no)")
        fi
      elif [ "$PREBUILT" = 1 ]; then
        ROWS+=("go|absent|using tui-go/mnemo|builds the interface (prebuilt binary is here)")
      else
        ROWS+=("go|MISSING|needs ${GO_FLOOR}+|builds the interface (tui-go)")
        HARD_MISSING+=("go|not installed, and there is no prebuilt tui-go/mnemo|$(pkgs go)|$(needs_sudo go && echo yes || echo no)")
      fi
      ;;
    npm)
      if [ -n "$have" ]; then
        NPM_V="$("$have" -v 2>/dev/null)"; NPM_OK=1
        ROWS+=("npm|ok|${NPM_V}|installs agent/ and harness-engine/")
      else
        ROWS+=("npm|MISSING|-|installs agent/ and harness-engine/")
        HARD_MISSING+=("npm|not on PATH (it ships with Node)|reinstall Node: $(pkgs node)|$(needs_sudo node && echo yes || echo no)")
      fi
      ;;
    cargo)
      if [ -n "$have" ]; then
        CARGO_V="$("$have" --version 2>/dev/null | awk '{print $2}')"; CARGO_OK=1
        ROWS+=("cargo|ok|${CARGO_V:-unknown}|the memory sidecar (optional)")
      else
        ROWS+=("cargo|absent|-|the memory sidecar (optional — skipped, not fatal)")
      fi
      ;;
  esac
done

if [ "${#ROWS[@]}" -gt 0 ]; then
  printf '\n'
  render_table "${ROWS[@]}"
fi

if [ "${#HARD_MISSING[@]}" -gt 0 ]; then
  printf '\n'
  for m in "${HARD_MISSING[@]}"; do
    IFS='|' read -r name why fix sudo <<< "$m"
    err "${name}: ${why}"
    if [ "$sudo" = yes ]; then
      printf '        run this (it needs sudo — your call, this installer never runs it):\n' >&2
    else
      printf '        run this:\n' >&2
    fi
    printf '          %s\n' "$fix" >&2
  done
  printf '\n' >&2
  if [ "$DRY_RUN" = 1 ]; then
    warn "dry run: the plan below is what a healthy machine would run; the real run would stop here"
    PREFLIGHT_FAILED=1
  else
    err "stopping: a hard requirement is missing. Fix the line above, then re-run."
    printf '    Nothing was installed, nothing was changed.\n\n' >&2
    exit 1
  fi
else
  PREFLIGHT_FAILED=0
  ok "every hard requirement is satisfied"
fi
if [ "$CARGO_OK" = 1 ]; then
  ok "memory sidecar is possible (cargo ${CARGO_V:-?})"
else
  warn "cargo is absent — the memory pane will stay offline until Rust is installed: $(pkgs cargo)"
fi

# ============================================================================
# 2. COMPONENTS
# ============================================================================
step_hdr 'what to install'

C_IFACE=1; C_AGENT=2; C_MEMORY=3; C_HARNESS=4; C_PATH=5

iface_label='interface        build tui-go/ (Go) and install the binary'
agent_label='agent runtime    npm install in agent/'
memory_label='memory sidecar   cargo build in memory-layer/ (optional)'
harness_label='harness engine   npm install in harness-engine/'
path_label="PATH integration put the binary in ${BIN_DIR} and on your PATH"

IFACE_POSSIBLE=0
if [ "$GO_OK" = 1 ] || [ "$PREBUILT" = 1 ]; then IFACE_POSSIBLE=1; fi
if [ "$IFACE_POSSIBLE" = 0 ]; then
  iface_label="${iface_label}   [unavailable: no Go ${GO_FLOOR}+ and no prebuilt tui-go/mnemo]"
elif [ "$GO_OK" = 0 ]; then
  iface_label="${iface_label}   [no Go: the prebuilt tui-go/mnemo will be installed as-is]"
fi

AGENT_POSSIBLE=0
if [ "$NODE_OK" = 1 ] && [ "$NPM_OK" = 1 ]; then AGENT_POSSIBLE=1
else
  agent_label="${agent_label}   [unavailable: needs node ${NODE_FLOOR}+ and npm]"
fi
HARNESS_POSSIBLE=$AGENT_POSSIBLE
[ "$HARNESS_POSSIBLE" = 0 ] && harness_label="${harness_label}   [unavailable: needs node ${NODE_FLOOR}+ and npm]"

MEMORY_POSSIBLE=$CARGO_OK
[ "$MEMORY_POSSIBLE" = 0 ] && memory_label="${memory_label}   [unavailable: cargo not on PATH]"

DEFAULTS=''
[ "$IFACE_POSSIBLE" = 1 ]   && DEFAULTS="$DEFAULTS $C_IFACE"
[ "$AGENT_POSSIBLE" = 1 ]   && DEFAULTS="$DEFAULTS $C_AGENT"
[ "$MEMORY_POSSIBLE" = 1 ]  && DEFAULTS="$DEFAULTS $C_MEMORY"
[ "$HARNESS_POSSIBLE" = 1 ] && DEFAULTS="$DEFAULTS $C_HARNESS"
[ "$IFACE_POSSIBLE" = 1 ]   && DEFAULTS="$DEFAULTS $C_PATH"
DEFAULTS="${DEFAULTS# }"

say "Everything possible on this machine is preselected. Nothing is silent:"
say "an impossible component is annotated with why, and never dropped quietly."
printf '\n'
picked="$(q_multi "Which components?" "$DEFAULTS" \
  "$iface_label" "$agent_label" "$memory_label" "$harness_label" "$path_label")"
[ "$GUM_CANCELLED" = 1 ] && { printf '\ncancelled.\n'; exit 130; }

WANT_IFACE=0; WANT_AGENT=0; WANT_MEMORY=0; WANT_HARNESS=0; WANT_PATH=0
for p in $picked; do
  case "$p" in
    "$C_IFACE")   WANT_IFACE=1 ;;
    "$C_AGENT")   WANT_AGENT=1 ;;
    "$C_MEMORY")  WANT_MEMORY=1 ;;
    "$C_HARNESS") WANT_HARNESS=1 ;;
    "$C_PATH")    WANT_PATH=1 ;;
  esac
done

# A selection that is impossible never dies quietly at execute time.
if [ "$WANT_IFACE" = 1 ] && [ "$IFACE_POSSIBLE" = 0 ]; then
  warn "interface: asked for, but impossible here — no Go ${GO_FLOOR}+ and no prebuilt binary"
  warn "           fix: $(pkgs go)"
  WANT_IFACE=0
fi
if [ "$WANT_AGENT" = 1 ] && [ "$AGENT_POSSIBLE" = 0 ]; then
  warn "agent runtime: asked for, but node ${NODE_FLOOR}+ and npm are required — fix: $(pkgs node)"
  WANT_AGENT=0
fi
if [ "$WANT_HARNESS" = 1 ] && [ "$HARNESS_POSSIBLE" = 0 ]; then
  warn "harness engine: asked for, but node ${NODE_FLOOR}+ and npm are required — fix: $(pkgs node)"
  WANT_HARNESS=0
fi
if [ "$WANT_MEMORY" = 1 ] && [ "$MEMORY_POSSIBLE" = 0 ]; then
  warn "memory sidecar: asked for, but cargo is not installed — fix: $(pkgs cargo)"
  warn "                (skipping it; nothing else changes)"
  WANT_MEMORY=0
fi
if [ "$WANT_PATH" = 1 ] && [ "$IFACE_POSSIBLE" = 0 ]; then
  warn "PATH integration needs a binary to install — fix: $(pkgs go)"
  WANT_PATH=0
fi

# ============================================================================
# 3. INSTALL LOCATION
# ============================================================================
step_hdr 'where the binary goes'

if [ "$WANT_PATH" = 1 ]; then
  say "Used for the mnemo binary and the PATH line — nothing else on disk moves."
  new_bin="$(q_input "Install directory" "$BIN_DIR")"
  [ "$GUM_CANCELLED" = 1 ] && { printf '\ncancelled.\n'; exit 130; }
  # Same literal-tilde reason as above: this is what the user typed.
  # shellcheck disable=SC2088
  case "$new_bin" in
    '~'|'~/'*) new_bin="${HOME}${new_bin#\~}" ;;
  esac
  case "$new_bin" in
    /*) BIN_DIR="$new_bin" ;;
    *)  warn "\"${new_bin}\" is relative — keeping the absolute default ${BIN_DIR}" ;;
  esac
  while [ "${BIN_DIR%/}" != "${BIN_DIR}" ] && [ "${BIN_DIR}" != "/" ]; do BIN_DIR="${BIN_DIR%/}"; done
  ok "binary goes to ${BIN_DIR}/mnemo"
else
  say "Skipped with PATH integration; nothing is copied anywhere."
fi

# ============================================================================
# 4. THE PLAN, AND THE CONFIRM
# ============================================================================
step_hdr 'exactly what is about to run'

# Interface: build a candidate OUTSIDE the repo, smoke-test it, and only then let
# it become tui-go/mnemo. A failing build can never clobber a working binary.
IFACE_SRC="$ROOT/tui-go/mnemo"

if [ "$WANT_IFACE" = 1 ] && [ "$GO_OK" = 1 ]; then
  stale=1
  if [ -f "$IFACE_SRC" ]; then
    logs_init
    find "$ROOT/tui-go" -name '*.go' -newer "$IFACE_SRC" -print > "$LOG_DIR/stale.txt" 2>/dev/null || true
    if [ -s "$LOG_DIR/stale.txt" ]; then stale=1; else
      if [ "$ROOT/tui-go/go.mod" -nt "$IFACE_SRC" ] 2>/dev/null; then stale=1; else stale=0; fi
    fi
  fi
  if [ "$stale" = 0 ]; then
    say "interface: tui-go/mnemo is newer than every source file — nothing to rebuild"
  else
    plan_add iface 'build the interface (go build ./cmd/mnemo)' "$ROOT/tui-go" 'go build -o mnemo.new ./cmd/mnemo'
  fi
else
  if [ "$WANT_IFACE" = 1 ] && [ "$PREBUILT" = 1 ]; then
    say "interface: no usable Go toolchain — the prebuilt tui-go/mnemo is installed as-is"
  fi
fi

if [ "$WANT_AGENT" = 1 ]; then
  if npm_fresh "$ROOT/agent"; then
    say "agent runtime: node_modules is newer than package-lock.json — already installed"
  else
    plan_add agent 'agent runtime (npm install)' "$ROOT/agent" 'npm install --silent'
  fi
fi

if [ "$WANT_MEMORY" = 1 ]; then
  # The sidecar is memsrv on Linux/macOS and memsrv.exe on Windows; accept
  # whichever of the two is actually there so "already built" is not a lie.
  MEMSRV_BIN="$ROOT/memory-layer/target/debug/memsrv"
  [ -f "$MEMSRV_BIN" ] || MEMSRV_BIN="$ROOT/memory-layer/target/debug/memsrv.exe"
  logs_init
  find "$ROOT/memory-layer/src" -name '*.rs' -newer "$MEMSRV_BIN" -print > "$LOG_DIR/rs.txt" 2>/dev/null || true
  fresh=0
  if [ -f "$MEMSRV_BIN" ] && [ ! -s "$LOG_DIR/rs.txt" ]; then fresh=1; fi
  if [ "$fresh" = 1 ]; then
    say "memory sidecar: $(basename -- "$MEMSRV_BIN") is newer than every source file — already built"
  else
    plan_add memory 'memory sidecar (cargo build --bin memsrv)' "$ROOT/memory-layer" 'cargo build --bin memsrv'
  fi
fi

if [ "$WANT_HARNESS" = 1 ]; then
  if npm_fresh "$ROOT/harness-engine"; then
    say "harness engine: node_modules is newer than package-lock.json — already installed"
  else
    plan_add harness 'harness engine (npm install)' "$ROOT/harness-engine" 'npm install --silent'
  fi
fi

if [ "$WANT_PATH" = 1 ]; then
  src="$ROOT/tui-go/mnemo"
  fresh=0
  if [ -f "$BIN_DIR/mnemo" ] && [ -f "$src" ] && [ ! "$src" -nt "$BIN_DIR/mnemo" ] 2>/dev/null; then fresh=1; fi
  # If the interface is being built in this same run, the copy would be stale the
  # moment it lands: force the install step instead of trusting the timestamps.
  if plan_has iface; then
    fresh=0
    say "install: the interface is being rebuilt, so ${BIN_DIR}/mnemo is refreshed with it"
  fi
  if [ "$fresh" = 1 ]; then
    say "install: ${BIN_DIR}/mnemo is already up to date with ${src}"
  else
    # Single quotes are deliberate: these variables are expanded by the shell
    # that runs the step, not by this line.
    # shellcheck disable=SC2016
    plan_add install "install the binary into ${BIN_DIR}" "$ROOT" 'mkdir -p "$BIN_DIR" && cp "$ROOT/tui-go/mnemo" "$BIN_DIR/mnemo" && chmod +x "$BIN_DIR/mnemo"'
  fi
fi

printf '\n'
if [ "${#PLAN[@]}" -eq 0 ]; then
  say "Nothing to run — this checkout is already installed and up to date."
  say "(That is the idempotence guarantee: a second run is a no-op, not a rebuild.)"
else
  say "Commands, in order:"
  printf '\n'
  raw "    (\$BIN_DIR is ${BIN_DIR}, \$ROOT is ${ROOT})"
  for e in ${PLAN[@]+"${PLAN[@]}"}; do
    rest="${e#*|}"; label="${rest%%|*}"; rest="${rest#*|}"; dir="${rest%%|*}"; cmd="${rest#*|}"
    raw "    (cd ${dir} && ${cmd})"
  done
fi
printf '\n'
say "Also: mkdir -p ${MNEMO_HOME} — created if missing, never written into."
say "No sudo anywhere in the list above."
if [ "$WANT_PATH" = 1 ] && ! on_path "$BIN_DIR"; then
  say "${BIN_DIR} is not on your PATH — this run will offer (never assume) one line in your shell rc."
fi

if [ "$PREFLIGHT_FAILED" = 1 ]; then
  printf '\n'
  err "dry run ends here: a hard requirement is missing, the real run would stop."
  exit 1
fi

if [ "${#PLAN[@]}" -gt 0 ] || [ "$WANT_PATH" = 1 ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    if ! q_confirm "Run this?" no; then
      printf '\ncancelled — nothing was run, nothing was changed.\n'
      exit 0
    fi
  else
    say "not interactive: running the plan above without asking."
  fi
fi
[ "$GUM_CANCELLED" = 1 ] && { printf '\ncancelled.\n'; exit 130; }

# ============================================================================
# 5. EXECUTE — report, never swallow
# ============================================================================
step_hdr 'installing'

if [ "${#PLAN[@]}" -gt 0 ]; then
  for e in ${PLAN[@]+"${PLAN[@]}"}; do
    id="${e%%|*}"; rest="${e#*|}"; label="${rest%%|*}"; rest="${rest#*|}"; dir="${rest%%|*}"; cmd="${rest#*|}"
    if run_step "$id" "$label" "$dir" "$cmd"; then
      if [ "$DRY_RUN" = 0 ]; then ok "$label"; fi
      # The interface build leaves its result in a temp candidate. Prove it runs
      # before letting it replace the binary that is already working.
      if [ "$id" = iface ] && [ "$DRY_RUN" = 0 ]; then
        if [ -f "$CANDIDATE" ]; then
          if "$CANDIDATE" --version >/dev/null 2>&1; then
            if cp "$CANDIDATE" "$ROOT/tui-go/mnemo" 2>/dev/null; then
              ok "the fresh build runs (--version ok) and is now tui-go/mnemo"
            else
              fail_add "interface: built a working binary but could not write ${ROOT}/tui-go/mnemo" iface
            fi
            rm -f "$CANDIDATE" 2>/dev/null || true
          else
            fail_add "interface: the fresh build does not run (--version failed) — the previous tui-go/mnemo was left in place" iface
            err "the fresh build does not run; keeping the previous tui-go/mnemo"
          fi
        else
          fail_add "interface: go build exited 0 but produced no binary at ${CANDIDATE}" iface
        fi
      fi
    else
      fail_add "$label — \`${cmd}\` in ${dir}" "$id"
    fi
  done
else
  dim "no build steps were needed"
fi

# PATH: exported for this session always; the rc line is opt-in, and the default
# is "no" so nothing of yours changes without a second yes.
RC_FILE=''; RC_WRITTEN=0
if [ "$WANT_PATH" = 1 ]; then
  if on_path "$BIN_DIR"; then
    ok "${BIN_DIR} is already on your PATH"
  else
    case "$(basename -- "${SHELL:-sh}")" in
      zsh) RC_CANDIDATES="$HOME/.zshrc $HOME/.zprofile $HOME/.profile" ;;
      bash) RC_CANDIDATES="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
      fish) RC_CANDIDATES="$HOME/.config/fish/config.fish" ;;
      *) RC_CANDIDATES="$HOME/.profile" ;;
    esac
    for f in $RC_CANDIDATES; do
      if [ -f "$f" ]; then RC_FILE="$f"; break; fi
    done
    [ -z "$RC_FILE" ] && RC_FILE="$HOME/.profile"
    export PATH="${BIN_DIR}:${PATH}"
    if [ -x "$BIN_DIR/mnemo" ]; then
      ok "added ${BIN_DIR} to PATH for this session — \`mnemo\` works here now"
    else
      warn "added ${BIN_DIR} to PATH for this session, but no binary landed there (see the failures below)"
    fi
    printf '\n'
    say "${BIN_DIR} is not in your shell's startup files. The line, for ${RC_FILE}:"
    raw "      export PATH=\"${BIN_DIR}:\$PATH\""
    if [ "$DRY_RUN" = 1 ]; then
      say "would ask before appending it to ${RC_FILE} (never without an explicit yes)"
    elif [ ! -x "$BIN_DIR/mnemo" ]; then
      say "not editing ${RC_FILE} — no binary is in ${BIN_DIR} yet"
    elif [ "$INTERACTIVE" = 0 ]; then
      say "non-interactive: not editing ${RC_FILE}. Add the line above when you want it."
    elif q_confirm "Append that one line to ${RC_FILE}?" no; then
      logs_init
      if {
        printf '\n# >>> mnemo >>>\n'
        printf '# added by %s/scripts/install.sh — remove these three lines to undo\n' "$ROOT"
        # $PATH must land in the rc file as a literal expansion, not now.
        # shellcheck disable=SC2016
        printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
        printf '# <<< mnemo <<<\n'
      } >> "$RC_FILE" 2>>"$LOG_DIR/rc.log"; then
        RC_WRITTEN=1
        ok "added the marked block to ${RC_FILE}"
      else
        warn "could not write ${RC_FILE} — add this line by hand:"
        warn "  export PATH=\"${BIN_DIR}:\$PATH\""
      fi
    else
      say "left ${RC_FILE} alone — add the line above when you want it."
    fi
  fi
fi

# ============================================================================
# 6. VERIFY — the part that makes this honest
# ============================================================================
step_hdr 'proving it works (offline, no agent, no network)'

# Run a command with a wall-clock guard, without assuming GNU `timeout` exists
# (macOS has none).
run_timed() { # run_timed <seconds> <outfile> <cmd...>
  local t="$1" out="$2"; shift 2
  : > "$out"
  "$@" >"$out" 2>&1 &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$t" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  return $?
}

if [ "$DRY_RUN" = 1 ]; then
  say "would run:  ${BIN_DIR}/mnemo --version"
  say "would run:  ${BIN_DIR}/mnemo --dump --rows 20 --cols 80"
  say "and would fail the install unless both exited 0."
else
  logs_init
  # Verify the binary this run is responsible for: the installed one if PATH
  # integration ran, otherwise the one the build produced.
  BIN_MNEMO=""
  if [ -x "$BIN_DIR/mnemo" ]; then
    BIN_MNEMO="$BIN_DIR/mnemo"
  elif [ -x "$ROOT/tui-go/mnemo" ]; then
    BIN_MNEMO="$ROOT/tui-go/mnemo"
    say "verifying ${BIN_MNEMO} instead of ${BIN_DIR}/mnemo"
  fi
  VER_TAIL=0
  if [ -z "$BIN_MNEMO" ]; then
    err "no mnemo binary to verify (looked in ${BIN_DIR}/mnemo and ${ROOT}/tui-go/mnemo)"
    fail_add "verify: no binary to run — fix: $(pkgs go) then ./scripts/install.sh" verify
    VER_TAIL=1
  else
    if run_timed 60 "$LOG_DIR/version.out" "$BIN_MNEMO" --version; then
      ok "\`${BIN_MNEMO} --version\` → $(head -n 1 "$LOG_DIR/version.out" 2>/dev/null)"
    else
      err "\`${BIN_MNEMO} --version\` did not exit 0"
      head -n 5 "$LOG_DIR/version.out" 2>/dev/null | while IFS= read -r l; do printf '        %s\n' "$l" >&2; done
      fail_add "verify: \`${BIN_MNEMO} --version\` failed" verify
      VER_TAIL=1
    fi
    if [ "$VER_TAIL" = 0 ]; then
      if run_timed 60 "$LOG_DIR/dump.out" "$BIN_MNEMO" --dump --rows 20 --cols 80; then
        ok "\`${BIN_MNEMO} --dump --rows 20 --cols 80\` → exit 0, $(wc -l < "$LOG_DIR/dump.out" | tr -d ' ') lines rendered"
        printf '\n'
        say "first lines of the frame it just rendered:"
        printf '\n'
        head -n 10 "$LOG_DIR/dump.out" | while IFS= read -r l; do printf '    | %s\n' "$l"; done
        printf '\n'
        # gum pager is deliberately NOT offered here. In gum 0.17 it ignores
        # --timeout and runs until a key quits it, so on an odd terminal or a
        # swallowed keypress it becomes a hang with no way out — the one failure
        # mode worse than an error message. The frame is one command away instead.
        say "the whole frame, whenever you want it:"
        raw "      ${BIN_MNEMO} --dump --rows 40 --cols 120"
        DUMP_OK=1
      else
        err "\`${BIN_MNEMO} --dump --rows 20 --cols 80\` did not exit 0"
        head -n 8 "$LOG_DIR/dump.out" 2>/dev/null | while IFS= read -r l; do printf '        %s\n' "$l" >&2; done
        fail_add "verify: \`${BIN_MNEMO} --dump --rows 20 --cols 80\` failed" verify
      fi
    fi
  fi

  # ~/.mnemo is the user's. We create it if it is missing and touch nothing else.
  printf '\n'
  if [ -d "$MNEMO_HOME" ]; then
    n_entries="$(find "$MNEMO_HOME" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
    ok "${MNEMO_HOME} already existed (${n_entries} entries) — untouched by this installer"
  else
    if mkdir -p "$MNEMO_HOME" 2>/dev/null; then
      ok "created ${MNEMO_HOME} (empty) — first run fills it"
    else
      warn "could not create ${MNEMO_HOME} — mnemo will fail to start: mkdir -p \"\$HOME/.mnemo\""
      fail_add "${MNEMO_HOME} could not be created" verify
    fi
  fi
fi

# ============================================================================
# 7. NEXT STEPS, AND WHAT WAS NOT DONE
# ============================================================================
step_hdr 'what to do now'

NEXT_BIN="${BIN_MNEMO:-$BIN_DIR/mnemo}"
NEXT_MD="## Next steps

- \`${NEXT_BIN} --version\` — the build you just installed
- \`mnemo --repo ${ROOT}\` — start it, pointed at this checkout
- \`/login\` — pick a provider and paste a key (first run)
- \`/model\` — choose what the agent runs as

Offline, no agent, no key: \`mnemo --dump --rows 20 --cols 80\`
"
if [ "$gum_style" = 1 ]; then
  printf '%s' "$NEXT_MD" | gum format --type markdown --theme pink | sed 's/^/  /'
else
  say "${NEXT_BIN} --version          # the build you just installed"
  say "mnemo --repo ${ROOT}"
  say "    then /login (pick a provider) and /model (pick a model)"
  say "offline check: mnemo --dump --rows 20 --cols 80"
fi

printf '\n'
say "Not done, on purpose:"
say "  · ~/.mnemo — nothing in it was read, written or removed; only mkdir if absent."
say "  · no sudo — not one step above needed it."
NOT_DONE=0
[ "$WANT_IFACE" = 0 ] && { say "  · interface — not selected"; NOT_DONE=1; }
[ "$WANT_AGENT" = 0 ] && { say "  · agent runtime — not selected (the agent will not start until: cd ${ROOT}/agent && npm install)"; NOT_DONE=1; }
[ "$WANT_MEMORY" = 0 ] && { say "  · memory sidecar — not selected (the Memory pane stays offline; fix: $(pkgs cargo))"; NOT_DONE=1; }
[ "$WANT_HARNESS" = 0 ] && { say "  · harness engine — not selected (tools will not be discovered)"; NOT_DONE=1; }
if [ "$WANT_PATH" = 1 ] && [ "$RC_WRITTEN" = 0 ] && [ -n "$RC_FILE" ]; then
  say "  · ${RC_FILE} — left alone; add the PATH line above if you want \`mnemo\` in new shells."
  NOT_DONE=1
fi
if [ -z "${gum_bin}" ]; then
  say "  · gum — not installed; the plain prompts were used. Install later: go install ${GUM_REPO}@latest"
  NOT_DONE=1
fi
[ "$NOT_DONE" = 0 ] && say "  · nothing — every selected component ran."
printf '\n'
say "Bugs and rough edges: ${ISSUES_URL}"
if [ "$DRY_RUN" = 1 ]; then
  say "Logs: none — a dry run writes nothing, not even a temp file it keeps."
elif [ -n "$LOG_DIR" ] && [ -d "$LOG_DIR" ]; then
  say "Logs from this run: ${LOG_DIR}"
fi

# ============================================================================
# FAILURE REPORT — the exit status is the summary
# ============================================================================
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\n'
  err "${#FAILED[@]} step(s) failed. The install is incomplete; the rest is usable."
  printf '\n'
  i=0
  for f in ${FAILED[@]+"${FAILED[@]}"}; do
    printf '    %s✗%s %s\n' "$C_RED" "$C_RESET" "$f" >&2
    printf '      fix: %s\n' "$(fix_hint "${FAIL_IDS[$i]}")" >&2
    i=$((i + 1))
  done
  printf '\n' >&2
  if [ -n "$LOG_DIR" ] && [ -d "$LOG_DIR" ]; then
    printf '    Full output of each step: %s (kept because something failed)\n\n' "$LOG_DIR" >&2
  fi
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '\n'
  ok "dry run complete — nothing was executed, nothing was changed."
  exit 0
fi

printf '\n'
if [ "$DUMP_OK" = 1 ]; then
  if [ "$gum_style" = 1 ]; then
    gum style --foreground 42 --bold '  Done — mnemo is installed and rendered a real frame.'
  else
    printf '    %s✓ Done — mnemo is installed and rendered a real frame.%s\n' "$C_GREEN" "$C_RESET"
  fi
else
  if [ "$gum_style" = 1 ]; then
    gum style --foreground 214 '  Finished, but no frame was rendered (the --dump check was skipped).'
  else
    printf '    %s! Finished, but no frame was rendered (the --dump check was skipped).%s\n' "$C_YELLOW" "$C_RESET"
  fi
fi
printf '\n'
exit 0

#!/usr/bin/env bash
# tags: build
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
build_helper=${BUILD_EDITOR_HELPER:-"$repo_root/hack/build-editor.sh"}
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source_builds() { awk '$1 == "source" { count++ } END { print count + 0 }' "$test_root/builds"; }

mkdir -p "$test_root/hack" "$test_root/editor"
cp "$build_helper" "$test_root/hack/build-editor.sh"
cp "$repo_root/editor/UPSTREAM" "$repo_root/editor/critic.bundle" \
    "$repo_root/editor/Containerfile" "$test_root/editor/"
sed 's|^ARG BASE=.*|ARG BASE=docker.io/library/node:20-bookworm|' \
    "$repo_root/editor/Containerfile.src" > "$test_root/editor/Containerfile.src"
grep -qx 'ARG BASE=docker.io/library/node:20-bookworm' \
    "$test_root/editor/Containerfile.src" || fail 'source base image declaration is missing'
touch "$test_root/images" "$test_root/builds"

cat > "$test_root/builder" <<'BUILDER'
#!/usr/bin/env bash
set -euo pipefail

case "$1" in
    inspect)
        [[ $# == 4 && "$2" == --type && "$3" == image ]] || exit 2
        grep -Fxq -- "$4" "$SPECDOC_TEST_IMAGES"
        ;;
    build)
        shift
        containerfile= image= source_image=
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -f) containerfile=$2; shift 2 ;;
                -t) image=$2; shift 2 ;;
                --build-arg)
                    [[ "$2" == SRC=* ]] || exit 2
                    source_image=${2#SRC=}
                    shift 2
                    ;;
                *) shift ;;
            esac
        done
        [[ -n "$containerfile" && -n "$image" ]] || exit 2
        if [[ "$containerfile" == */Containerfile.src ]]; then
            printf 'source %s\n' "$image" >> "$SPECDOC_TEST_BUILDS"
        else
            [[ -n "$source_image" ]] || exit 2
            grep -Fxq -- "$source_image" "$SPECDOC_TEST_IMAGES"
            printf 'app %s %s\n' "$image" "$source_image" >> "$SPECDOC_TEST_BUILDS"
        fi
        printf '%s\n' "$image" >> "$SPECDOC_TEST_IMAGES"
        ;;
    tag)
        [[ $# == 3 ]] || exit 2
        grep -Fxq -- "$2" "$SPECDOC_TEST_IMAGES"
        printf '%s\n' "$3" >> "$SPECDOC_TEST_IMAGES"
        ;;
    *) exit 2 ;;
esac
BUILDER
chmod +x "$test_root/builder"
export SPECDOC_TEST_IMAGES="$test_root/images"
export SPECDOC_TEST_BUILDS="$test_root/builds"

run_build() {
    BUILDER="$test_root/builder" bash "$test_root/hack/build-editor.sh" \
        specdoc-editor:test > "$test_root/last-build.log"
}

run_build
[[ $(source_builds) == 1 ]] || fail 'first build did not create one source snapshot'
printf 'ok: first build creates a source snapshot\n'

run_build
[[ $(source_builds) == 1 ]] || fail 'unchanged inputs rebuilt the source snapshot'
printf 'ok: unchanged inputs reuse the source snapshot\n'

sed -i 's|^ARG BASE=.*|ARG BASE=docker.io/library/node:24-bookworm|' \
    "$test_root/editor/Containerfile.src"
cmp "$repo_root/editor/UPSTREAM" "$test_root/editor/UPSTREAM"
cmp "$repo_root/editor/critic.bundle" "$test_root/editor/critic.bundle"
run_build
[[ $(source_builds) == 2 ]] || fail 'changing the base image reused the old source snapshot'

first_source=$(awk '$1 == "source" { print $2; exit }' "$test_root/builds")
last_source=$(awk '$1 == "source" { image = $2 } END { print image }' "$test_root/builds")
last_app_source=$(awk '$1 == "app" { image = $3 } END { print image }' "$test_root/builds")
[[ "$first_source" != "$last_source" ]] || fail 'base image change kept the old source image name'
[[ "$last_app_source" == "$last_source" ]] || fail 'application build did not use the rebuilt source snapshot'
[[ $(awk '$1 == "app" { count++ } END { print count + 0 }' "$test_root/builds") == 3 ]] \
    || fail 'each invocation must build the application image'
printf 'ok: base image changes rebuild the source and application images\n'

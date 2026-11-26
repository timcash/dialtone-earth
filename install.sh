#!/bin/sh
# Install the dialtone-earth CLI binary without changing shell profiles or PATH.
# Keep execution at the end: a truncated `curl | sh` must not begin an install.
main() {
    set -eu
    version=${DIALTONE_EARTH_VERSION:-}
    install_dir=${DIALTONE_EARTH_INSTALL_DIR:-"$HOME/.local/bin"}
    release_base=${DIALTONE_EARTH_RELEASE_BASE_URL:-https://dialtone.earth/releases/dialtone-earth}
    source_url=${DIALTONE_EARTH_SOURCE_URL:-https://dialtone.earth/api/code/dialtone-earth/archive/main.tar.gz}
    download_dir=
    stage_dir=

    die() { printf 'dialtone-earth installer: %s\n' "$*" >&2; exit 1; }
    cleanup() {
        [ -z "$download_dir" ] || rm -rf -- "$download_dir"
        [ -z "$stage_dir" ] || rm -rf -- "$stage_dir"
    }
    trap cleanup 0
    trap 'exit 1' 1 2 15

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --version|--install-dir)
                [ "$#" -ge 2 ] || die "$1 needs a value"
                case "$1" in
                    --version) version=$2 ;;
                    --install-dir) install_dir=$2 ;;
                esac
                shift 2 ;;
            -h|--help)
                printf '%s\n' \
                    'Usage: sh install.sh [--version vX.Y.Z] [--install-dir DIR]' \
                    '' \
                    'Without --version, downloads the main source archive and builds with Go.' \
                    'With --version vX.Y.Z, downloads and SHA-256-verifies the release binary.'
                return ;;
            *) die "unknown option: $1" ;;
        esac
    done

    [ -n "$install_dir" ] || die 'install directory is empty'
    case "$install_dir" in /*) ;; *) install_dir="$PWD/$install_dir" ;; esac
    command -v curl >/dev/null 2>&1 || die 'curl is required'

    validate_url() {
        case "$1" in
            https://*) protocols='=https'; redirect_limit=5 ;;
            http://127.0.0.1:*)
                printf '%s\n' "$1" | LC_ALL=C grep -Eq '^http://127\.0\.0\.1:[0-9]+(/[^?#]*)?$' || die 'invalid loopback URL'
                protocols='=http'; redirect_limit=0 ;;
            *) die 'download URL must use HTTPS (or loopback HTTP for tests)' ;;
        esac
    }

    download_dir=$(mktemp -d "${TMPDIR:-/tmp}/dialtone-earth-install.XXXXXXXX")
    built_binary="$download_dir/dialtone-earth"

    if [ -n "$version" ]; then
        case "$version" in *[!A-Za-z0-9.-]*) die 'version must be a tag such as v0.1.0' ;; esac
        printf '%s\n' "$version" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$' || die 'version must be a tag such as v0.1.0'

        release_base=${release_base%/}
        validate_url "$release_base"

        os=$(uname -s)
        arch=$(uname -m)
        if [ "$os" = Darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then
            arch=arm64
        fi
        case "$os/$arch" in
            Linux/x86_64|Linux/amd64) asset=dialtone-earth-linux-amd64 ;;
            Linux/aarch64|Linux/arm64) asset=dialtone-earth-linux-arm64 ;;
            Darwin/x86_64|Darwin/amd64) asset=dialtone-earth-darwin-amd64 ;;
            Darwin/arm64|Darwin/aarch64) asset=dialtone-earth-darwin-arm64 ;;
            *) die "unsupported platform: $os/$arch" ;;
        esac
        if command -v sha256sum >/dev/null 2>&1; then
            hash_tool=sha256sum
        elif command -v shasum >/dev/null 2>&1; then
            hash_tool=shasum
        else
            die 'sha256sum or shasum is required'
        fi

        url="$release_base/download/$version/$asset"
        curl --fail --silent --show-error --location --max-redirs "$redirect_limit" --proto "$protocols" --proto-redir "$protocols" --connect-timeout 15 --max-time 300 "$url" -o "$built_binary"
        curl --fail --silent --show-error --location --max-redirs "$redirect_limit" --proto "$protocols" --proto-redir "$protocols" --connect-timeout 15 --max-time 60 "$url.sha256" -o "$download_dir/checksum"

        [ "$(wc -c < "$download_dir/checksum" | tr -d ' ')" = "$((67 + ${#asset}))" ] || die 'invalid checksum record'
        [ "$(wc -l < "$download_dir/checksum" | tr -d ' ')" = 1 ] || die 'invalid checksum record'
        LC_ALL=C grep -Eq "^[0-9a-fA-F]{64}  $asset$" "$download_dir/checksum" || die 'invalid checksum record'
        expected=$(cut -c 1-64 "$download_dir/checksum" | tr 'A-F' 'a-f')
        if [ "$hash_tool" = sha256sum ]; then
            actual=$(sha256sum < "$built_binary")
        else
            actual=$(shasum -a 256 < "$built_binary")
        fi
        actual=${actual%% *}
        [ "$actual" = "$expected" ] || die 'SHA-256 mismatch; previous install preserved'
        label="$version"
    else
        command -v go >/dev/null 2>&1 || die 'go 1.24+ is required for source installs (or pass --version vX.Y.Z for a release binary)'
        command -v tar >/dev/null 2>&1 || die 'tar is required for source installs'
        validate_url "$source_url"

        archive="$download_dir/source.tar.gz"
        curl --fail --silent --show-error --location --max-redirs "$redirect_limit" --proto "$protocols" --proto-redir "$protocols" --connect-timeout 15 --max-time 300 "$source_url" -o "$archive"
        mkdir -p -- "$download_dir/src"
        tar -xzf "$archive" -C "$download_dir/src"
        src_dir=$(find "$download_dir/src" -maxdepth 2 -name go.mod -print | head -n 1)
        [ -n "$src_dir" ] || die 'source archive does not contain go.mod'
        src_dir=$(dirname -- "$src_dir")
        (cd "$src_dir" && go build -o "$built_binary" .)
        label='main (built from source)'
    fi

    [ -s "$built_binary" ] || die 'empty binary'

    mkdir -p -- "$install_dir"
    [ ! -d "$install_dir/dialtone-earth" ] || die 'destination is a directory'
    stage_dir=$(mktemp -d "$install_dir/.dialtone-earth-install.XXXXXXXX")
    cp -- "$built_binary" "$stage_dir/dialtone-earth"
    chmod 755 "$stage_dir/dialtone-earth"
    mv -f -- "$stage_dir/dialtone-earth" "$install_dir/dialtone-earth"
    printf 'Installed dialtone-earth (%s) to %s\n' "$label" "$install_dir/dialtone-earth"
    printf '%s\n' "Add $install_dir to your PATH, or run $install_dir/dialtone-earth help"
}

main "$@"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || {
    echo 'Run with sudo.' >&2
    exit 1
}
root=/srv/openfront
repo=$root/repository
mkdir -p "$root/releases" "$root/backups"
exec 9> "$root/deploy.lock"
flock -n 9 || {
    echo 'A deployment is already running.' >&2
    exit 1
}
[[ -f "$root/.env" && $(stat -c '%u:%a' "$root/.env") == 0:600 ]] || {
    echo 'Root-owned .env mode 0600 required.' >&2
    exit 1
}
[[ -d "$repo/.git" ]] || git clone --filter=blob:none --no-checkout https://github.com/Baptiste-Boin/OpenFrontIO.git "$repo"
git -C "$repo" fetch --no-tags origin main
sha=${1:-$(git -C "$repo" rev-parse FETCH_HEAD)}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || {
    echo 'Expected an immutable 40-character commit SHA.' >&2
    exit 1
}
git -C "$repo" cat-file -e "$sha^{commit}" 2> /dev/null || git -C "$repo" fetch --no-tags origin "$sha"
previous=$(cat "$root/current-sha" 2> /dev/null || true)
# Automatic main deployments wait until the currently deployed PR has merged.
if [[ $# == 0 && -n $previous ]]; then
    git -C "$repo" merge-base --is-ancestor "$previous" "$sha" || {
        echo 'Waiting for the deployed PR to merge into main.'
        exit 0
    }
fi
[[ $sha != "$previous" ]] || {
    echo 'Release already deployed.'
    exit 0
}
release=$root/releases/$sha
[[ -d $release ]] || git -C "$repo" worktree add --detach "$release" "$sha"
export RELEASE_SHA=$sha
compose=(docker compose --project-name openfront --env-file "$root/.env" --file "$release/deploy/vps/compose.yml")
"${compose[@]}" config --quiet
# Keep at least 3 GiB for builds and PostgreSQL; never prune Tralo images.
free=$(df -Pk "$root" | awk 'NR==2 {print $4}')
((free >= 3145728)) || {
    echo 'Insufficient free disk space (3 GiB required).' >&2
    exit 1
}
"${compose[@]}" build --pull
changed=0
rollback() {
    code=$?
    if ((changed)) && [[ -n $previous ]]; then
        echo 'Health gate failed; restoring the previous OpenFront release.' >&2
        RELEASE_SHA=$previous docker compose --project-name openfront --env-file "$root/.env" --file "$root/releases/$previous/deploy/vps/compose.yml" up -d --wait --wait-timeout 180 || true
    fi
    exit "$code"
}
trap rollback ERR
changed=1
"${compose[@]}" up -d --wait --wait-timeout 180
curl -fsS http://127.0.0.1:3300/api/health > /dev/null
curl -fsS http://127.0.0.1:3400/health | python3 -c 'import json,sys,os; x=json.load(sys.stdin); assert x["status"]=="ok" and x["release"]==os.environ["RELEASE_SHA"]'
printf '%s\n' "$previous" > "$root/previous-sha"
printf '%s\n' "$sha" > "$root/current-sha.new"
mv "$root/current-sha.new" "$root/current-sha"
ln -sfn "$release" "$root/current"
trap - ERR
printf 'OpenFront deployed from GitHub: %s\n' "$sha"

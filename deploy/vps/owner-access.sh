#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || {
    echo 'Run with sudo.' >&2
    exit 1
}
exec 9> /srv/openfront/deploy.lock
flock -n 9 || {
    echo 'A deployment is running.' >&2
    exit 1
}
python3 - << 'PY'
from pathlib import Path
import hashlib, os, secrets, shutil, time
root = Path('/srv/openfront')
env = root / '.env'
key = root / 'owner-access.key'
assert env.stat().st_uid == 0 and env.stat().st_mode & 0o777 == 0o600
values = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.startswith('#'))
if key.exists():
    assert key.stat().st_uid == 0 and key.stat().st_mode & 0o777 == 0o600
    token = key.read_text().strip()
else:
    if values.get('OWNER_ACCESS_HASH'):
        raise SystemExit('An owner hash exists; refusing to replace its key.')
    token = secrets.token_urlsafe(48)
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(token + '\n')
digest = hashlib.sha256(token.encode()).hexdigest()
if values.get('OWNER_ACCESS_HASH') and values['OWNER_ACCESS_HASH'] != digest:
    raise SystemExit('Owner key and existing hash disagree; refusing rotation.')
backup = root / 'backups' / ('env-before-owner-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
shutil.copyfile(env, backup)
os.chmod(backup, 0o600)
lines = [line for line in env.read_text().splitlines() if not line.startswith('OWNER_ACCESS_HASH=')]
lines.append('OWNER_ACCESS_HASH=' + digest)
tmp = root / '.env.owner.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f: f.write('\n'.join(lines) + '\n')
os.replace(tmp, env)
print('Owner key stored privately at /srv/openfront/owner-access.key (root 0600).')
print('Only its SHA-256 hash is passed to the platform; no key was printed.')
PY

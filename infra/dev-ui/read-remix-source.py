"""Read an archive snapshot inside a network-disabled disposable worker.

Never extract paths, follow links, run repository code or install dependencies.
"""
import json
import pathlib
import tarfile

files = []
total = 0
scanned = 0
with tarfile.open('/input/source.tgz', 'r|gz') as archive:
    for member in archive:
        scanned += 1
        total += member.size
        if scanned > 10000 or total > 64_000_000:
            raise ValueError('SOURCE_ARCHIVE_LIMIT')
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\\' in member.name:
            raise ValueError('SOURCE_PATH_INVALID')
        if not member.isfile() or member.issym() or member.islnk():
            continue
        relative = '/'.join(path.parts[1:])
        parts = pathlib.PurePosixPath(relative).parts
        if any(part.startswith('.') or part in ('node_modules', 'vendor', 'dist', 'build') for part in parts):
            continue
        if pathlib.PurePosixPath(relative).suffix not in ('.ts', '.tsx', '.js', '.jsx', '.css', '.svelte', '.vue', '.html'):
            continue
        if not relative or len(relative) > 240 or member.size > 64000 or member.size == 0:
            continue
        if len(files) >= 100:
            raise ValueError('SOURCE_FILE_COUNT_LIMIT')
        source = archive.extractfile(member)
        if source:
            try:
                content = source.read(64001).decode('utf-8')
            except UnicodeDecodeError:
                continue
            if '\x00' not in content:
                files.append({'path': relative, 'content': content})

priority = ['src/main.ts', 'src/styles.css', 'src/app.ts', 'src/App.svelte', 'src/App.tsx', 'src/App.vue', 'index.html']
files.sort(key=lambda file: (priority.index(file['path']) if file['path'] in priority else len(priority), file['path']))
selected = []
for file in files:
    if len(selected) == 8:
        break
    if len(json.dumps(selected + [file], ensure_ascii=False).encode('utf-8')) <= 96000:
        selected.append(file)
if not selected:
    raise ValueError('SOURCE_NOT_USABLE')
print(json.dumps({'files': selected}, ensure_ascii=False))

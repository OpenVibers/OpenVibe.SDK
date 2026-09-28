"""Add `await` to async service/db calls in test files converted from better-sqlite3 (openvibe-sdk/db ≥ 0.18).
Usage: python3 awaitify.py <sync-member,...> file...   (sync members: svc members that stay synchronous)"""
import re, sys

def skip_string(s, j):
    q = s[j]; j += 1
    while j < len(s):
        c = s[j]
        if c == '\\': j += 2; continue
        if q == '`' and c == '$' and j + 1 < len(s) and s[j+1] == '{':
            j = skip_braces(s, j + 1); continue
        if c == q: return j + 1
        j += 1
    return j

def skip_braces(s, j):  # s[j] == '{'
    depth = 0
    while j < len(s):
        c = s[j]
        if c in '\'"`': j = skip_string(s, j); continue
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: return j + 1
        j += 1
    return j

def call_end(s, i):  # s[i] == '(' -> index after matching ')'
    depth = 0; j = i
    while j < len(s):
        c = s[j]
        if c in '\'"`': j = skip_string(s, j); continue
        if c == '/' and s[j+1:j+2] == '/': j = s.find('\n', j); j = len(s) if j < 0 else j; continue
        if c in '([{': depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0: return j + 1
        j += 1
    return j

def transform(src, sync_members):
    out = []; i = 0; changed = 0
    pat = re.compile(r'((?:[A-Za-z_$][\w$]*\.)*(?:svc|db)\.(\w+)\(|(?:\bH\.)?\boutbox\(\s*h\w*\s*\)|(?:[A-Za-z_$][\w$]*\.)*(?:stores\.\w+|platform\.outbox)\.(\w+)\(|(?<![\w.$])(?:summarize|seedFn|seed)\()')
    while True:
        m = pat.search(src, i)
        if not m: out.append(src[i:]); break
        start = m.start()
        # not part of a longer member chain (e.g. foo.bar.svc handled by regex prefix); skip when preceded by '.'
        if start > 0 and src[start-1] in '.$':
            out.append(src[i:m.end()]); i = m.end(); continue
        before = src[:start].rstrip()
        text = m.group(0)
        if text.startswith('outbox') or text.startswith('H.outbox'):
            end = m.end()
        elif m.group(3) is not None or re.match(r'(summarize|seedFn|seed)\($', text):
            if m.group(3) in ('start', 'stop', 'counts'):
                out.append(src[i:m.end()]); i = m.end(); continue
            end = call_end(src, m.end() - 1)
        else:
            member = m.group(2)
            is_db = '.db.' in text or text.startswith('db.')
            if (not is_db and member in sync_members) or (is_db and member not in ('prepare', 'value', 'many', 'maybe', 'one', 'exec', 'query', 'tx')):
                out.append(src[i:m.end()]); i = m.end(); continue
            end = call_end(src, m.end() - 1)
            if is_db and member == 'prepare':
                # .pluck(...)? then .get/.all/.run(...)
                mm = re.match(r'\s*\.pluck\(', src[end:])
                if mm: end = call_end(src, end + mm.end() - 1)
                mm = re.match(r'\s*\.(get|all|run)\(', src[end:])
                if not mm:
                    out.append(src[i:m.end()]); i = m.end(); continue
                end = call_end(src, end + mm.end() - 1)
        if before.endswith('await') or before.endswith('await ('):
            out.append(src[i:end]); i = end; continue
        head = src[start:m.end()]
        inner, _ = transform(src[m.end():end], sync_members) if end > m.end() else ('', 0)
        expr = head + inner
        nxt = src[end:end+1]
        rep = f'(await {expr})' if nxt in ('.', '[') else f'await {expr}'
        out.append(src[i:start]); out.append(rep); i = end; changed += 1
    return ''.join(out), changed

if __name__ == '__main__':
    sync = set(sys.argv[1].split(','))
    for f in sys.argv[2:]:
        s = open(f).read()
        t, n = transform(s, sync)
        # arrows/functions that now contain await on the same line: make them async
        t = re.sub(r'(const \w+ = )\(([^)]*)\) => (?=.*\bawait\b)', r'\1async (\2) => ', t)
        if n: open(f, 'w').write(t); print(f, n)

def await_helpers(src):
    names = set(re.findall(r'(?:const|let)\s+(\w+)\s*=\s*async\b', src)) | set(re.findall(r'async function\s+(\w+)\s*\(', src))
    names -= {'main', 'run'}
    if not names: return src, 0
    pat = re.compile(r'(?<![\w.$])(' + '|'.join(sorted(names, key=len, reverse=True)) + r')\(')
    out = []; i = 0; n = 0
    while True:
        m = pat.search(src, i)
        if not m: out.append(src[i:]); break
        start = m.start()
        before = src[:start].rstrip()
        # a definition, or already awaited
        if re.search(r'(function|const|let)\s*$', before) or re.search(r'(const|let)\s+$', src[:start]) or before.endswith('await') or re.search(r'function\s+$', src[:start]):
            out.append(src[i:m.end()]); i = m.end(); continue
        end = call_end(src, m.end() - 1)
        expr = src[start:end]; nxt = src[end:end+1]
        rep = f'(await {expr})' if nxt in ('.', '[') else f'await {expr}'
        out.append(src[i:start]); out.append(rep); i = end; n += 1
    return ''.join(out), n

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--helpers':
    for f in sys.argv[2:]:
        s = open(f).read(); t, n = await_helpers(s)
        if n: open(f, 'w').write(t); print(f, n)

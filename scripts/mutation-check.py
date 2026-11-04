#!/usr/bin/env python3
"""Break one formula at a time and record whether the tests notice.

Usage: copy the repo somewhere, run npm ci there, then
    python3 scripts/mutation-check.py <copy> [per_file] [output.json]
This rewrites files under <copy>/src, so it refuses to run on a git checkout.
"""
import json, os, random, re, subprocess, sys, time
ROOT = os.path.abspath(sys.argv[1])
if os.path.exists(os.path.join(ROOT, '.git')):
    sys.exit('Refusing to run on a git checkout: use a throwaway copy.')
os.chdir(ROOT)
random.seed(7)
PER_FILE = int(sys.argv[2]) if len(sys.argv) > 2 else 12
OUTPUT = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else os.path.join(ROOT, 'mutation_results.json')
RULES = [
    (re.compile(r'(?<=[\w\)\]]) \* (?=[\w\(])'), ' / '),
    (re.compile(r'(?<=[\w\)\]]) / (?=[\w\(])'), ' * '),
    (re.compile(r'(?<=[\w\)\]]) \+ (?=[\w\(])'), ' - '),
    (re.compile(r'(?<=[\w\)\]]) - (?=[\w\(])'), ' + '),
    (re.compile(r'Math\.pow\(([^,()]+), '), r'Math.pow(\1, 1.1 * '),
    (re.compile(r'Math\.sqrt\('), r'Math.cbrt('),
    (re.compile(r'(?<![\w.])(\d+\.\d+)(?![\w.])'), lambda m: repr(float(m.group(1)) * 1.1)),
]
SKIP = re.compile(r'^\s*(\*|//|/\*|import |export \{|for \(|console\.|throw )')
files = []
for d, _, names in os.walk('src'):
    for n in names:
        if n.endswith('.js') and n != 'index.js':
            files.append(os.path.join(d, n))
files.sort()
results = []
started = time.time()
for path in files:
    source = open(path).read()
    lines = source.split('\n')
    sites = []
    for i, line in enumerate(lines):
        if SKIP.match(line) or '"' in line:
            continue
        code = line.split('//')[0]
        for r, (pattern, repl) in enumerate(RULES):
            for m in pattern.finditer(code):
                sites.append((i, r, m.start(), m.end()))
    random.shuffle(sites)
    sites = sites[:PER_FILE]
    for i, r, a, b in sites:
        pattern, repl = RULES[r]
        line = lines[i]
        m = pattern.search(line, a)
        if not m or m.start() != a:
            continue
        new = line[:a] + m.expand(repl) + line[m.end():] if isinstance(repl, str) else line[:a] + repl(m) + line[m.end():]
        if new == line:
            continue
        mutated = lines[:i] + [new] + lines[i + 1:]
        open(path, 'w').write('\n'.join(mutated))
        try:
            p = subprocess.run(['npx', 'vitest', 'run', '--bail', '1', '--exclude', 'sim/test/run.test.js'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               timeout=90, text=True)
            caught = p.returncode != 0
        except subprocess.TimeoutExpired:
            caught = True
        results.append({'file': path, 'line': i + 1, 'rule': r, 'from': line.strip()[:110], 'to': new.strip()[:110], 'caught': caught})
    open(path, 'w').write(source)
    done = [x for x in results if x['file'] == path]
    print(path, sum(x['caught'] for x in done), '/', len(done), int(time.time() - started), 's', flush=True)
    json.dump(results, open(OUTPUT, 'w'), indent=0)
total = len(results)
print('TOTAL caught', sum(x['caught'] for x in results), 'of', total, flush=True)

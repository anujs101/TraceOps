"""Comparison rows: pass rate per scenario, refused log calls, bare-number violations. Args: label=dir,dir,... per round."""
import json, sys

R = '/Users/anujs101/Developer/2027/TraceOps/docs/runs/'
LOG = {'log_volume', 'log_patterns', 'search_logs'}

def stats(dirs):
    per = {}; refused_log = 0; bare = 0; refused_metric = 0
    for d in dirs:
        s = json.load(open(R + d + '/summary.json'))
        sc = s['scenario']; p = per.setdefault(sc, [0, 0])
        if not s.get('incident'): continue
        valid = s['validity_gate']['scenarioValid']['valid']
        if valid:
            p[1] += 1
            if s['grade']['outcome'] == 'correct': p[0] += 1
        ev = json.load(open(R + d + '/evidence.json'))
        refused_log += sum(1 for e in ev if e['tool'] in LOG and e['status'] == 'budget_exhausted')
        refused_metric += sum(1 for e in ev if e['tool'] == 'query_metric' and e['status'] == 'budget_exhausted')
        bare += sum(1 for v in s['report']['violations'] if v['message'].startswith('unbound quantity'))
    return per, refused_log, refused_metric, bare

print('| round | S1 pass | S2 pass | refused log calls (all runs) | refused metric calls | bare-number violations (final reports) |')
print('|---|---|---|---|---|---|')
for arg in sys.argv[1:]:
    label, dirs = arg.split('=', 1)
    per, rl, rm, b = stats(dirs.split(','))
    f = lambda sc: f"{per.get(sc, [0, 0])[0]}/{per.get(sc, [0, 0])[1]}"
    print(f'| {label} | {f("S1")} | {f("S2")} | {rl} | {rm} | {b} |')

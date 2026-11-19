"""Build the raw EVAL.md table from docs/runs/<dir>/summary.json for the given run dirs."""
import json, sys
from collections import Counter

R = '/Users/anujs101/Developer/2027/TraceOps/docs/runs/'
rows, per = [], {}
for d in sys.argv[1:]:
    s = json.load(open(R + d + '/summary.json'))
    sc = s['scenario']; v = s['validity_gate']['scenarioValid']
    per.setdefault(sc, {'runs': 0, 'valid': 0, 'correct': 0})
    per[sc]['runs'] += 1
    if not s.get('incident'):
        rows.append(f"| `{d}` | {sc} | {'yes' if v['valid'] else 'no: ' + '; '.join(v['reasons'])} | – | – | – | – | not graded (no incident) | – | – |")
        continue
    if v['valid']: per[sc]['valid'] += 1
    rep = s['report']; top = rep['top_hypothesis'] or {}
    viol = Counter(x['rule'] for x in rep['violations'])
    vtxt = rep['validation'] + (' (' + ', '.join(f'{n}×{k}' for k, n in sorted(viol.items())) + ')' if viol else '')
    g = s['grade']
    if v['valid'] and g['outcome'] == 'correct': per[sc]['correct'] += 1
    grade = g['outcome'] if v['valid'] else 'not graded (invalid run)'
    ifp = g['if_validation_had_passed']['outcome']
    mt = s['evidence']['by_tool_and_status'].get('query_metric', {})
    rows.append(f"| `{d}` | {sc} | {'yes' if v['valid'] else 'no: ' + '; '.join(v['reasons'])} | {'yes' if s['baseline_window']['covered'] else 'no'} | {top.get('category','–')} | {top.get('confidence','–')} | {vtxt} | {grade} | {ifp} | {s['llm_calls']['total_tokens']:,} | {mt.get('ok',0)} ok / {mt.get('budget_exhausted',0)} refused |")
print('| run | scenario | valid | baseline covered | top hypothesis | confidence | validation | grade | grade if validation had passed | tokens | query_metric |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
print('\n'.join(rows))
print()
for sc, p in per.items():
    print(f"- **{sc}:** {p['correct']}/{p['valid']} valid runs graded correct ({p['runs']} runs, {p['runs'] - p['valid']} invalid)")

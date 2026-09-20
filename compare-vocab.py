import json

with open('final-noun-index.json', encoding='utf-8') as f:
    old = json.load(f)
with open('final-noun-index.json.new', encoding='utf-8') as f:
    new = json.load(f)

old_ids = {n['id'] for n in old['nouns']}
new_ids = {n['id'] for n in new['nouns']}
added = sorted(new_ids - old_ids)
removed = sorted(old_ids - new_ids)

out = []
out.append('=== META ===')
out.append('old meta: ' + json.dumps(old['meta'], ensure_ascii=False))
out.append('new meta: ' + json.dumps(new['meta'], ensure_ascii=False))
out.append('')
out.append('=== COUNTS ===')
out.append('old nouns count: %d' % len(old['nouns']))
out.append('new nouns count: %d' % len(new['nouns']))
out.append('added count: %d' % len(added))
out.append('removed count: %d' % len(removed))
out.append('')
out.append('=== ADDED (first 60) ===')
out.append(json.dumps(added[:60], ensure_ascii=False))
out.append('')
out.append('=== REMOVED (first 60) ===')
out.append(json.dumps(removed[:60], ensure_ascii=False))

result = '\n'.join(out)
print(result)
with open('vocab-diff-result.txt', 'w', encoding='utf-8') as f:
    f.write(result)

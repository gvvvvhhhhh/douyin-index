# -*- coding: utf-8 -*-
"""对账：标签筛选旧 8-LIKE 与新 2-instr 匹配行数必须完全一致。只读。"""
import os
import sqlite3

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"
like8 = "(w.topics LIKE ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics = ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics = ?)"
instr2 = "(instr(lower(' '||w.topics||' '), ?) > 0 OR instr(lower(' '||w.topics||' '), ?) > 0)"

tags = [
    r[0]
    for r in cur.execute(
        "SELECT tag FROM tag_counts WHERE is_hidden=0 AND length(tag) BETWEEN 2 AND 12 ORDER BY RANDOM() LIMIT 300"
    ).fetchall()
]
# 附带易误命中的前缀样例
for t in ("cos", "cosplay", "穿搭", "日常"):
    if t not in tags:
        tags.append(t)

bad = 0
for tag in tags:
    p8 = ("% #" + tag + " %", "#" + tag + " %", "% #" + tag, "#" + tag, "% " + tag + " %", tag + " %", "% " + tag, tag)
    p2 = (" #" + tag.lower() + " ", " " + tag.lower() + " ")
    a = cur.execute("SELECT COUNT(*) FROM works w WHERE %s AND %s" % (EXISTS, like8), p8).fetchone()[0]
    b = cur.execute("SELECT COUNT(*) FROM works w WHERE %s AND %s" % (EXISTS, instr2), p2).fetchone()[0]
    if a != b:
        bad += 1
        print("MISMATCH tag=%r like=%d instr=%d" % (tag, a, b))

print("checked %d tags, mismatches: %d" % (len(tags), bad))
conn.close()

# -*- coding: utf-8 -*-
"""测量侧边栏筛选（作者/标签）的 COUNT 与行查询耗时，定位点击卡顿瓶颈。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")

conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

uid = cur.execute("SELECT uid FROM authors LIMIT 1").fetchone()[0]
top_tag = cur.execute(
    "SELECT tag, count FROM tag_counts WHERE is_hidden=0 ORDER BY count DESC LIMIT 1"
).fetchone()
# 低频标签（长尾，最难扫）
rare_tag = cur.execute(
    "SELECT tag, count FROM tag_counts WHERE is_hidden=0 AND count=1 ORDER BY tag LIMIT 1"
).fetchone()
print("sample uid:", uid, "| top tag:", top_tag, "| rare tag:", rare_tag)


def t(label, sql, params=()):
    t0 = time.time()
    r = cur.execute(sql, params).fetchone()
    print("%-28s %6.2fs  %s" % (label, time.time() - t0, r))


EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"
AUTHOR = "EXISTS (SELECT 1 FROM authors a WHERE a.id = w.author_id AND a.uid IN (?))"

# 1. 作者筛选 COUNT（现行实现）
t("author COUNT", "SELECT COUNT(*) FROM works w WHERE %s AND %s" % (EXISTS, AUTHOR), (uid,))

# 2. 标签筛选 COUNT（现行 8 LIKE）
like8 = "(w.topics LIKE ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics = ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics LIKE ? OR w.topics = ?)"
p8 = ("% #x %", "#x %", "% #x", "#x", "% x %", "x %", "% x", "x")
t("tag(hi) COUNT 8-LIKE", "SELECT COUNT(*) FROM works w WHERE %s AND %s" % (EXISTS, like8), p8)

# 3. 标签筛选 COUNT（2 instr + 空格填充）
instr2 = "(instr(' '||w.topics||' ', ?) > 0 OR instr(' '||w.topics||' ', ?) > 0)"
t("tag(hi) COUNT 2-instr", "SELECT COUNT(*) FROM works w WHERE %s AND %s" % (EXISTS, instr2), (" #x ", " x "))

# 4. 行查询 LIMIT 100（作者）
t(
    "author rows LIMIT100",
    "SELECT COUNT(*) FROM (SELECT w.id FROM works w WHERE %s AND %s ORDER BY w.publish_time DESC LIMIT 100)"
    % (EXISTS, AUTHOR),
    (uid,),
)

# 5. 行查询 LIMIT 100（高频标签 8 LIKE）
t(
    "tag(hi) rows LIMIT100",
    "SELECT COUNT(*) FROM (SELECT w.id FROM works w WHERE %s AND %s ORDER BY w.publish_time DESC LIMIT 100)"
    % (EXISTS, like8),
    p8,
)

# 6. 行查询 LIMIT 100（低频标签 8 LIKE → 全索引扫完）
t(
    "tag(lo) rows LIMIT100",
    "SELECT COUNT(*) FROM (SELECT w.id FROM works w WHERE %s AND %s ORDER BY w.publish_time DESC LIMIT 100)"
    % (EXISTS, like8),
    p8,
)

conn.close()

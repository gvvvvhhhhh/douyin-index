# -*- coding: utf-8 -*-
"""验证 author_id IN (...) 索引路径 vs 全表扫描的耗时差异。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"

# 小作者（21 作品）与大作者（收藏类，几十万作品）
small = cur.execute(
    """SELECT a.id, a.name, (SELECT COUNT(*) FROM works w WHERE w.author_id = a.id) c
       FROM authors a ORDER BY c ASC LIMIT 1"""
).fetchone()
big = cur.execute(
    """SELECT a.id, a.name, (SELECT COUNT(*) FROM works w WHERE w.author_id = a.id) c
       FROM authors a ORDER BY c DESC LIMIT 1"""
).fetchone()
print("small author: %s (%d works) | big author: %s (%d works)" % (small[1], small[2], big[1], big[2]))


def t(label, sql, params=()):
    t0 = time.time()
    r = cur.execute(sql, params).fetchone()
    print("%-40s %7.3fs  %s" % (label, time.time() - t0, r))


for label, aid in (("small", small[0]), ("big", big[0])):
    cond = "w.author_id IN (%d) AND %s" % (aid, EXISTS)
    t(
        "[%s] COUNT (planner)" % label,
        "SELECT COUNT(*) FROM works w WHERE %s" % cond,
    )
    t(
        "[%s] rows L100 (planner)" % label,
        "SELECT COUNT(*) FROM (SELECT 1 FROM works w WHERE %s ORDER BY publish_time DESC LIMIT 100)" % cond,
    )
    t(
        "[%s] rows L100 (NOT INDEXED)" % label,
        "SELECT COUNT(*) FROM (SELECT 1 FROM works w NOT INDEXED WHERE %s ORDER BY publish_time DESC LIMIT 100)" % cond,
    )

conn.close()

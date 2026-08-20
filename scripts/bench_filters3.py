# -*- coding: utf-8 -*-
"""最终验证：NOT INDEXED + lower(instr) 组合的行查询耗时。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"
AUTHOR = "EXISTS (SELECT 1 FROM authors a WHERE a.id = w.author_id AND a.uid IN (?))"
instr2 = "(instr(lower(' '||w.topics||' '), ?) > 0 OR instr(lower(' '||w.topics||' '), ?) > 0)"
uid = cur.execute("SELECT uid FROM authors LIMIT 1").fetchone()[0]


def t(label, sql, params=()):
    t0 = time.time()
    r = cur.execute(sql, params).fetchone()
    print("%-26s %6.2fs  %s" % (label, time.time() - t0, r))


t(
    "[full] author rows L100",
    "SELECT COUNT(*) FROM (SELECT 1 FROM works w NOT INDEXED WHERE %s AND %s ORDER BY publish_time DESC LIMIT 100)" % (EXISTS, AUTHOR),
    (uid,),
)
t(
    "[full] tag cos rows L100",
    "SELECT COUNT(*) FROM (SELECT 1 FROM works w NOT INDEXED WHERE %s AND %s ORDER BY publish_time DESC LIMIT 100)" % (EXISTS, instr2),
    (" #cos ", " cos "),
)
t(
    "[full] COUNT author",
    "SELECT COUNT(*) FROM works w NOT INDEXED WHERE %s AND %s" % (EXISTS, AUTHOR),
    (uid,),
)
conn.close()

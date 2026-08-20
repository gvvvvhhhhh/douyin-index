# -*- coding: utf-8 -*-
"""对比：索引走查（现行）vs 全表扫描+排序（NOT INDEXED）在不同筛选密度下的表现。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

uid = cur.execute("SELECT uid FROM authors LIMIT 1").fetchone()[0]
# 高频标签 cos（17.8万作品）与低频标签
hi_tag = cur.execute("SELECT tag FROM tag_counts WHERE is_hidden=0 ORDER BY count DESC LIMIT 1").fetchone()[0]
lo_tag = cur.execute("SELECT tag FROM tag_counts WHERE is_hidden=0 AND count=1 AND length(tag)>2 ORDER BY tag LIMIT 1").fetchone()[0]
print("uid:", uid, "| hi:", hi_tag, "| lo:", lo_tag)


def t(label, sql, params=()):
    t0 = time.time()
    r = cur.execute(sql, params).fetchone()
    print("%-34s %6.2fs  rows=%s" % (label, time.time() - t0, r[0] if r else None))


EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"
AUTHOR = "EXISTS (SELECT 1 FROM authors a WHERE a.id = w.author_id AND a.uid IN (?))"
instr2 = "(instr(' '||w.topics||' ', ?) > 0 OR instr(' '||w.topics||' ', ?) > 0)"

for name, cond, params in [
    ("author(21 works)", AUTHOR, (uid,)),
    ("hi-tag cos(178k)", instr2, (" #" + hi_tag + " ", " " + hi_tag + " ")),
    ("lo-tag rare(1)", instr2, (" #" + lo_tag + " ", " " + lo_tag + " ")),
]:
    # 现行计划：ORDER BY 走索引
    t(
        "[index] %s" % name,
        "SELECT COUNT(*) FROM (SELECT 1 FROM works w WHERE %s AND %s ORDER BY w.publish_time DESC LIMIT 100)"
        % (EXISTS, cond),
        params,
    )
    # NOT INDEXED 全表扫描 + 排序
    t(
        "[full ] %s" % name,
        "SELECT COUNT(*) FROM (SELECT 1 FROM works w NOT INDEXED WHERE %s AND %s ORDER BY publish_time DESC LIMIT 100)"
        % (EXISTS, cond),
        params,
    )

# 无筛选（全部作品首页）
t(
    "[index] no-filter",
    "SELECT COUNT(*) FROM (SELECT 1 FROM works w WHERE %s ORDER BY w.publish_time DESC LIMIT 100)" % EXISTS,
)
t(
    "[full ] no-filter",
    "SELECT COUNT(*) FROM (SELECT 1 FROM works w NOT INDEXED WHERE %s ORDER BY publish_time DESC LIMIT 100)" % EXISTS,
)

conn.close()

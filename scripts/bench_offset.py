# -*- coding: utf-8 -*-
"""测量无筛选路径深翻页（OFFSET 增长）耗时。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()
EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"

for off in (1000, 10000, 50000, 100000, 300000):
    t0 = time.time()
    cur.execute(
        "SELECT w.id FROM works w WHERE %s ORDER BY w.publish_time DESC NULLS LAST LIMIT 100 OFFSET %d"
        % (EXISTS, off)
    ).fetchall()
    print("OFFSET %-7d %.3fs" % (off, time.time() - t0))

conn.close()
